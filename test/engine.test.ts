import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ALARM_BUDGET_MS,
	JobEngine,
	MAX_ATTEMPTS,
	READY_BUDGET_MS,
	RETENTION_MS,
	RETRY_DELAY_MS,
	CLEANUP_RETRY_MS,
	CLEANUP_GIVE_UP_MS,
	MAX_JOB_AGE_MS,
	MIN_CONTAINER_BUDGET_MS,
	UPLOAD_RESERVE_MS,
	type FileStore,
	type JobBox,
	type JobStore,
	type StoredFileOptions,
} from "../src/engine";
import type { JobRecord } from "../src/job";

const ID = "11111111-1111-4111-8111-111111111111";
const T0 = 1_800_000_000_000;

// ---------- fakes ----------

class FakeClock {
	t = T0;
	now = () => this.t;
	sleep = async (ms: number) => {
		this.t += ms;
	};
}

class FakeStore implements JobStore {
	job: JobRecord | null = null;
	alarmAt: number | null = null;
	commits = 0;
	failCommitWhen: ((job: JobRecord) => boolean) | null = null;
	async load() {
		return this.job ? structuredClone(this.job) : null;
	}
	async commit(job: JobRecord, alarmAt: number) {
		if (this.failCommitWhen?.(job)) throw new Error("storage indisponivel");
		this.commits++;
		this.job = structuredClone(job);
		this.alarmAt = alarmAt;
	}
	async clear() {
		this.job = null;
		this.alarmAt = null;
	}
	async armIfIdle(alarmAt: number) {
		if (this.job && this.alarmAt === null) this.alarmAt = alarmAt;
		return this.job ? structuredClone(this.job) : null;
	}
}

type DownloadPlan =
	| {
			kind: "ok";
			declared: number;
			send: number;
			title?: string;
			chunkDelayMs?: number;
			warning?: string;
			sourceCodec?: string;
			size?: string;
	  }
	| { kind: "status"; status: number; body: string }
	| { kind: "throw"; error: string }
	| { kind: "hang" };

class FakeBox implements JobBox {
	started = 0;
	destroyed = 0;
	healthPlan: ("ok" | "timeout" | "refused")[] = [];
	downloads: DownloadPlan[] = [];
	downloadCalls: { at: number; body: string }[] = [];
	sourceCancelled = false;
	startError: string | null = null;
	destroyError = false;
	constructor(private clock: FakeClock) {}
	async ensureStarted() {
		this.started++;
		if (this.startError) throw new Error(this.startError);
	}
	async destroy() {
		this.destroyed++;
		if (this.destroyError) throw new Error("destroy falhou");
	}
	async fetch(path: string, init?: RequestInit): Promise<Response> {
		if (path === "/health") {
			const step = this.healthPlan.length ? this.healthPlan.shift()! : "ok";
			if (step === "timeout") {
				this.clock.t += 1000;
				throw new Error("timeout");
			}
			if (step === "refused") throw new Error("connection refused");
			return new Response("{}", { status: 200 });
		}
		this.downloadCalls.push({ at: this.clock.t, body: String(init?.body) });
		const plan = this.downloads.shift() ?? { kind: "ok", declared: 8, send: 8 };
		if (plan.kind === "throw") throw new Error(plan.error);
		if (plan.kind === "hang") {
			// container que nao responde (download longo, live): so o sinal de prazo encerra
			return new Promise<Response>((_, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		if (plan.kind === "status") return new Response(plan.body, { status: plan.status });
		let sent = 0;
		const box = this;
		const stream = new ReadableStream<Uint8Array>({
			async pull(ctrl) {
				if (plan.chunkDelayMs) await new Promise((r) => setTimeout(r, plan.chunkDelayMs));
				if (sent >= plan.send) {
					ctrl.close();
					return;
				}
				const n = Math.min(4, plan.send - sent);
				sent += n;
				ctrl.enqueue(new Uint8Array(n).fill(120));
			},
			cancel() {
				box.sourceCancelled = true;
			},
		});
		return new Response(stream, {
			status: 200,
			headers: {
				"content-length": String(plan.declared),
				"x-title": encodeURIComponent(plan.title ?? "Me at the zoo"),
				"x-ext": "mp4",
				...(plan.warning ? { "x-warning": encodeURIComponent(plan.warning) } : {}),
				...(plan.sourceCodec ? { "x-source-codec": plan.sourceCodec } : {}),
				...(plan.size ? { "x-video-size": plan.size } : {}),
			},
		});
	}
}

class FakeFiles implements FileStore {
	objects = new Map<string, { bytes: number; options: StoredFileOptions }>();
	deletes: string[] = [];
	failPut: "never" | "immediately" | "after-partial" | "hold-lock" | "hang-after-consume" | "late" = "never";
	private lateRelease: (() => void) | null = null;
	/** Conclui o put "late": o R2 recebeu tudo e confirma depois do prazo do alarm. */
	releaseLate() {
		this.lateRelease?.();
	}
	failDeletes = 0;
	failHeads = 0;
	async put(key: string, body: ReadableStream<Uint8Array>, options: StoredFileOptions) {
		if (this.failPut === "immediately") throw new Error("R2 indisponivel");
		let bytes = 0;
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (this.failPut === "hold-lock" && bytes >= 4) {
				// consumidor valido que desiste sem cancelar nem liberar o reader; a espera deixa o
				// produtor com a proxima escrita em andamento, presa por contrapressao
				await new Promise((r) => setTimeout(r, 20));
				throw new Error("R2 caiu segurando o reader");
			}
			if (this.failPut === "after-partial" && bytes >= 8) {
				await reader.cancel(new Error("R2 caiu no meio"));
				throw new Error("R2 caiu no meio");
			}
		}
		if (this.failPut === "hang-after-consume") await new Promise(() => {});
		if (this.failPut === "late") await new Promise<void>((r) => (this.lateRelease = r));
		// put atomico: o objeto so passa a existir completo
		this.objects.set(key, { bytes, options });
	}
	async head(key: string) {
		if (this.failHeads > 0) {
			this.failHeads--;
			throw new Error("R2 indisponivel no head");
		}
		const obj = this.objects.get(key);
		return obj ? { size: obj.bytes, customMetadata: obj.options.customMetadata } : null;
	}
	async delete(key: string) {
		if (this.failDeletes > 0) {
			this.failDeletes--;
			throw new Error("R2 indisponivel na limpeza");
		}
		this.deletes.push(key);
		this.objects.delete(key);
	}
}

// Emula o FixedLengthStream do workerd: erra ao exceder ou ao fechar antes do tamanho declarado.
function fakeSized(bytes: number) {
	let seen = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, ctrl) {
			seen += chunk.byteLength;
			if (seen > bytes) throw new Error("Attempt to write too many bytes through a FixedLengthStream");
			ctrl.enqueue(chunk);
		},
		flush() {
			if (seen < bytes) throw new Error("FixedLengthStream did not see all expected bytes");
		},
	});
}

// Emulacao estrita do IdentityTransformStream/FixedLengthStream do workerd: sem buffer, cada
// escrita so conclui quando o consumidor le aquele chunk. Um consumidor que desiste segurando o
// reader deixa a escrita presa para sempre, e o abort do writable espera por ela (como no workerd).
function strictSized(bytes: number) {
	let seen = 0;
	let readCtrl!: ReadableStreamDefaultController<Uint8Array>;
	let pendingWrite: { chunk: Uint8Array; resolve: () => void; reject: (e: unknown) => void } | null = null;
	let pendingPull: (() => void) | null = null;
	const readable = new ReadableStream<Uint8Array>(
		{
			start(ctrl) {
				readCtrl = ctrl;
			},
			pull() {
				return new Promise<void>((resolve) => {
					const deliver = () => {
						const w = pendingWrite!;
						pendingWrite = null;
						readCtrl.enqueue(w.chunk);
						w.resolve();
						resolve();
					};
					if (pendingWrite) deliver();
					else pendingPull = deliver;
				});
			},
			cancel(reason) {
				pendingWrite?.reject(reason);
				pendingWrite = null;
			},
		},
		{ highWaterMark: 0 },
	);
	const writable = new WritableStream<Uint8Array>(
		{
			write(chunk) {
				seen += chunk.byteLength;
				if (seen > bytes) {
					// como no workerd, o erro de um lado erra o par inteiro
					const error = new Error("Attempt to write too many bytes through a FixedLengthStream");
					readCtrl.error(error);
					throw error;
				}
				return new Promise<void>((resolve, reject) => {
					pendingWrite = { chunk, resolve, reject };
					if (pendingPull) {
						const p = pendingPull;
						pendingPull = null;
						p();
					}
				});
			},
			close() {
				if (seen < bytes) {
					const error = new Error("FixedLengthStream did not see all expected bytes");
					readCtrl.error(error);
					throw error;
				}
				readCtrl.close();
			},
			abort(reason) {
				readCtrl.error(reason);
			},
		},
		{ highWaterMark: 1 },
	);
	return { readable, writable };
}

function newJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		id: ID,
		platform: "youtube",
		videoId: "jNQXAC9IVRw",
		url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
		status: "queued",
		attempts: 0,
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

function setup(makeSized: (bytes: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } = fakeSized) {
	const clock = new FakeClock();
	const store = new FakeStore();
	const box = new FakeBox(clock);
	const files = new FakeFiles();
	const timeouts: number[] = [];
	const controllers: AbortController[] = [];
	const engine = new JobEngine({
		store,
		box,
		files,
		clock,
		makeSized,
		timeoutSignal: (ms) => {
			timeouts.push(ms);
			const c = new AbortController();
			controllers.push(c);
			return c.signal;
		},
	});
	const expireAll = () => controllers.forEach((c) => c.abort(new DOMException("timeout", "TimeoutError")));
	return { clock, store, box, files, engine, timeouts, expireAll };
}

// ---------- rejeicoes nao observadas viram falha de teste ----------

type Proc = { on(event: string, fn: (reason: unknown) => void): void; off(event: string, fn: (reason: unknown) => void): void };
const proc = (globalThis as unknown as { process: Proc }).process;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
	unhandled.length = 0;
	proc.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 30));
	proc.off("unhandledRejection", onUnhandled);
	expect(unhandled).toEqual([]);
});

// ---------- testes ----------

describe("create", () => {
	it("grava o job e agenda o alarm para agora; e idempotente", async () => {
		const { engine, store } = setup();
		await engine.create(newJob());
		expect(store.alarmAt).toBe(T0);
		const again = await engine.create(newJob({ url: "outra" }));
		expect(again.url).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw");
		expect(store.commits).toBe(1);
	});
});

describe("caminho feliz", () => {
	it("baixa, grava no R2 com metadados, agenda retencao e destroi o container", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "ok", declared: 10, send: 10, title: "Ação/1" });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 1, bytes: 10, title: "Ação/1", ext: "mp4" });
		expect(store.job!.error).toBeUndefined();
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETENTION_MS);
		const obj = files.objects.get(`files/${ID}`)!;
		expect(obj.bytes).toBe(10);
		expect(obj.options.contentType).toBe("video/mp4");
		expect(obj.options.contentDisposition).toContain("filename*=UTF-8''A%C3%A7%C3%A3o%201.mp4");
		expect(obj.options.customMetadata).toMatchObject({ title: "Ação/1", ext: "mp4", platform: "youtube" });
		expect(JSON.parse(box.downloadCalls[0].body)).toEqual({
			url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
			platform: "youtube",
			budget_ms: ALARM_BUDGET_MS - UPLOAD_RESERVE_MS,
		});
		expect(store.job!.warning).toBeUndefined();
		expect(obj.options.customMetadata.warning).toBeUndefined();
		expect(box.destroyed).toBe(1);
	});

	it("aviso do container (arquivo nao saiu H.264) vai para o job e para o customMetadata do R2", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		const warning = "Video em VP9: nao deu tempo de converter para H.264. Pode nao abrir no QuickTime.";
		box.downloads.push({ kind: "ok", declared: 8, send: 8, warning });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", warning });
		expect(files.objects.get(`files/${ID}`)!.options.customMetadata.warning).toBe(warning);
	});

	it("prazo do container desconta a reserva do upload e nunca fica abaixo do minimo", async () => {
		const { engine, box, clock } = setup();
		await engine.create(newJob());
		const realFetch = box.fetch.bind(box);
		// health demora quase todo o orcamento: sobra menos que a reserva do upload
		box.fetch = async (path: string, init?: RequestInit) => {
			if (path === "/health") clock.t = T0 + ALARM_BUDGET_MS - UPLOAD_RESERVE_MS / 2;
			return realFetch(path, init);
		};
		await engine.onAlarm();
		expect(JSON.parse(box.downloadCalls[0].body).budget_ms).toBe(MIN_CONTAINER_BUDGET_MS);
	});
});

describe("metadados da entrega (follow-up #5)", () => {
	it("codec de origem e tamanho vao para o job e para o customMetadata do R2", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "ok", declared: 8, send: 8, sourceCodec: "vp9", size: "1280x720" });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", sourceCodec: "vp9", width: 1280, height: 720 });
		expect(files.objects.get(`files/${ID}`)!.options.customMetadata).toMatchObject({ sourceCodec: "vp9", size: "1280x720" });
	});

	it("customMetadata cabe no orcamento de 2048 bytes com titulo e aviso enormes; o job guarda o titulo inteiro", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		const title = "😀".repeat(300);
		box.downloads.push({ kind: "ok", declared: 8, send: 8, title, warning: "😀".repeat(200), sourceCodec: "vp9", size: "1080x1920" });
		await engine.onAlarm();
		const meta = files.objects.get(`files/${ID}`)!.options.customMetadata;
		const enc = new TextEncoder();
		const total = Object.entries(meta).reduce((n, [k, v]) => n + enc.encode(k).length + enc.encode(v).length, 0);
		expect(total).toBeLessThanOrEqual(2048);
		expect(meta).toMatchObject({ ext: "mp4", sourceCodec: "vp9", size: "1080x1920" });
		expect(store.job!.title).toBe(title);
	});

	it("sem os headers, o job nao ganha campos vazios", async () => {
		const { engine, store } = setup();
		await engine.create(newJob());
		await engine.onAlarm();
		expect(Object.keys(store.job!)).not.toContain("sourceCodec");
		expect(Object.keys(store.job!)).not.toContain("width");
	});

	it("a reconciliacao pelo R2 recupera codec de origem e tamanho", async () => {
		const { engine, store, files } = setup();
		await files.put(`files/${ID}`, new Blob(["123"]).stream(), {
			contentType: "video/mp4",
			contentDisposition: "attachment",
			customMetadata: { title: "R", ext: "mp4", sourceCodec: "vp9", size: "1920x1080" },
		});
		store.job = newJob({ status: "running", attempts: 1 });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", sourceCodec: "vp9", width: 1920, height: 1080 });
	});
});

describe("falhas terminais e transitorias", () => {
	it("422 do container e terminal: failed com a mensagem real, sem retentativa", async () => {
		const { engine, store, files, box } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "status", status: 422, body: JSON.stringify({ error: "Video unavailable" }) });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed", error: "Video unavailable", attempts: 1 });
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETENTION_MS);
		expect(files.objects.size).toBe(0);
		expect(box.destroyed).toBe(1);
	});

	it("500 do container e transitorio: volta para a fila com backoff e depois conclui", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "status", status: 503, body: "upstream" });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "queued", attempts: 1, error: "HTTP 503: upstream" });
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETRY_DELAY_MS);
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 2 });
		expect(store.job!.error).toBeUndefined();
	});

	it.each([
		["falha ao subir o container", (b: FakeBox) => (b.startError = "sem capacidade")],
		["fetch do download lanca (rede/abort)", (b: FakeBox) => b.downloads.push({ kind: "throw", error: "network lost" })],
	])("%s e transitorio", async (_label, arrange) => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		arrange(box);
		await engine.onAlarm();
		expect(store.job!.status).toBe("queued");
		expect(box.destroyed).toBe(1);
	});

	it("estouro do prazo esperando o container (video longo, live) e terminal: uma tentativa so", async () => {
		const { engine, store, box, expireAll } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "hang" });
		const run = engine.onAlarm();
		await new Promise((r) => setTimeout(r, 10));
		expireAll();
		await run;
		expect(store.job).toMatchObject({ status: "failed", attempts: 1 });
		expect(store.job!.error).toContain("14 min");
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETENTION_MS);
		expect(box.destroyed).toBe(1);
		await engine.onAlarm();
		expect(box.downloadCalls).toHaveLength(1);
	});

	it("falha de rede no fetch do container sem estouro do prazo continua transitoria", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "throw", error: "The operation was aborted" });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "queued", attempts: 1 });
	});

	it("esgota as tentativas e falha com o ultimo erro, sem baixar de novo", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		for (let i = 0; i < MAX_ATTEMPTS; i++) box.downloads.push({ kind: "throw", error: `rede ${i}` });
		for (let i = 0; i < MAX_ATTEMPTS; i++) await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
		expect(store.job!.error).toContain(`Falhou apos ${MAX_ATTEMPTS} tentativas`);
		expect(store.job!.error).toContain(`rede ${MAX_ATTEMPTS - 1}`);
		await engine.onAlarm();
		expect(box.downloadCalls).toHaveLength(MAX_ATTEMPTS);
	});

	it("falha do R2 e transitoria e o container e destruido mesmo se destroy lancar", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		files.failPut = "immediately";
		box.destroyError = true;
		await engine.onAlarm();
		expect(store.job!.status).toBe("queued");
		expect(store.job!.error).toContain("R2 indisponivel");
		expect(box.destroyed).toBe(1);
	});
});

describe("execucao interrompida", () => {
	it("job em running (alarm anterior morreu) roda de novo e conta a tentativa", async () => {
		const { engine, store, box } = setup();
		store.job = newJob({ status: "running", attempts: 1 });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 2 });
		expect(box.downloadCalls).toHaveLength(1);
	});

	it("running com tentativas esgotadas falha sem baixar", async () => {
		const { engine, store, box } = setup();
		store.job = newJob({ status: "running", attempts: MAX_ATTEMPTS });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed", error: "Download interrompido repetidamente; tente de novo." });
		expect(box.downloadCalls).toHaveLength(0);
	});

	it("agenda um alarm de seguranca antes de comecar a baixar", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		let alarmDuringDownload: number | null = null;
		const original = box.fetch.bind(box);
		box.fetch = async (path, init) => {
			if (path === "/download") alarmDuringDownload = store.alarmAt;
			return original(path, init);
		};
		await engine.onAlarm();
		expect(alarmDuringDownload).toBe(T0 + ALARM_BUDGET_MS + RETRY_DELAY_MS);
	});
});

describe("gravacao no R2", () => {
	it("caminho feliz com o stream estrito sem buffer", async () => {
		const { engine, store, files } = setup(strictSized);
		await engine.create(newJob());
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", bytes: 8 });
		expect(files.objects.get(`files/${ID}`)!.bytes).toBe(8);
	});

	it.each([
		["corpo menor que o Content-Length", 10, 6, fakeSized],
		["corpo maior que o Content-Length", 6, 10, fakeSized],
		["corpo menor que o Content-Length (estrito)", 10, 6, strictSized],
		["corpo maior que o Content-Length (estrito)", 6, 10, strictSized],
	])("%s: nada fica no R2, job volta para a fila, sem rejeicao solta", async (_label, declared, send, sized) => {
		const { engine, store, box, files } = setup(sized);
		await engine.create(newJob());
		box.downloads.push({ kind: "ok", declared, send });
		await engine.onAlarm();
		expect(store.job!.status).toBe("queued");
		expect(store.job!.error).toContain("falha ao gravar no R2");
		expect(files.objects.size).toBe(0);
		expect(files.deletes).toContain(`files/${ID}`);
	});

	it("upload que falha depois de consumir parte do corpo cancela a origem e nao deixa objeto", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		files.failPut = "after-partial";
		box.downloads.push({ kind: "ok", declared: 4000, send: 4000, chunkDelayMs: 1 });
		const started = Date.now();
		await engine.onAlarm();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(box.sourceCancelled).toBe(true);
		expect(files.objects.size).toBe(0);
		expect(store.job!.status).toBe("queued");
		expect(store.job!.error).toContain("R2 caiu no meio");
	});

	it.each([
		["TransformStream", fakeSized],
		["stream estrito sem buffer (como o workerd)", strictSized],
	])("upload que desiste segurando o reader nao trava (%s): cancela a origem e volta para a fila", async (_label, sized) => {
		const { engine, store, box, files } = setup(sized);
		await engine.create(newJob());
		files.failPut = "hold-lock";
		box.downloads.push({ kind: "ok", declared: 400, send: 400 });
		const started = Date.now();
		await engine.onAlarm();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(box.sourceCancelled).toBe(true);
		expect(files.objects.size).toBe(0);
		expect(store.job).toMatchObject({ status: "queued" });
		expect(store.job!.error).toContain("R2 caiu segurando o reader");
	});

	it("upload rejeitado antes de ler o corpo aborta o pipe e cancela a origem na hora", async () => {
		const { engine, store, box, files } = setup();
		await engine.create(newJob());
		files.failPut = "immediately";
		box.downloads.push({ kind: "ok", declared: 4000, send: 4000, chunkDelayMs: 5 });
		const started = Date.now();
		await engine.onAlarm();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(box.sourceCancelled).toBe(true);
		expect(store.job!.status).toBe("queued");
	});

	it("I4: upload que trava depois de consumir o corpo respeita o prazo do alarm e destroi o container", async () => {
		const { engine, store, box, files, expireAll } = setup();
		await engine.create(newJob());
		files.failPut = "hang-after-consume";
		const done = engine.onAlarm();
		await new Promise((r) => setTimeout(r, 30));
		expireAll();
		const started = Date.now();
		await done;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(box.destroyed).toBe(1);
		expect(store.job).toMatchObject({ status: "queued" });
		expect(store.job!.error).toContain("prazo");
	});

	it("put que conclui depois do prazo: a execucao seguinte reconcilia como done sem baixar de novo", async () => {
		const { engine, store, box, files, expireAll } = setup();
		await engine.create(newJob());
		files.failPut = "late";
		box.downloads.push({ kind: "ok", declared: 8, send: 8, title: "Tardio" });
		const run = engine.onAlarm();
		await new Promise((r) => setTimeout(r, 30));
		expireAll();
		await run;
		expect(store.job).toMatchObject({ status: "queued", attempts: 1 });
		expect(files.objects.size).toBe(0);
		files.releaseLate();
		await new Promise((r) => setTimeout(r, 10));
		expect(files.objects.get(`files/${ID}`)!.bytes).toBe(8);
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", bytes: 8, title: "Tardio", attempts: 1 });
		expect(box.downloadCalls).toHaveLength(1);
	});

	it("headers invalidos do container sao terminais e o corpo e cancelado", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "ok", declared: 0, send: 4 });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed" });
		expect(store.job!.error).toContain("tamanho");
		expect(box.sourceCancelled).toBe(true);
	});
});

describe("orcamento de tempo", () => {
	it("prontidao respeita prazo absoluto mesmo com health checks que esgotam o timeout", async () => {
		const { engine, store, box, clock } = setup();
		await engine.create(newJob());
		box.healthPlan = Array(1000).fill("timeout");
		await engine.onAlarm();
		expect(store.job!.status).toBe("queued");
		expect(store.job!.error).toContain("nao ficou pronto");
		expect(box.downloadCalls).toHaveLength(0);
		// 30 s de orcamento + no maximo um health check em andamento
		expect(clock.t - T0).toBeLessThanOrEqual(READY_BUDGET_MS + 1000);
	});

	it("timeout do download = tempo restante ate o prazo do alarm", async () => {
		const { engine, box, timeouts } = setup();
		await engine.create(newJob());
		box.healthPlan = ["timeout", "timeout", "refused", "ok"];
		await engine.onAlarm();
		const downloadTimeout = timeouts[timeouts.length - 1];
		const elapsedBeforeDownload = box.downloadCalls[0].at - T0;
		expect(downloadTimeout).toBe(ALARM_BUDGET_MS - elapsedBeforeDownload);
		expect(elapsedBeforeDownload + downloadTimeout).toBe(ALARM_BUDGET_MS);
		// cada health check usa no maximo o tempo restante
		expect(Math.max(...timeouts.slice(0, -1))).toBeLessThanOrEqual(1000);
	});
});

describe("retencao e limpeza", () => {
	it("estado terminal recente sem alarm (agendamento perdido) restaura a limpeza", async () => {
		const { engine, store, clock } = setup();
		store.job = newJob({ status: "failed", error: "x", updatedAt: T0 });
		store.alarmAt = null;
		clock.t = T0 + 1000;
		await engine.onAlarm();
		expect(store.alarmAt).toBe(T0 + RETENTION_MS);
		expect(store.job!.status).toBe("failed");
	});

	it.each([
		["primeira tentativa", 0],
		["ultima tentativa", MAX_ATTEMPTS - 1],
	])("falha ao gravar o estado final na %s: nao baixa de novo e conclui como done", async (_label, previousAttempts) => {
		const { engine, store, box, files } = setup();
		store.job = newJob({ attempts: previousAttempts });
		box.downloads.push({ kind: "ok", declared: 8, send: 8, title: "Titulo" });
		store.failCommitWhen = (job) => job.status === "done";
		await expect(engine.onAlarm()).rejects.toThrow("storage indisponivel");
		expect(store.job!.status).toBe("running");
		expect(store.alarmAt).toBeGreaterThan(T0);
		expect(files.objects.size).toBe(1);
		store.failCommitWhen = null;
		box.downloads.push({ kind: "status", status: 422, body: JSON.stringify({ error: "nao deveria baixar" }) });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", bytes: 8, title: "Titulo", ext: "mp4", attempts: previousAttempts + 1 });
		expect(store.job!.error).toBeUndefined();
		expect(box.downloadCalls).toHaveLength(1);
		expect(box.started).toBe(1);
	});

	it.each([1, MAX_ATTEMPTS])("execucao interrompida depois do upload (tentativas=%i) conclui sem subir container", async (attempts) => {
		const { engine, store, box, files } = setup();
		await files.put(`files/${ID}`, new Blob(["12345"]).stream(), {
			contentType: "video/mp4",
			contentDisposition: "attachment",
			customMetadata: { title: "Ja gravado", ext: "mp4", warning: "Video em AV1: aviso" },
		});
		store.job = newJob({ status: "running", attempts });
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", bytes: 5, title: "Ja gravado", attempts, warning: "Video em AV1: aviso" });
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETENTION_MS);
		expect(box.started).toBe(0);
		expect(box.downloadCalls).toHaveLength(0);
	});

	it("storage fora do ar depois do inicio: alarm rejeita, alarm de seguranca fica agendado e a retomada nao rebaixa", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		store.failCommitWhen = (job) => job.status !== "running";
		await expect(engine.onAlarm()).rejects.toThrow("storage indisponivel");
		expect(store.job!.status).toBe("running");
		expect(store.alarmAt).toBe(T0 + ALARM_BUDGET_MS + RETRY_DELAY_MS);
		expect(box.destroyed).toBe(1);
		store.failCommitWhen = null;
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 1 });
		expect(box.downloadCalls).toHaveLength(1);
	});

	it("falha ao gravar a retentativa: alarm rejeita e a proxima execucao baixa de novo", async () => {
		const { engine, store, box } = setup();
		await engine.create(newJob());
		box.downloads.push({ kind: "throw", error: "rede" });
		store.failCommitWhen = (job) => job.status === "queued";
		await expect(engine.onAlarm()).rejects.toThrow("storage indisponivel");
		store.failCommitWhen = null;
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 2 });
	});

	it("R2 fora do ar na reconciliacao alem das retentativas do runtime: reagenda sem gastar tentativa", async () => {
		const { engine, store, files, box, clock } = setup();
		await engine.create(newJob());
		files.failHeads = 8;
		for (let i = 0; i < 8; i++) {
			await engine.onAlarm();
			expect(store.job).toMatchObject({ status: "queued", attempts: 0 });
			expect(store.alarmAt).toBe(clock.t + RETRY_DELAY_MS);
			clock.t = store.alarmAt!;
		}
		expect(box.downloadCalls).toHaveLength(0);
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 1 });
	});

	it("limpeza que falha alem das retentativas do runtime se reagenda ate conseguir", async () => {
		const { engine, store, files, clock } = setup();
		await engine.create(newJob());
		await engine.onAlarm();
		const doneAt = store.job!.updatedAt;
		clock.t = doneAt + RETENTION_MS;
		files.failDeletes = 8;
		for (let i = 0; i < 8; i++) {
			await engine.onAlarm();
			expect(store.alarmAt).toBe(clock.t + CLEANUP_RETRY_MS);
			expect(store.job!.updatedAt).toBe(doneAt);
			clock.t = store.alarmAt!;
		}
		await engine.onAlarm();
		expect(files.objects.size).toBe(0);
		expect(store.job).toBeNull();
		expect(store.alarmAt).toBeNull();
	});

	it("depois de 24 h apaga o arquivo do R2 e o estado", async () => {
		const { engine, store, files, clock } = setup();
		await engine.create(newJob());
		await engine.onAlarm();
		expect(files.objects.size).toBe(1);
		clock.t = store.job!.updatedAt + RETENTION_MS;
		await engine.onAlarm();
		expect(files.objects.size).toBe(0);
		expect(store.job).toBeNull();
		expect(store.alarmAt).toBeNull();
	});
});

describe("watchdog do GET (follow-up #5)", () => {
	it("job orfao (sem alarm) e rearmado para agora + 30 s, sem gastar tentativa, e depois conclui", async () => {
		const { engine, store, box, clock } = setup();
		store.job = newJob({ status: "queued", attempts: 1, error: "rede" });
		store.alarmAt = null;
		clock.t = T0 + 5 * 60 * 1000;
		const seen = await engine.watchdog();
		expect(seen).toMatchObject({ status: "queued", attempts: 1 });
		expect(store.alarmAt).toBe(clock.t + RETRY_DELAY_MS);
		expect(store.job).toMatchObject({ attempts: 1, updatedAt: T0 });
		expect(box.downloadCalls).toHaveLength(0);
		clock.t = store.alarmAt!;
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", attempts: 2 });
	});

	it("job em running sem alarm (commit do resultado perdido) tambem e rearmado", async () => {
		const { engine, store, clock } = setup();
		store.job = newJob({ status: "running", attempts: 1 });
		store.alarmAt = null;
		await engine.watchdog();
		expect(store.alarmAt).toBe(clock.t + RETRY_DELAY_MS);
	});

	it("I5: com alarm pendente nao mexe no agendamento, por mais vezes que a UI consulte", async () => {
		const { engine, store } = setup();
		await engine.create(newJob());
		await engine.onAlarm();
		const cleanupAt = store.alarmAt;
		for (let i = 0; i < 20; i++) await engine.watchdog();
		expect(store.alarmAt).toBe(cleanupAt);
		expect(store.job!.status).toBe("done");
	});

	it("job terminal sem alarm tambem e rearmado: a limpeza de 24 h volta a existir", async () => {
		const { engine, store, clock } = setup();
		store.job = newJob({ status: "failed", error: "x", updatedAt: T0 });
		store.alarmAt = null;
		await engine.watchdog();
		expect(store.alarmAt).toBe(clock.t + RETRY_DELAY_MS);
		clock.t = store.alarmAt!;
		await engine.onAlarm();
		expect(store.alarmAt).toBe(T0 + RETENTION_MS);
	});

	it("sem job: devolve null e nao agenda nada", async () => {
		const { engine, store } = setup();
		expect(await engine.watchdog()).toBeNull();
		expect(store.alarmAt).toBeNull();
	});
});

describe("teto de vida do job e da limpeza (follow-up #5)", () => {
	it("R2 fora do ar por mais de 2 h desde a criacao: failed com mensagem clara, sem container", async () => {
		const { engine, store, files, box, clock } = setup();
		await engine.create(newJob());
		files.failHeads = 1000;
		while (clock.t - T0 <= MAX_JOB_AGE_MS) {
			await engine.onAlarm();
			expect(store.job!.status).toBe("queued");
			clock.t = store.alarmAt!;
		}
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed", attempts: 0 });
		expect(store.job!.error).toMatch(/R2/);
		expect(store.alarmAt).toBe(store.job!.updatedAt + RETENTION_MS);
		expect(box.started).toBe(0);
	});

	it("job orfao rearmado depois de mais de 2 h e sem arquivo: failed, nao baixa dias depois", async () => {
		const { engine, store, box, clock } = setup();
		store.job = newJob({ status: "queued", attempts: 1, error: "rede" });
		clock.t = T0 + MAX_JOB_AGE_MS + 1;
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "failed", attempts: 1 });
		expect(store.job!.error).toMatch(/reenvie/i);
		expect(box.started).toBe(0);
	});

	it("job orfao antigo com o arquivo ja no R2: a reconciliacao vence e conclui como done", async () => {
		const { engine, store, files, clock } = setup();
		await files.put(`files/${ID}`, new Blob(["123"]).stream(), {
			contentType: "video/mp4",
			contentDisposition: "attachment",
			customMetadata: { title: "Velho", ext: "mp4" },
		});
		store.job = newJob({ status: "running", attempts: 2 });
		clock.t = T0 + MAX_JOB_AGE_MS + 1;
		await engine.onAlarm();
		expect(store.job).toMatchObject({ status: "done", bytes: 3, title: "Velho" });
	});

	it("vida maxima no caminho normal (3 execucoes de 14 min com as esperas do motor) cabe com folga no teto", () => {
		const worst = MAX_ATTEMPTS * (ALARM_BUDGET_MS + RETRY_DELAY_MS) + RETRY_DELAY_MS * (1 + 2);
		expect(worst).toBeLessThan(MAX_JOB_AGE_MS / 2);
	});

	it("limpeza: delete do R2 falhando 2 dias alem do vencimento apaga so o estado (o arquivo fica com o lifecycle, A4)", async () => {
		const { engine, store, files, clock } = setup();
		await engine.create(newJob());
		await engine.onAlarm();
		const expiresAt = store.job!.updatedAt + RETENTION_MS;
		files.failDeletes = 1_000_000;
		clock.t = expiresAt;
		await engine.onAlarm();
		expect(store.alarmAt).toBe(clock.t + CLEANUP_RETRY_MS);
		clock.t = expiresAt + CLEANUP_GIVE_UP_MS - 1;
		await engine.onAlarm();
		expect(store.job).not.toBeNull();
		clock.t = expiresAt + CLEANUP_GIVE_UP_MS;
		await engine.onAlarm();
		expect(store.job).toBeNull();
		expect(store.alarmAt).toBeNull();
	});

	it("o teto da limpeza e de 2 dias, alem do lifecycle de 1 dia do bucket", () => {
		expect(CLEANUP_GIVE_UP_MS).toBeGreaterThanOrEqual(2 * 24 * 60 * 60 * 1000);
	});
});
