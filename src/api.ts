import { fileKey, JOB_ID, toPublicJob, type JobRecord } from "./job";
import { readLimitedText } from "./http";
import type { RecentEntry } from "./recent";
import { resolveVideoUrl, type Outbound } from "./share";
// API do baixador. Autenticacao fica na borda (Cloudflare Access no dominio do Worker,
// item 3 do epic #1); o Worker nao tem rota publica fora dela (workers_dev desligado).

export const MAX_BODY_BYTES = 4096;

export interface JobStub {
	create(job: JobRecord): Promise<JobRecord>;
	get(): Promise<JobRecord | null>;
}

// Subconjunto do Env usado pela API; o Worker real passa o Env completo (src/index.ts).
export interface IndexStub {
	add(entry: RecentEntry): Promise<void>;
	list(): Promise<RecentEntry[]>;
}

export const INDEX_NAME = "recent";

export interface ApiEnv {
	JOBS: { getByName(name: string): JobStub };
	JOB_INDEX: { getByName(name: string): IndexStub };
	FILES: { head(key: string): Promise<unknown | null>; get(key: string): Promise<R2ObjectBody | null> };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

async function createJob(request: Request, env: ApiEnv, outbound: Outbound): Promise<Response> {
	const raw = await readLimitedText(request, MAX_BODY_BYTES);
	if (!raw.ok) return json({ error: raw.error }, raw.status);
	let body: unknown;
	try {
		body = JSON.parse(raw.text);
	} catch {
		return json({ error: "Corpo JSON invalido." }, 400);
	}
	const parsed = await resolveVideoUrl((body as { url?: unknown } | null)?.url, outbound);
	if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

	const now = Date.now();
	const job: JobRecord = {
		id: crypto.randomUUID(),
		platform: parsed.platform,
		videoId: parsed.videoId,
		url: parsed.canonicalUrl,
		status: "queued",
		attempts: 0,
		createdAt: now,
		updatedAt: now,
	};
	const stored = await env.JOBS.getByName(job.id).create(job);
	try {
		await env.JOB_INDEX.getByName(INDEX_NAME).add({ id: stored.id, createdAt: stored.createdAt });
	} catch (error) {
		// O job ja existe e roda; so nao aparece na lista apos recarregar. Nao vale falhar o envio.
		console.warn("falha ao indexar job:", error instanceof Error ? error.message : error);
	}
	return json(toPublicJob(stored, false, ""), 202);
}

async function publicJob(id: string, env: ApiEnv) {
	const job = await env.JOBS.getByName(id).get();
	if (!job) return null;
	const exists = job.status === "done" ? (await env.FILES.head(fileKey(id))) !== null : false;
	return toPublicJob(job, exists, "");
}

async function listJobs(env: ApiEnv): Promise<Response> {
	const entries = await env.JOB_INDEX.getByName(INDEX_NAME).list();
	const jobs = await Promise.all(entries.map((e) => publicJob(e.id, env).catch(() => null)));
	return json({ jobs: jobs.filter((j) => j !== null) });
}

async function getJob(id: string, env: ApiEnv): Promise<Response> {
	const job = await env.JOBS.getByName(id).get();
	if (!job) return json({ error: "Job nao encontrado ou expirado." }, 404);
	const exists = job.status === "done" ? (await env.FILES.head(fileKey(id))) !== null : false;
	return json(toPublicJob(job, exists, ""));
}

async function getFile(id: string, env: ApiEnv): Promise<Response> {
	// So serve o arquivo de um job done que ainda existe: depois da limpeza (estado apagado), um
	// objeto que o lifecycle do bucket ainda nao removeu nao sai por esta rota (A4).
	const job = await env.JOBS.getByName(id).get();
	if (job?.status !== "done") return json({ error: "Arquivo nao encontrado ou expirado." }, 404);
	const object = await env.FILES.get(fileKey(id));
	if (!object) return json({ error: "Arquivo nao encontrado ou expirado." }, 404);
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("content-length", String(object.size));
	headers.set("cache-control", "private, no-store");
	return new Response(object.body, { headers });
}

// Unica saida de rede do Worker a partir de entrada do usuario: resolver links de compartilhamento
// (src/share.ts). A outra, fixa, e a busca das chaves do Access (src/access.ts).
const defaultOutbound: Outbound = (url, init) => fetch(url, init);

export async function handleApi(request: Request, env: ApiEnv, outbound: Outbound = defaultOutbound): Promise<Response> {
	const { pathname } = new URL(request.url);

	if (pathname === "/api/jobs") {
		if (request.method === "GET") return listJobs(env);
		if (request.method !== "POST") return json({ error: "Metodo nao permitido." }, 405);
		return createJob(request, env, outbound);
	}

	const route = pathname.match(/^\/api\/(jobs|files)\/([^/]+)$/);
	if (route) {
		if (request.method !== "GET") return json({ error: "Metodo nao permitido." }, 405);
		const [, kind, id] = route;
		if (!JOB_ID.test(id)) return json({ error: "ID invalido." }, 400);
		return kind === "jobs" ? getJob(id, env) : getFile(id, env);
	}

	return json({ error: "Nao encontrado." }, 404);
}
