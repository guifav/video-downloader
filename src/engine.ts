// Motor de um job de download, sem dependencia do runtime da Cloudflare: storage, container,
// R2, relogio e FixedLengthStream entram por injecao. O Durable Object (src/container.ts) e
// so o adaptador; os contratos de retentativa, prazo, gravacao e limpeza moram aqui e sao
// testados em test/engine.test.ts.

import { contentDisposition } from "./files";
import {
	containerErrorMessage,
	deliveryMetadata,
	fileKey,
	fitMetadata,
	parseContainerSuccess,
	parseDeliveryMeta,
	type DeliveryMeta,
	type JobRecord,
} from "./job";

export const MAX_ATTEMPTS = 3;
// Arquivo e estado do job somem 24 h depois do fim. O lifecycle de 1 dia do bucket e a rede
// de seguranca caso a limpeza nunca rode.
export const RETENTION_MS = 24 * 60 * 60 * 1000;
// O alarm tem teto de 15 min de wall clock; o job inteiro (subida, download, gravacao) cabe em
// 14 min, sobrando margem para persistir o resultado e destruir o container.
export const ALARM_BUDGET_MS = 14 * 60 * 1000;
export const READY_BUDGET_MS = 30 * 1000;
export const HEALTH_TIMEOUT_MS = 1000;
export const READY_POLL_MS = 200;
export const RETRY_DELAY_MS = 30 * 1000;
export const CLEANUP_RETRY_MS = 10 * 60 * 1000;
// Teto de vida de um job nao terminal. No caminho normal a vida maxima e perto de 45 min (3
// execucoes de 14 min mais as esperas); o teto tambem limita as retentativas durante uma
// indisponibilidade longa de storage ou R2 (A2/A3). Passado o teto, o job vira failed em vez de
// esperar o R2 para sempre ou de baixar dias depois quando o watchdog o rearma (follow-up #5, item 2).
export const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000;
// Limpeza: dois dias depois do vencimento, um delete que ainda falha nao segura mais o estado
// (follow-up #5, item 3). A remocao do arquivo fica com o lifecycle de 1 dia do bucket, que e tipica,
// nao garantida (A4); sem o estado, GET /api/files/:id ja nao serve o objeto (src/api.ts).
export const CLEANUP_GIVE_UP_MS = 2 * 24 * 60 * 60 * 1000;
export const DEADLINE_ERROR = `O download passou do limite de ${ALARM_BUDGET_MS / 60_000} min (video longo demais ou live em andamento).`;
// O container recebe o prazo dele (budget_ms) ja descontada a gravacao no R2, para que a
// conversao para H.264 desista a tempo e entregue o original com aviso (container/app.py).
export const UPLOAD_RESERVE_MS = 2 * 60 * 1000;
export const MIN_CONTAINER_BUDGET_MS = 1000;
const MAX_TITLE_METADATA = 300;

export interface JobStore {
	load(): Promise<JobRecord | null>;
	/** Grava o job e (re)agenda o alarm na mesma transacao. */
	commit(job: JobRecord, alarmAt: number): Promise<void>;
	/** Apaga estado e alarm. */
	clear(): Promise<void>;
	/** Numa transacao: se ha job e nenhum alarm pendente, agenda o alarm. Devolve o job. */
	armIfIdle(alarmAt: number): Promise<JobRecord | null>;
}

export interface JobBox {
	ensureStarted(): Promise<void>;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	destroy(): Promise<void>;
}

export interface StoredFileOptions {
	contentType: string;
	contentDisposition: string;
	customMetadata: Record<string, string>;
}

export interface StoredFileInfo {
	size: number;
	customMetadata: Record<string, string>;
}

export interface FileStore {
	put(key: string, body: ReadableStream<Uint8Array>, options: StoredFileOptions): Promise<void>;
	/** Metadados de um objeto ja gravado (o put do R2 e atomico: existir = completo). */
	head(key: string): Promise<StoredFileInfo | null>;
	delete(key: string): Promise<void>;
}

export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export type SizedStreamFactory = (bytes: number) => {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

export interface EngineDeps {
	store: JobStore;
	box: JobBox;
	files: FileStore;
	clock: Clock;
	makeSized: SizedStreamFactory;
	timeoutSignal?: (ms: number) => AbortSignal;
}

type RunOutcome =
	| ({ kind: "done"; title: string; ext: string; bytes: number; warning?: string } & DeliveryMeta)
	| { kind: "terminal"; error: string };

// So os campos presentes: o job nao ganha chaves vazias.
function deliveryOf(source: DeliveryMeta): DeliveryMeta {
	const out: DeliveryMeta = {};
	if (source.sourceCodec) out.sourceCodec = source.sourceCodec;
	if (source.width && source.height) {
		out.width = source.width;
		out.height = source.height;
	}
	return out;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 800);
}

export class JobEngine {
	private readonly timeoutSignal: (ms: number) => AbortSignal;

	constructor(private readonly deps: EngineDeps) {
		this.timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
	}

	async create(job: JobRecord): Promise<JobRecord> {
		const existing = await this.deps.store.load();
		if (existing) return existing;
		await this.deps.store.commit(job, this.deps.clock.now());
		return job;
	}

	// Watchdog pelo GET (follow-up #5): todo job existente tem alarm. Se o commit de uma execucao
	// falhou alem das retentativas do runtime (job orfao, A2), a proxima consulta da UI o rearma.
	// So agenda quando nao ha alarm pendente, e sempre com a espera minima (I5): consultar o job
	// nunca adianta um alarm nem gasta tentativa. Se o handler do alarm estiver no meio da
	// execucao (getAlarm e null ate o primeiro setAlarm dele), o commit do handler sobrescreve.
	watchdog(): Promise<JobRecord | null> {
		return this.deps.store.armIfIdle(this.deps.clock.now() + RETRY_DELAY_MS);
	}

	async onAlarm(): Promise<void> {
		const { store, files, clock, box } = this.deps;
		const job = await store.load();
		if (!job) return;
		const now = clock.now();

		if (job.status === "done" || job.status === "failed") {
			const expiresAt = job.updatedAt + RETENTION_MS;
			if (now >= expiresAt) {
				try {
					try {
						await files.delete(fileKey(job.id));
					} catch (error) {
						// Passado o teto, a remocao do arquivo fica com o lifecycle do bucket (A4).
						if (now < expiresAt + CLEANUP_GIVE_UP_MS) throw error;
					}
					await store.clear();
				} catch {
					// O runtime so retenta o alarm 6 vezes; a limpeza se reagenda sozinha ate conseguir.
					await store.commit(job, now + CLEANUP_RETRY_MS);
				}
			} else {
				// Reentrada em estado terminal: restaura o agendamento da limpeza caso ele tenha se perdido.
				await store.commit(job, expiresAt);
			}
			return;
		}

		// Reconciliacao: se uma execucao anterior ja gravou o arquivo (e falhou so ao persistir o
		// estado, ou foi interrompida depois do upload), conclui sem tocar na origem. O put do R2 e
		// atomico: o objeto existir significa arquivo completo.
		const tooOld = now - job.createdAt > MAX_JOB_AGE_MS;
		let stored: StoredFileInfo | null;
		try {
			stored = await files.head(fileKey(job.id));
		} catch {
			if (tooOld) {
				await this.terminal(job, "failed", {
					error: "R2 indisponivel por mais de 2 h; nao foi possivel concluir o download. Reenvie o link.",
				});
				return;
			}
			// R2 indisponivel: nao da para saber se o arquivo existe. Reagenda sem gastar tentativa,
			// porque o runtime so retenta o alarm 6 vezes e nada mais retomaria o job.
			await store.commit(job, now + RETRY_DELAY_MS);
			return;
		}
		if (stored) {
			await this.terminal(job, "done", {
				title: stored.customMetadata.title ?? "",
				ext: stored.customMetadata.ext ?? "mp4",
				bytes: stored.size,
				error: undefined,
				warning: stored.customMetadata.warning || undefined,
				...parseDeliveryMeta(stored.customMetadata.sourceCodec, stored.customMetadata.size),
			});
			return;
		}

		// Job parado alem da vida legitima (orfao rearmado pelo watchdog dias depois): nao baixa mais.
		if (tooOld) {
			await this.terminal(job, "failed", {
				error: job.error
					? `Job parado por mais de 2 h; reenvie o link. Ultimo erro: ${job.error}`
					: "Job parado por mais de 2 h; reenvie o link.",
			});
			return;
		}

		// "running" aqui significa que uma execucao anterior foi interrompida (deploy, eviction).
		if (job.attempts >= MAX_ATTEMPTS) {
			await this.terminal(job, "failed", {
				error: job.error
					? `Falhou apos ${job.attempts} tentativas: ${job.error}`
					: "Download interrompido repetidamente; tente de novo.",
			});
			return;
		}

		job.attempts += 1;
		job.status = "running";
		job.updatedAt = now;
		const deadline = now + ALARM_BUDGET_MS;
		// Alarm de seguranca: se esta execucao morrer sem gravar resultado, ele reexecuta o job.
		await store.commit(job, deadline + RETRY_DELAY_MS);

		let outcome: RunOutcome | null = null;
		let failure: string | null = null;
		try {
			outcome = await this.run(job, deadline);
		} catch (error) {
			failure = errorMessage(error);
		} finally {
			try {
				await box.destroy();
			} catch {
				// o timeout de inatividade derruba o container de qualquer forma
			}
		}

		// Persistencia fora do try do download: se gravar o estado falhar, o alarm rejeita e o runtime
		// (ou o alarm de seguranca) reexecuta. Se o arquivo ja esta no R2, a reconciliacao conclui sem
		// baixar de novo; se o resultado perdido era uma falha, a reexecucao gasta outra tentativa
		// (desfecho A1 de docs/contrato-de-falhas.md).
		if (failure !== null) {
			await this.retryOrFail(job, failure);
		} else if (outcome!.kind === "done") {
			await this.terminal(job, "done", {
				title: outcome!.title,
				ext: outcome!.ext,
				bytes: outcome!.bytes,
				error: undefined,
				warning: outcome!.warning,
				...deliveryOf(outcome!),
			});
		} else {
			await this.terminal(job, "failed", { error: outcome!.error });
		}
	}

	private async retryOrFail(job: JobRecord, message: string): Promise<void> {
		const { store, clock } = this.deps;
		if (job.attempts >= MAX_ATTEMPTS) {
			await this.terminal(job, "failed", { error: `Falhou apos ${job.attempts} tentativas: ${message}` });
			return;
		}
		job.status = "queued";
		job.error = message;
		job.updatedAt = clock.now();
		await store.commit(job, job.updatedAt + RETRY_DELAY_MS * job.attempts);
	}

	private async terminal(job: JobRecord, status: "done" | "failed", patch: Partial<JobRecord>): Promise<void> {
		Object.assign(job, patch, { status, updatedAt: this.deps.clock.now() });
		if (patch.error === undefined && "error" in patch) delete job.error;
		if (patch.warning === undefined && "warning" in patch) delete job.warning;
		await this.deps.store.commit(job, job.updatedAt + RETENTION_MS);
	}

	private async run(job: JobRecord, deadline: number): Promise<RunOutcome> {
		const { box, clock } = this.deps;
		await box.ensureStarted();
		await this.waitReady(Math.min(clock.now() + READY_BUDGET_MS, deadline));

		const remaining = deadline - clock.now();
		if (remaining <= 0) throw new Error("sem tempo restante para o download");
		// Um unico sinal de prazo para a execucao inteira: download E gravacao no R2 (I4).
		const deadlineSignal = this.timeoutSignal(remaining);
		let response: Response;
		try {
			response = await box.fetch("/download", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					url: job.url,
					platform: job.platform,
					budget_ms: Math.max(MIN_CONTAINER_BUDGET_MS, Math.floor(remaining - UPLOAD_RESERVE_MS)),
				}),
				signal: deadlineSignal,
			});
		} catch (error) {
			// Prazo estourado antes de o container responder: o yt-dlp ainda baixava (video longo
			// demais, live em andamento). Repetir falharia igual e gastaria as 3 execucoes: terminal.
			// Estouro durante a gravacao no R2 continua transitorio (infra), em storeBody.
			if (deadlineSignal.aborted) return { kind: "terminal", error: DEADLINE_ERROR };
			throw error;
		}

		if (!response.ok) {
			const message = containerErrorMessage(response.status, await response.text());
			// 4xx = o yt-dlp ou a validacao recusaram o video: terminal. 5xx = falha transitoria.
			if (response.status >= 500) throw new Error(message);
			return { kind: "terminal", error: message };
		}

		const parsed = parseContainerSuccess(response.headers);
		if (!parsed.ok || !response.body) {
			await response.body?.cancel();
			return { kind: "terminal", error: parsed.ok ? "Container respondeu sem corpo." : parsed.error };
		}

		await this.storeBody(job, response.body, parsed.bytes, deadlineSignal, {
			contentType: parsed.ext === "mp4" ? "video/mp4" : "application/octet-stream",
			contentDisposition: contentDisposition(parsed.title, job.videoId, parsed.ext),
			customMetadata: fitMetadata({
				platform: job.platform,
				url: job.url,
				title: Array.from(parsed.title).slice(0, MAX_TITLE_METADATA).join(""),
				ext: parsed.ext,
				// Gravado junto com o arquivo: a reconciliacao conclui o job a partir do R2 sem perder o aviso.
				...(parsed.warning ? { warning: parsed.warning } : {}),
				...deliveryMetadata(parsed),
			}),
		});
		return { kind: "done", title: parsed.title, ext: parsed.ext, bytes: parsed.bytes, warning: parsed.warning, ...deliveryOf(parsed) };
	}

	private async waitReady(readyDeadline: number): Promise<void> {
		const { box, clock } = this.deps;
		for (;;) {
			const left = readyDeadline - clock.now();
			if (left <= 0) throw new Error(`container nao ficou pronto em ${READY_BUDGET_MS / 1000} s`);
			try {
				const res = await box.fetch("/health", { signal: this.timeoutSignal(Math.min(HEALTH_TIMEOUT_MS, left)) });
				await res.body?.cancel();
				if (res.ok) return;
			} catch {
				// servidor ainda nao esta ouvindo
			}
			const pause = Math.min(READY_POLL_MS, readyDeadline - clock.now());
			if (pause > 0) await clock.sleep(pause);
		}
	}

	// Corpo e upload correm juntos. Sem estouro do prazo, as duas promessas sao aguardadas; no
	// estouro, sao observadas (catch) e abandonadas, para a execucao sair no prazo de I4. Nenhuma
	// rejeicao fica sem observacao. A copia do corpo para o stream de tamanho fixo e feita por uma bomba propria,
	// que corre cada leitura/escrita contra a falha do upload: se o R2 desistir segurando o reader
	// (escrita presa por contrapressao), a bomba sai na hora e cancela a origem.
	private async storeBody(
		job: JobRecord,
		body: ReadableStream<Uint8Array>,
		bytes: number,
		deadline: AbortSignal,
		options: StoredFileOptions,
	): Promise<void> {
		const { files, makeSized } = this.deps;
		const key = fileKey(job.id);
		const sized = makeSized(bytes);
		const writer = sized.writable.getWriter();
		const reader = body.getReader();

		const upload = files.put(key, sized.readable, options);
		const uploadFailed: Promise<never> = upload.then(() => new Promise<never>(() => {}));
		// Prazo do alarm (I4): se estourar, a gravacao e abandonada. Um put que ainda conclua depois
		// deixa o objeto completo (put atomico) e a proxima execucao reconcilia.
		let onDeadline: () => void = () => {};
		const expired = new Promise<never>((_, reject) => {
			onDeadline = () => reject(new Error("prazo do alarm esgotado durante a gravacao no R2"));
			if (deadline.aborted) onDeadline();
			else deadline.addEventListener("abort", onDeadline, { once: true });
		});
		expired.catch(() => {});

		const pump = async (): Promise<void> => {
			for (;;) {
				const chunk = await Promise.race([reader.read(), uploadFailed]);
				if (chunk.done) break;
				const write = writer.write(chunk.value);
				write.catch(() => {});
				await Promise.race([write, uploadFailed]);
			}
			const close = writer.close();
			close.catch(() => {});
			await Promise.race([close, uploadFailed]);
		};
		const pumping = pump().catch(async (error: unknown) => {
			await reader.cancel(error).catch(() => {});
			// Sem await: com uma escrita presa, o abort so concluiria depois dela.
			writer.abort(error).catch(() => {});
			throw error;
		});

		const both = Promise.allSettled([pumping, upload]);
		let settled: [PromiseSettledResult<void>, PromiseSettledResult<void>];
		try {
			settled = await Promise.race([both, expired]);
		} catch (error) {
			await reader.cancel(error).catch(() => {});
			writer.abort(error).catch(() => {});
			pumping.catch(() => {});
			upload.catch(() => {});
			throw error;
		} finally {
			deadline.removeEventListener("abort", onDeadline);
		}
		const [pumpResult, uploadResult] = settled;
		if (pumpResult.status === "fulfilled" && uploadResult.status === "fulfilled") return;

		try {
			await files.delete(key);
		} catch {
			// objeto parcial, se existir, expira pelo lifecycle do bucket
		}
		const reason = uploadResult.status === "rejected" ? uploadResult.reason : (pumpResult as PromiseRejectedResult).reason;
		throw new Error(`falha ao gravar no R2: ${errorMessage(reason)}`);
	}
}
