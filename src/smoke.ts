// Smoke semanal (item 4 do epic #1): roda dentro do proprio Worker, por cron, e usa o mesmo
// caminho de producao (resolver de share, Durable Object do job, container, R2) a partir da
// egress Cloudflare, sem passar pelo Access. Um cron inicia os jobs; outro, 50 min depois, confere
// o resultado e manda o relatorio por email. Puro e testavel: tudo entra por SmokeDeps.

import type { JobRecord } from "./job";
import type { RecentEntry } from "./recent";
import type { ResolvedVideoUrl } from "./share";
import type { Platform } from "./urls";

// Segunda-feira 09:00 e 09:50 em Brasilia (UTC-3), em triggers.crons no wrangler. Na Cloudflare o
// dia da semana numerico comeca em 1 = domingo; por isso o nome MON. O tipo do evento vem do
// minuto do cron (0 = inicio, 50 = checagem): uma rodada avulsa agendada pela API com outros
// dia/hora, mas os mesmos minutos, roda igual, sem mudar codigo.
export const START_CRON = "0 12 * * MON";
export const CHECK_CRON = "50 12 * * MON";

export function cronKind(cron: string): "start" | "check" | null {
	const minute = cron.trim().split(/\s+/)[0];
	if (!/^\d{1,2}$/.test(minute)) return null;
	if (Number(minute) === 0) return "start";
	if (Number(minute) === 50) return "check";
	return null;
}

// JobRecord.smoke = "<rodada>/<caso>": cada job pertence a uma rodada so.
export function smokeTag(runId: string, caseName: string): string {
	return `${runId}/${caseName}`;
}
export const SMOKE_INDEX = "smoke";

export interface SmokeCase {
	name: string;
	url: string;
	platform: Platform;
	expect: "done" | "failed";
	/** Caso negativo: so conta como ok se a falha trouxer este trecho (a rejeicao esperada). */
	expectError?: string;
	/** Caso da conversao: so conta como ok se a origem foi outro codec e saiu H.264 (sem aviso). */
	expectConversion?: true;
}

// URLs publicas de terceiros: se uma sumir, o smoke acusa e o caso e trocado por issue.
export const SMOKE_CASES: SmokeCase[] = [
	{ name: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", platform: "youtube", expect: "done" },
	{ name: "x", url: "https://x.com/oshtru/status/1577855540407197696", platform: "x", expect: "done" },
	{
		name: "x-sem-video",
		url: "https://x.com/jack/status/20",
		platform: "x",
		expect: "failed",
		expectError: "No video could be found",
	},
	{ name: "instagram-reel", url: "https://www.instagram.com/reel/CDUMkliABpa/", platform: "instagram", expect: "done" },
	{ name: "facebook-share", url: "https://www.facebook.com/share/v/19giuAapf3/", platform: "facebook", expect: "done" },
	// Link curto do app: exercita o resolvedor e o download do TikTok.
	{ name: "tiktok-curto", url: "https://vt.tiktok.com/ZSbpfF4Dp/", platform: "tiktok", expect: "done" },
	// ~10 min em VP9: exercita a conversao longa para H.264 em standard-4 dentro do prazo do job.
	{
		name: "facebook-conversao-longa",
		url: "https://www.facebook.com/watch/?v=1568541883795738",
		platform: "facebook",
		expect: "done",
		expectConversion: true,
	},
];

export interface SmokeIndex {
	add(entry: RecentEntry): Promise<void>;
	list(): Promise<RecentEntry[]>;
}

export interface SmokeDeps {
	cases: SmokeCase[];
	now(): number;
	uuid(): string;
	resolve(url: string): Promise<ResolvedVideoUrl>;
	createJob(job: JobRecord): Promise<void>;
	index(name: string): SmokeIndex;
	getJob(id: string): Promise<JobRecord | null>;
	fileExists(id: string): Promise<boolean>;
	send(subject: string, text: string): Promise<void>;
}

export interface SmokeResult {
	name: string;
	ok: boolean;
	detail: string;
}

export interface SmokeReport {
	ok: boolean;
	results: SmokeResult[];
}

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

// Id da rodada = hora cheia UTC do inicio. O scheduledTime da Cloudflare cai segundos depois do
// minuto agendado (deslocamento de alguns segundos, nao alinhado ao minuto), entao o id nao pode
// depender de igualdade exata. Invariante: so o minuto 0 inicia (cronKind), logo ha no maximo um
// inicio por hora; dois inicios na mesma hora (reentrega do evento) sao a mesma rodada. A checagem
// recalcula a hora a partir do proprio scheduledTime menos CHECK_OFFSET_MS, entao cada checagem
// julga exatamente a sua rodada, sem estado compartilhado (achados das R2/R3 do PR #9 e do
// consultor). Tolera atraso de ate 59 min em cada evento.
export const CHECK_OFFSET_MS = 50 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function roundStart(t: number): number {
	return Math.floor(t / HOUR_MS) * HOUR_MS;
}

export function runIdFor(roundStartMs: number): string {
	return String(roundStartMs);
}

export async function startSmoke(deps: SmokeDeps, scheduledTime: number): Promise<void> {
	const index = deps.index(SMOKE_INDEX);
	const runId = runIdFor(roundStart(scheduledTime));
	for (const c of deps.cases) {
		try {
			const now = deps.now();
			const resolved = await deps.resolve(c.url);
			const job: JobRecord = {
				id: deps.uuid(),
				platform: resolved.ok ? resolved.platform : c.platform,
				videoId: resolved.ok ? resolved.videoId : c.name,
				url: resolved.ok ? resolved.canonicalUrl : c.url,
				status: resolved.ok ? "queued" : "failed",
				attempts: 0,
				createdAt: now,
				updatedAt: now,
				smoke: smokeTag(runId, c.name),
			};
			if (!resolved.ok) job.error = `resolucao: ${resolved.error}`;
			await deps.createJob(job);
			await index.add({ id: job.id, createdAt: now });
		} catch (error) {
			// Um caso que nao inicia aparece como "nao iniciou" na checagem; os outros seguem.
			console.warn(`smoke: falha ao iniciar ${c.name}:`, message(error));
		}
	}
}

async function judge(c: SmokeCase, job: JobRecord | undefined, deps: SmokeDeps): Promise<SmokeResult> {
	if (!job) return { name: c.name, ok: false, detail: "nao iniciou (sem job nesta rodada)" };
	if (job.status === "queued" || job.status === "running") {
		return { name: c.name, ok: false, detail: `nao terminou a tempo (status ${job.status}, tentativas ${job.attempts})` };
	}
	if (job.status === "failed") {
		const detail = `failed: ${job.error ?? "sem mensagem"}`;
		// Falha de infraestrutura, resolucao ou bloqueio num caso negativo nao prova nada: so a
		// rejeicao esperada conta (achado P2 do PR #9).
		const expected = c.expect === "failed" && !!c.expectError && (job.error ?? "").includes(c.expectError);
		return { name: c.name, ok: expected, detail: expected ? detail : `${detail}${c.expect === "failed" ? " (nao e a rejeicao esperada)" : ""}` };
	}
	if (c.expect === "failed") return { name: c.name, ok: false, detail: "esperava falha, mas baixou" };
	if (!(await deps.fileExists(job.id))) return { name: c.name, ok: false, detail: "done, mas o arquivo nao esta no R2" };
	if (job.warning) return { name: c.name, ok: false, detail: `done com aviso: ${job.warning}` };
	const detail = `done, ${job.bytes ?? 0} bytes, ${job.attempts} tentativa(s)`;
	if (c.expectConversion) {
		// Sem aviso o arquivo saiu H.264; falta provar que a origem nao era H.264 (Kimi R1, PR #9).
		if (!job.sourceCodec || job.sourceCodec === "h264") {
			return { name: c.name, ok: false, detail: `${detail}; nao provou a conversao (codec de origem: ${job.sourceCodec ?? "desconhecido"})` };
		}
		return { name: c.name, ok: true, detail: `${detail}, ${job.sourceCodec} -> h264` };
	}
	return { name: c.name, ok: true, detail };
}

export async function checkSmoke(deps: SmokeDeps, scheduledTime: number): Promise<SmokeReport> {
	const runStart = roundStart(scheduledTime - CHECK_OFFSET_MS);
	const runId = runIdFor(runStart);
	// So entradas criadas depois do inicio desta rodada podem ser dela.
	const entries = (await deps.index(SMOKE_INDEX).list()).filter((e) => e.createdAt >= runStart);
	const ofRun = new Map<string, JobRecord[]>();
	let unreadable = 0;
	for (const entry of entries) {
		let job: JobRecord | null;
		try {
			job = await deps.getJob(entry.id);
		} catch {
			// Nao da para saber de que caso era: o relatorio falha em vez de supor.
			unreadable++;
			continue;
		}
		// Entrada sem job legivel (sumiu): resultado incerto, nunca supor.
		if (!job?.smoke) {
			unreadable++;
			continue;
		}
		// Etiqueta repetida (reentrega do evento de inicio): o caso so passa se todos passarem.
		if (job.smoke.startsWith(`${runId}/`)) ofRun.set(job.smoke, [...(ofRun.get(job.smoke) ?? []), job]);
	}
	const results: SmokeResult[] = [];
	if (unreadable > 0) {
		results.push({ name: "indice", ok: false, detail: `${unreadable} job(s) ilegiveis ou ausentes desde o inicio da rodada; resultado incerto` });
	}
	for (const c of deps.cases) {
		try {
			const jobs = ofRun.get(smokeTag(runId, c.name)) ?? [];
			const judged = jobs.length === 0 ? [await judge(c, undefined, deps)] : await Promise.all(jobs.map((j) => judge(c, j, deps)));
			const failed = judged.find((r) => !r.ok);
			results.push(failed ?? judged[0]);
		} catch (error) {
			results.push({ name: c.name, ok: false, detail: `erro ao conferir: ${message(error)}` });
		}
	}
	return { ok: results.every((r) => r.ok), results };
}

// HC-YYYYMMDD-HHMM em horario de Brasilia (UTC-3, sem horario de verao desde 2019).
export function trackingId(now: number): string {
	const d = new Date(now - 3 * 60 * 60 * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `HC-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export function reportEmail(report: SmokeReport, now: number): { subject: string; text: string } {
	const failed = report.results.filter((r) => !r.ok).length;
	const status = report.ok ? `OK ${report.results.length}/${report.results.length}` : `FALHA ${failed}/${report.results.length}`;
	const lines = report.results.map((r) => `${r.ok ? "ok    " : "FALHA "} ${r.name}: ${r.detail}`);
	const text = [
		`Smoke semanal do video-download (${trackingId(now)}).`,
		"",
		...lines,
		"",
		"Casos e criterios: src/smoke.ts. Falha de YouTube/Instagram/Facebook/TikTok costuma ser bloqueio ou mudanca",
		"de site: atualizar o yt-dlp (redeploy reconstroi a imagem) e, se preciso, ligar cookies (docs/operations.md).",
	].join("\n");
	return { subject: `[video-download] smoke ${status} ${trackingId(now)}`, text };
}

export async function runScheduled(cron: string, scheduledTime: number, deps: SmokeDeps): Promise<void> {
	const kind = cronKind(cron);
	// Evidencia para conferir o deslocamento real do scheduledTime nesta conta.
	console.log(`smoke: cron="${cron}" tipo=${kind} scheduledTime=${scheduledTime} agora=${deps.now()}`);
	if (kind === "start") {
		await startSmoke(deps, scheduledTime);
	} else if (kind === "check") {
		const report = await checkSmoke(deps, scheduledTime);
		const mail = reportEmail(report, deps.now());
		console.log(mail.subject);
		await deps.send(mail.subject, mail.text);
	}
}
