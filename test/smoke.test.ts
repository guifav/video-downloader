// @ts-expect-error tipos do Node nao fazem parte do tsconfig do Worker
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JobRecord } from "../src/job";
import type { RecentEntry } from "../src/recent";
import type { ResolvedVideoUrl } from "../src/share";
import {
	CHECK_CRON,
	CHECK_OFFSET_MS,
	cronKind,
	SMOKE_CASES,
	SMOKE_INDEX,
	START_CRON,
	checkSmoke,
	reportEmail,
	runScheduled,
	startSmoke,
	trackingId,
	type SmokeCase,
	type SmokeDeps,
} from "../src/smoke";

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0); // segunda 09:00 BRT

function fakeDeps(cases: SmokeCase[] = SMOKE_CASES) {
	const jobs = new Map<string, JobRecord>();
	const files = new Set<string>();
	const indexes = new Map<string, RecentEntry[]>();
	const sent: { subject: string; text: string }[] = [];
	let n = 0;
	const resolveTable = new Map<string, ResolvedVideoUrl>();
	const deps: SmokeDeps = {
		cases,
		// Relogio diferente do scheduledTime, como em producao (o handler comeca depois do agendado).
		now: () => T0 + 17_300,
		uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
		resolve: async (url) =>
			resolveTable.get(url) ?? { ok: true, platform: "youtube", videoId: "v", canonicalUrl: `${url}#canon` },
		createJob: async (job) => {
			jobs.set(job.id, structuredClone(job));
		},
		index: (name) => ({
			add: async (entry) => {
				indexes.set(name, [entry, ...(indexes.get(name) ?? [])]);
			},
			list: async () => indexes.get(name) ?? [],
		}),
		getJob: async (id) => (jobs.has(id) ? structuredClone(jobs.get(id)!) : null),
		fileExists: async (id) => files.has(id),
		send: async (subject, text) => {
			sent.push({ subject, text });
		},
	};
	return { deps, jobs, files, indexes, sent, resolveTable };
}

const one = (name: string, expect: "done" | "failed" = "done"): SmokeCase => ({
	name,
	url: `https://example.invalid/${name}`,
	platform: "youtube",
	expect,
	...(expect === "failed" ? { expectError: "No video could be found" } : {}),
});

describe("casos do smoke", () => {
	it("cobrem as cinco plataformas, o link do app do Facebook e do TikTok, a conversao longa e um post sem video", () => {
		const names = SMOKE_CASES.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		expect(new Set(SMOKE_CASES.map((c) => c.platform))).toEqual(new Set(["youtube", "x", "instagram", "facebook", "tiktok"]));
		expect(SMOKE_CASES.some((c) => c.url.includes("facebook.com/share/"))).toBe(true);
		const negative = SMOKE_CASES.filter((c) => c.expect === "failed");
		expect(negative).toHaveLength(1);
		expect(negative[0].expectError).toBeTruthy();
		expect(SMOKE_CASES.find((c) => c.name === "facebook-conversao-longa")?.expectConversion).toBe(true);
		expect(SMOKE_CASES.filter((c) => c.expectConversion)).toHaveLength(1);
	});
});

describe("startSmoke", () => {
	it("cria um job por caso com a URL resolvida, marca o caso e indexa so no indice do smoke", async () => {
		const { deps, jobs, indexes } = fakeDeps([one("a"), one("b")]);
		await startSmoke(deps, T0);
		expect([...jobs.values()].map((j) => [j.smoke, j.url, j.status])).toEqual([
			[`${T0}/a`, "https://example.invalid/a#canon", "queued"],
			[`${T0}/b`, "https://example.invalid/b#canon", "queued"],
		]);
		expect(indexes.get(SMOKE_INDEX)).toHaveLength(2);
		expect([...indexes.keys()]).toEqual([SMOKE_INDEX]);
	});

	it("falha de resolucao vira job failed com a mensagem, sem derrubar os outros casos", async () => {
		const { deps, jobs, resolveTable } = fakeDeps([one("a"), one("b")]);
		resolveTable.set("https://example.invalid/a", { ok: false, error: "share mudou", status: 400 });
		await startSmoke(deps, T0);
		const a = [...jobs.values()].find((j) => j.smoke!.endsWith("/a"))!;
		expect(a).toMatchObject({ status: "failed", error: "resolucao: share mudou" });
		expect([...jobs.values()].find((j) => j.smoke!.endsWith("/b"))!.status).toBe("queued");
	});

	it("erro ao criar um job nao impede os outros", async () => {
		const { deps, jobs } = fakeDeps([one("a"), one("b")]);
		const create = deps.createJob;
		deps.createJob = async (job) => {
			if (job.smoke!.endsWith("/a")) throw new Error("DO fora");
			return create(job);
		};
		await startSmoke(deps, T0);
		expect([...jobs.values()].map((j) => j.smoke!.split("/")[1])).toEqual(["b"]);
	});
});

describe("checkSmoke", () => {
	const CHECK_AT = T0 + CHECK_OFFSET_MS;

	async function started(cases: SmokeCase[], at = T0) {
		const f = fakeDeps(cases);
		await startSmoke(f.deps, at);
		const byName = (name: string, run = at) => [...f.jobs.values()].find((j) => j.smoke === `${run}/${name}`)!;
		const finish = (name: string, patch: Partial<JobRecord>, run = at) => {
			const job = byName(name, run);
			f.jobs.set(job.id, { ...job, ...patch });
			if (patch.status === "done") f.files.add(job.id);
		};
		return { ...f, byName, finish };
	}

	it("deslocamento real do scheduledTime (segundos depois do minuto, diferente em cada evento): ok (achado B1 do consultor)", async () => {
		const f = fakeDeps([one("a"), one("sem-video", "failed")]);
		await runScheduled(START_CRON, T0 + 17_000, f.deps);
		for (const job of f.jobs.values()) {
			const done = job.smoke!.endsWith("/a");
			f.jobs.set(job.id, done ? { ...job, status: "done", bytes: 5 } : { ...job, status: "failed", error: "No video could be found in this tweet" });
			if (done) f.files.add(job.id);
		}
		await runScheduled(CHECK_CRON, T0 + CHECK_OFFSET_MS + 46_000, f.deps);
		expect(f.sent[0].subject).toMatch(/smoke OK 2\/2/);
		// checagem atrasada 12 min tambem acha a rodada
		await runScheduled(CHECK_CRON, T0 + CHECK_OFFSET_MS + 12 * 60 * 1000, f.deps);
		expect(f.sent[1].subject).toMatch(/smoke OK 2\/2/);
	});

	it("reentrega do inicio na mesma hora: etiqueta repetida so passa se todos os jobs passarem", async () => {
		const f = fakeDeps([one("a")]);
		await startSmoke(f.deps, T0 + 5_000);
		await startSmoke(f.deps, T0 + 40_000);
		const [first, second] = [...f.jobs.values()];
		expect(first.smoke).toBe(second.smoke);
		f.jobs.set(first.id, { ...first, status: "done", bytes: 1 });
		f.files.add(first.id);
		f.jobs.set(second.id, { ...second, status: "failed", error: "Sign in to confirm" });
		const report = await checkSmoke(f.deps, T0 + CHECK_OFFSET_MS + 3_000);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(/Sign in/);
	});

	it("etiqueta repetida: passa se todos passam; falha se qualquer um falha, na ordem que for", async () => {
		const f = fakeDeps([one("a")]);
		await startSmoke(f.deps, T0 + 5_000);
		await startSmoke(f.deps, T0 + 40_000);
		const [first, second] = [...f.jobs.values()];
		const set = (job: JobRecord, ok: boolean) => {
			f.jobs.set(job.id, ok ? { ...job, status: "done", bytes: 1 } : { ...job, status: "failed", error: "Sign in to confirm" });
			if (ok) f.files.add(job.id);
		};
		const check = () => checkSmoke(f.deps, T0 + CHECK_OFFSET_MS + 3_000);
		set(first, true);
		set(second, true);
		expect((await check()).ok).toBe(true);
		set(first, false);
		expect((await check()).ok).toBe(false);
		set(first, true);
		set(second, false);
		expect((await check()).ok).toBe(false);
	});

	it("a rodada e a hora cheia: 59 min de atraso em cada evento ainda acham a rodada; 60 min nao", async () => {
		const f = fakeDeps([one("a")]);
		await startSmoke(f.deps, T0 + 59 * 60_000 + 59_000);
		const [job] = [...f.jobs.values()];
		expect(job.smoke).toBe(`${T0}/a`);
		f.jobs.set(job.id, { ...job, status: "done", bytes: 1 });
		f.files.add(job.id);
		expect((await checkSmoke(f.deps, T0 + CHECK_OFFSET_MS + 59 * 60_000 + 59_000)).ok).toBe(true);
		expect((await checkSmoke(f.deps, T0 + CHECK_OFFSET_MS + 60 * 60_000)).results[0].detail).toMatch(/nao iniciou/);
	});

	it("tudo como esperado: ok", async () => {
		const s = await started([one("a"), one("sem-video", "failed")]);
		s.finish("a", { status: "done", bytes: 10 });
		s.finish("sem-video", { status: "failed", error: "No video could be found in this tweet" });
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(true);
		expect(report.results.map((r) => [r.name, r.ok])).toEqual([
			["a", true],
			["sem-video", true],
		]);
	});

	it.each([
		["ainda rodando", { status: "running" as const }, /nao terminou/],
		["falhou", { status: "failed" as const, error: "Sign in to confirm" }, /Sign in to confirm/],
		["saiu fora do H.264", { status: "done" as const, warning: "Video em VP9: nao deu tempo" }, /VP9/],
	])("%s: falha com o motivo", async (_label, patch, reason) => {
		const s = await started([one("a")]);
		s.finish("a", patch);
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(reason);
	});

	it.each([
		["sem codec de origem", {}, /nao provou a conversao/],
		["origem ja em h264", { sourceCodec: "h264" }, /nao provou a conversao/],
	])("caso de conversao %s: falha mesmo com done sem aviso (Kimi R1 do PR #9)", async (_label, patch, reason) => {
		const s = await started([{ ...one("longo"), expectConversion: true }]);
		s.finish("longo", { status: "done", bytes: 10, ...patch });
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(reason);
	});

	it("caso de conversao com origem vp9 entregue sem aviso: ok, e o detalhe mostra a origem", async () => {
		const s = await started([{ ...one("longo"), expectConversion: true }]);
		s.finish("longo", { status: "done", bytes: 10, sourceCodec: "vp9", width: 1280, height: 720 });
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(true);
		expect(report.results[0].detail).toMatch(/vp9 -> h264/);
	});

	it("done sem arquivo no R2 e falha", async () => {
		const s = await started([one("a")]);
		const job = s.byName("a");
		s.jobs.set(job.id, { ...job, status: "done" });
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.results[0]).toMatchObject({ ok: false });
		expect(report.results[0].detail).toMatch(/arquivo/);
	});

	it.each([
		["infraestrutura", "Falhou apos 3 tentativas: container indisponivel"],
		["resolucao", "resolucao: share mudou"],
		["bloqueio", "Sign in to confirm you're not a bot"],
	])("caso negativo que falhou por %s nao conta como ok (achado P2 do PR #9)", async (_label, error) => {
		const s = await started([one("sem-video", "failed")]);
		s.finish("sem-video", { status: "failed", error });
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toContain(error);
	});

	it("esperava falha e baixou: falha", async () => {
		const s = await started([one("sem-video", "failed")]);
		s.finish("sem-video", { status: "done" });
		expect((await checkSmoke(s.deps, CHECK_AT)).ok).toBe(false);
	});

	it("rodada que nao iniciou (nenhum job) e falha", async () => {
		const { deps } = fakeDeps([one("a")]);
		const report = await checkSmoke(deps, CHECK_AT);
		expect(report.results[0]).toMatchObject({ name: "a", ok: false });
		expect(report.results[0].detail).toMatch(/nao iniciou/);
	});

	it("job ilegivel desde o inicio da rodada derruba o relatorio", async () => {
		const s = await started([one("a")]);
		s.finish("a", { status: "done", bytes: 1 });
		s.indexes.set(SMOKE_INDEX, [{ id: "ilegivel", createdAt: T0 + 1 }, ...(s.indexes.get(SMOKE_INDEX) ?? [])]);
		const getJob = s.deps.getJob;
		s.deps.getJob = async (id) => {
			if (id === "ilegivel") throw new Error("DO fora");
			return getJob(id);
		};
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results.some((r) => r.name === "indice")).toBe(true);
	});

	it("entrada cujo job sumiu (get devolve null) tambem derruba o relatorio (Kimi R2)", async () => {
		const s = await started([one("a")]);
		s.finish("a", { status: "done", bytes: 1 });
		s.jobs.delete(s.byName("a").id);
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results.some((r) => r.name === "indice")).toBe(true);
	});

	it("rodada anterior aprovada nunca responde por uma rodada que nao criou jobs (achado P2 da R3)", async () => {
		const s = await started([one("a")], T0 - 60 * 60 * 1000);
		s.finish("a", { status: "done", bytes: 1 }, T0 - 60 * 60 * 1000);
		// rodada de T0: start falhou por inteiro (nenhum job criado)
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(/nao iniciou/);
	});

	it("rodada nova aprovada nao responde pela checagem de uma rodada anterior que falhou", async () => {
		const early = T0 - 60 * 60 * 1000;
		const s = await started([one("a")], early);
		s.finish("a", { status: "failed", error: "Sign in to confirm" }, early);
		await startSmoke(s.deps, T0);
		s.finish("a", { status: "done", bytes: 1 }, T0);
		const report = await checkSmoke(s.deps, early + CHECK_OFFSET_MS);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(/Sign in/);
		expect((await checkSmoke(s.deps, CHECK_AT)).ok).toBe(true);
	});

	it("job ilegivel de uma rodada anterior nao reprova a rodada atual", async () => {
		const s = await started([one("a")]);
		s.finish("a", { status: "done", bytes: 1 });
		s.indexes.set(SMOKE_INDEX, [...(s.indexes.get(SMOKE_INDEX) ?? []), { id: "antigo", createdAt: T0 - 60 * 60 * 1000 }]);
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(true);
	});

	it("job da rodada nao indexado com outra rodada aprovada no indice: nao iniciou (achado P2 da R2)", async () => {
		const early = T0 - 60 * 60 * 1000;
		const s = await started([one("a")], early);
		s.finish("a", { status: "done", bytes: 1 }, early);
		const add = s.deps.index;
		s.deps.index = (name) => ({ list: add(name).list, add: async () => Promise.reject(new Error("indice fora")) });
		await startSmoke(s.deps, T0);
		s.deps.index = add;
		const report = await checkSmoke(s.deps, CHECK_AT);
		expect(report.ok).toBe(false);
		expect(report.results[0].detail).toMatch(/nao iniciou/);
	});
});

describe("email e cron", () => {
	it("assunto com resultado e tracking id HC-YYYYMMDD-HHMM em horario de Brasilia; corpo lista cada caso", () => {
		expect(trackingId(T0)).toBe("HC-20261116-0900");
		const mail = reportEmail(
			{
				ok: false,
				results: [
					{ name: "a", ok: true, detail: "done, 10 bytes" },
					{ name: "b", ok: false, detail: "failed: Sign in to confirm" },
				],
			},
			T0,
		);
		expect(mail.subject).toBe("[video-download] smoke FALHA 1/2 HC-20261116-0900");
		expect(mail.text).toContain("FALHA  b: failed: Sign in to confirm");
		expect(mail.text).toContain("ok     a: done, 10 bytes");
	});

	it("o cron de inicio cria jobs e nao manda email; o de checagem manda o relatorio", async () => {
		const { deps, jobs, sent } = fakeDeps([one("a")]);
		await runScheduled(START_CRON, T0, deps);
		expect(jobs.size).toBe(1);
		expect(sent).toHaveLength(0);
		await runScheduled(CHECK_CRON, T0 + CHECK_OFFSET_MS, deps);
		expect(sent).toHaveLength(1);
		// o job ficou em queued: FALHA por nao terminar, nao por "nao iniciou"
		expect(sent[0].subject).toMatch(/smoke FALHA 1\/1/);
		expect(sent[0].text).toMatch(/nao terminou/);
	});

	it("os crons do wrangler sao um de inicio e um de checagem", () => {
		const config: string = readFileSync("wrangler.jsonc", "utf8");
		const crons = JSON.parse(config.match(/"crons":\s*(\[[^\]]*\])/)![1]) as string[];
		expect(crons.sort()).toEqual([START_CRON, CHECK_CRON].sort());
		expect(crons.map(cronKind).sort()).toEqual(["check", "start"]);
		// Na Cloudflare o dia numerico 1 e domingo: segunda precisa ser pelo nome (achado B2 do consultor).
		for (const cron of crons) expect(cron.split(/\s+/)[4]).toBe("MON");
	});

	it("o intervalo entre os crons do wrangler e o CHECK_OFFSET_MS usado para achar a rodada", () => {
		const config: string = readFileSync("wrangler.jsonc", "utf8");
		const crons = JSON.parse(config.match(/"crons":\s*(\[[^\]]*\])/)![1]) as string[];
		const at = (kind: string) => {
			const [minute, hour] = crons.find((c) => cronKind(c) === kind)!.split(/\s+/).map(Number);
			return (hour * 60 + minute) * 60 * 1000;
		};
		expect(at("check") - at("start")).toBe(CHECK_OFFSET_MS);
	});

	it("o tipo do evento vem do minuto: rodada avulsa com outros horarios funciona igual", () => {
		expect(cronKind("0 22 * * *")).toBe("start");
		expect(cronKind("50 22 * * *")).toBe("check");
		expect(cronKind("*/5 * * * *")).toBeNull();
		expect(cronKind("15 12 * * 1")).toBeNull();
		expect(cronKind("00 12 * * 1")).toBe("start");
		expect(cronKind("  50\t12 * * 1")).toBe("check");
	});

	it("cron desconhecido nao faz nada", async () => {
		const { deps, jobs, sent } = fakeDeps([one("a")]);
		await runScheduled("* * * * *", T0, deps);
		expect(jobs.size).toBe(0);
		expect(sent).toHaveLength(0);
	});
});
