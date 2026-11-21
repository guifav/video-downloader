// Envio de arquivos proprios (gravacoes em audio ou video) para o R2, em partes, sem o limite de
// corpo de requisicao da Cloudflare: o navegador corta o arquivo em partes de PART_SIZE e cada parte
// e uma requisicao. Opcional e desligado por padrao (UPLOAD_EMAILS vazio).
//
// Quem envia: so os emails de UPLOAD_EMAILS. Cada arquivo pertence a quem enviou e so essa pessoa o
// ve. UPLOAD_SHARES deixa uma credencial de servico do Access (ACCESS_SERVICE_TOKENS) ler os envios
// de um dono especifico, e so os dele: "estudio=you@example.com".

import { contentDisposition } from "./files";
import { readLimitedText } from "./http";
import { JOB_ID } from "./job";

export const PART_SIZE = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ETAG = 1024;
// Conclusao: uma entrada por parte, com a etag (opaca; 171 caracteres no R2 hoje) e o numero.
const MAX_COMPLETE_BYTES = Math.ceil(MAX_UPLOAD_BYTES / PART_SIZE) * (MAX_ETAG + 64) + 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MIME = /^(video|audio)\/[a-z0-9.+-]{1,40}$/;
const ETAG = new RegExp(`^[\\x21-\\x7e]{1,${MAX_ETAG}}$`); // opaca: o R2 local e o real usam formatos diferentes
const MAX_NAME = 120;

export const uploadKey = (id: string) => `uploads/${id}`;
const pendingKey = (id: string) => `uploads-pending/${id}`;

/** Subconjunto do R2Bucket usado aqui (o Worker passa o binding real; os testes, um falso). */
export interface UploadBucket {
	get(key: string): Promise<R2ObjectBody | null>;
	head(key: string): Promise<R2Object | null>;
	put(key: string, value: string): Promise<unknown>;
	delete(key: string): Promise<void>;
	list(options: R2ListOptions): Promise<R2Objects>;
	createMultipartUpload(key: string, options: R2MultipartOptions): Promise<R2MultipartUpload>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

export interface UploadEnv {
	FILES: UploadBucket;
	UPLOAD_EMAILS?: string;
	UPLOAD_SHARES?: string;
}

export interface UploadConfig {
	uploaders: string[];
	/** leitor (identidade do Access) -> donos cujos envios ele pode ler */
	shares: Map<string, string[]>;
}

export function uploadConfigFromEnv(env: { UPLOAD_EMAILS?: string; UPLOAD_SHARES?: string }): UploadConfig {
	const uploaders = (env.UPLOAD_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	const shares = new Map<string, string[]>();
	for (const pair of (env.UPLOAD_SHARES ?? "").split(",")) {
		const [reader, owner] = pair.split("=").map((s) => (s ?? "").trim().toLowerCase());
		// So o dono que tambem pode enviar: um compartilhamento nao abre nada alem dos envios dele.
		if (!reader || !owner || !uploaders.includes(owner)) continue;
		const key = `service:${reader}`;
		shares.set(key, [...(shares.get(key) ?? []), owner]);
	}
	return { uploaders, shares };
}

interface Pending {
	owner: string;
	uploadId: string;
	name: string;
	type: string;
	size: number;
	ref: string;
	parts: number;
	createdAt: number;
}

export interface PublicUpload {
	id: string;
	name: string;
	ref: string;
	type: string;
	size: number;
	createdAt: number;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

const notFound = () => json({ error: "Envio nao encontrado ou expirado." }, 404);

function cleanName(raw: unknown): string {
	const name = (typeof raw === "string" ? raw : "")
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(name).slice(0, MAX_NAME).join("") || "gravacao";
}

function expectedPartSize(p: Pending, n: number): number {
	return n < p.parts ? PART_SIZE : p.size - PART_SIZE * (p.parts - 1);
}

async function readJson(
	request: Request,
	limit = MAX_JSON_BYTES,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
	const raw = await readLimitedText(request, limit);
	if (!raw.ok) return { ok: false, res: json({ error: raw.error }, raw.status) };
	try {
		const body: unknown = JSON.parse(raw.text);
		if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("nao e objeto");
		return { ok: true, body: body as Record<string, unknown> };
	} catch {
		return { ok: false, res: json({ error: "Corpo JSON invalido." }, 400) };
	}
}

async function loadPending(env: UploadEnv, id: string, user: string): Promise<Pending | null> {
	const obj = await env.FILES.get(pendingKey(id));
	if (!obj) return null;
	const p = (await obj.json()) as Pending;
	return p.owner === user ? p : null;
}

function toPublic(id: string, meta: Record<string, string>, size: number, type: string): PublicUpload {
	return { id, name: meta.name ?? "", ref: meta.ref ?? "", type, size, createdAt: Number(meta.createdAt) || 0 };
}

async function create(request: Request, env: UploadEnv, user: string): Promise<Response> {
	const read = await readJson(request);
	if (!read.ok) return read.res;
	const { size, type, ref } = read.body;
	if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES)
		return json({ error: "Tamanho invalido (maximo 20 GB)." }, 400);
	const mime = typeof type === "string" ? type.trim().toLowerCase() : "";
	if (!MIME.test(mime)) return json({ error: "So arquivos de audio ou video." }, 400);
	const reference = typeof ref === "string" ? ref.trim().toUpperCase() : "";
	if (reference !== "" && !REF.test(reference)) return json({ error: "Referencia invalida (letras, numeros, . _ -; ate 40)." }, 400);

	const id = crypto.randomUUID();
	const name = cleanName(read.body.name);
	const createdAt = Date.now();
	const upload = await env.FILES.createMultipartUpload(uploadKey(id), {
		httpMetadata: { contentType: mime },
		customMetadata: { owner: user, name, ref: reference, createdAt: String(createdAt) },
	});
	const parts = Math.ceil(size / PART_SIZE);
	const pending: Pending = { owner: user, uploadId: upload.uploadId, name, type: mime, size, ref: reference, parts, createdAt };
	await env.FILES.put(pendingKey(id), JSON.stringify(pending));
	return json({ id, partSize: PART_SIZE, parts }, 201);
}

async function putPart(request: Request, env: UploadEnv, user: string, id: string, n: number): Promise<Response> {
	const pending = await loadPending(env, id, user);
	if (!pending) {
		await request.body?.cancel();
		return notFound();
	}
	if (!Number.isInteger(n) || n < 1 || n > pending.parts) {
		await request.body?.cancel();
		return json({ error: "Parte invalida." }, 400);
	}
	const expected = expectedPartSize(pending, n);
	if (request.headers.get("content-length") !== String(expected) || !request.body) {
		await request.body?.cancel();
		return json({ error: `A parte ${n} deve ter ${expected} bytes.` }, 400);
	}
	try {
		const part = await env.FILES.resumeMultipartUpload(uploadKey(id), pending.uploadId).uploadPart(n, request.body);
		return json({ partNumber: part.partNumber, etag: part.etag });
	} catch (error) {
		// Corpo cortado no meio ou falha do R2: a mesma parte pode ser reenviada.
		console.warn("falha ao gravar parte:", error instanceof Error ? error.message : error);
		return json({ error: "Falha ao gravar a parte; tente de novo." }, 502);
	}
}

async function complete(request: Request, env: UploadEnv, user: string, id: string): Promise<Response> {
	const pending = await loadPending(env, id, user);
	if (!pending) return notFound();
	const read = await readJson(request, MAX_COMPLETE_BYTES);
	if (!read.ok) return read.res;
	const parts = read.body.parts;
	if (
		!Array.isArray(parts) ||
		parts.length !== pending.parts ||
		!parts.every(
			(p, i) =>
				typeof p === "object" &&
				p !== null &&
				(p as R2UploadedPart).partNumber === i + 1 &&
				typeof (p as R2UploadedPart).etag === "string" &&
				ETAG.test((p as R2UploadedPart).etag),
		)
	)
		return json({ error: "Lista de partes invalida." }, 400);
	const list = (parts as R2UploadedPart[]).map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
	try {
		await env.FILES.resumeMultipartUpload(uploadKey(id), pending.uploadId).complete(list);
	} catch (error) {
		console.warn("falha ao concluir envio:", error instanceof Error ? error.message : error);
		return json({ error: "Falha ao concluir o envio; confira as partes e tente de novo." }, 502);
	}
	const head = await env.FILES.head(uploadKey(id));
	if (!head || head.size !== pending.size) {
		await env.FILES.delete(uploadKey(id));
		await env.FILES.delete(pendingKey(id));
		return json({ error: "O arquivo montado nao tem o tamanho enviado; envie de novo." }, 400);
	}
	await env.FILES.delete(pendingKey(id));
	return json(toPublic(id, head.customMetadata ?? {}, head.size, pending.type), 201);
}

function readableOwners(config: UploadConfig, user: string): string[] {
	return [...(config.uploaders.includes(user) ? [user] : []), ...(config.shares.get(user) ?? [])];
}

async function list(request: Request, env: UploadEnv, config: UploadConfig, user: string): Promise<Response> {
	const owners = readableOwners(config, user);
	if (owners.length === 0) return json({ error: "Envio de arquivos nao habilitado para esta conta." }, 403);
	const ref = (new URL(request.url).searchParams.get("ref") ?? "").trim().toUpperCase();
	const out: PublicUpload[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.FILES.list({ prefix: "uploads/", cursor, include: ["customMetadata", "httpMetadata"] } as R2ListOptions);
		for (const o of page.objects) {
			const meta = o.customMetadata ?? {};
			if (!owners.includes(meta.owner ?? "")) continue;
			if (ref !== "" && meta.ref !== ref) continue;
			out.push(toPublic(o.key.slice("uploads/".length), meta, o.size, o.httpMetadata?.contentType ?? ""));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	out.sort((a, b) => b.createdAt - a.createdAt);
	return json({ uploads: out });
}

async function file(env: UploadEnv, config: UploadConfig, user: string, id: string): Promise<Response> {
	const obj = await env.FILES.get(uploadKey(id));
	if (!obj || !readableOwners(config, user).includes(obj.customMetadata?.owner ?? "")) {
		await obj?.body.cancel();
		return notFound();
	}
	const name = obj.customMetadata?.name ?? "gravacao";
	const dot = name.lastIndexOf(".");
	const headers = new Headers();
	headers.set("content-type", obj.httpMetadata?.contentType ?? "application/octet-stream");
	headers.set("content-length", String(obj.size));
	headers.set("content-disposition", contentDisposition(dot > 0 ? name.slice(0, dot) : name, "gravacao", dot > 0 ? name.slice(dot + 1) : "bin"));
	headers.set("cache-control", "private, no-store");
	return new Response(obj.body, { headers });
}

/** Rotas /api/uploads*. Devolve null se o caminho nao e deste modulo. */
export async function handleUploads(request: Request, env: UploadEnv, user: string): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (pathname !== "/api/uploads" && !pathname.startsWith("/api/uploads/")) return null;
	const config = uploadConfigFromEnv(env);
	const canUpload = config.uploaders.includes(user);
	const m = request.method;

	if (pathname === "/api/uploads") {
		if (m === "GET") return list(request, env, config, user);
		if (m !== "POST") return json({ error: "Metodo nao permitido." }, 405);
		if (!canUpload) return json({ error: "Envio de arquivos nao habilitado para esta conta." }, 403);
		return create(request, env, user);
	}
	const route = pathname.match(/^\/api\/uploads\/([^/]+)(?:\/(file|complete|parts\/([0-9]{1,5})))?$/);
	if (!route || !JOB_ID.test(route[1])) return json({ error: "Nao encontrado." }, 404);
	const [, id, action, part] = route;
	if (action === "file" && m === "GET") return file(env, config, user, id);
	if (!canUpload) {
		await request.body?.cancel();
		return json({ error: "Envio de arquivos nao habilitado para esta conta." }, 403);
	}
	if (part !== undefined && m === "PUT") return putPart(request, env, user, id, Number(part));
	if (action === "complete" && m === "POST") return complete(request, env, user, id);
	await request.body?.cancel();
	return json({ error: "Metodo nao permitido." }, 405);
}
