// Estado de um job e a interpretacao da resposta do container. Puro, testavel sem runtime.

import type { Platform } from "./urls";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
	id: string;
	platform: Platform;
	videoId: string;
	url: string;
	status: JobStatus;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	title?: string;
	ext?: string;
	bytes?: number;
	error?: string;
	/** Arquivo entregue fora do padrao H.264+AAC (conversao nao coube no prazo ou falhou). */
	warning?: string;
	/** Codec do video baixado, antes da conversao (ffprobe no container). Prova a conversao no smoke. */
	sourceCodec?: string;
	/** Dimensoes do arquivo entregue. */
	width?: number;
	height?: number;
	/** "<rodada>/<caso>" do smoke semanal (src/smoke.ts); ausente em jobs do usuario. */
	smoke?: string;
	/**
	 * Email (Access) de quem criou o job: so essa pessoa ve o job, a lista e o arquivo. Ausente em
	 * jobs do smoke e nos criados antes da separacao por usuario.
	 */
	owner?: string;
}

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function fileKey(jobId: string): string {
	return `files/${jobId}`;
}

export interface DeliveryMeta {
	sourceCodec?: string;
	width?: number;
	height?: number;
}

export type ContainerResult =
	| ({ ok: true; title: string; ext: string; bytes: number; warning?: string } & DeliveryMeta)
	| { ok: false; error: string };

const CODEC = /^[a-z0-9_.-]{1,20}$/;
const SIZE = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/;
const MAX_SIDE_PX = 16384;

/** Le "LxA" (header x-video-size ou customMetadata size); valores fora do formato sao ignorados. */
export function parseSize(value: string | null | undefined): { width: number; height: number } | null {
	const m = SIZE.exec(value ?? "");
	if (!m) return null;
	const [width, height] = [Number(m[1]), Number(m[2])];
	return width <= MAX_SIDE_PX && height <= MAX_SIDE_PX ? { width, height } : null;
}

/** Codec de origem e tamanho, validados, a partir do header ou do customMetadata do R2. */
export function parseDeliveryMeta(codec: string | null | undefined, size: string | null | undefined): DeliveryMeta {
	const out: DeliveryMeta = {};
	const c = (codec ?? "").trim().toLowerCase();
	if (CODEC.test(c)) out.sourceCodec = c;
	const dims = parseSize(size);
	if (dims) Object.assign(out, dims);
	return out;
}

// Orcamento do customMetadata do R2 em bytes UTF-8 (chaves + valores). Conservador: o R2 local
// (miniflare) recusa acima de 2 KiB (R1 Kimi, PR #14).
export const METADATA_BUDGET_BYTES = 2048;

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

function metadataBytes(meta: Record<string, string>): number {
	return Object.entries(meta).reduce((sum, [k, v]) => sum + utf8(k) + utf8(v), 0);
}

/** Cabe o customMetadata no orcamento cortando, por code point, primeiro o titulo e depois o aviso. */
export function fitMetadata(meta: Record<string, string>, budget = METADATA_BUDGET_BYTES): Record<string, string> {
	const out = { ...meta };
	for (const key of ["title", "warning"]) {
		if (metadataBytes(out) <= budget || out[key] === undefined) continue;
		const excess = metadataBytes(out) - budget;
		const chars = Array.from(out[key]);
		let removed = 0;
		while (chars.length > 0 && removed < excess) removed += utf8(chars.pop()!);
		out[key] = chars.join("");
	}
	return out;
}

/** customMetadata do R2 para os mesmos campos (a reconciliacao le de volta com parseDeliveryMeta). */
export function deliveryMetadata(meta: DeliveryMeta): Record<string, string> {
	const out: Record<string, string> = {};
	if (meta.sourceCodec) out.sourceCodec = meta.sourceCodec;
	if (meta.width && meta.height) out.size = `${meta.width}x${meta.height}`;
	return out;
}

// R2 limita o customMetadata a 2 KiB no total (titulo ate 300 caracteres, URL, aviso).
const MAX_WARNING = 200;
const GENERIC_WARNING = "O video pode nao estar em H.264; pode nao abrir no QuickTime nem no app Fotos.";

// Le os headers de sucesso do container. Content-Length e obrigatorio: o R2 so aceita
// stream de tamanho conhecido, e um tamanho ausente indicaria resposta truncada.
export function parseContainerSuccess(headers: Headers): ContainerResult {
	const lengthHeader = headers.get("content-length");
	const bytes = lengthHeader === null ? NaN : Number(lengthHeader);
	if (!Number.isSafeInteger(bytes) || bytes <= 0) {
		return { ok: false, error: "Container respondeu sem tamanho de arquivo valido." };
	}
	let title = "";
	try {
		title = decodeURIComponent(headers.get("x-title") ?? "");
	} catch {
		title = "";
	}
	const extHeader = (headers.get("x-ext") ?? "").toLowerCase();
	const ext = /^[a-z0-9]{1,5}$/.test(extHeader) ? extHeader : "mp4";
	const result: ContainerResult = {
		ok: true,
		title,
		ext,
		bytes,
		...parseDeliveryMeta(headers.get("x-source-codec"), headers.get("x-video-size")),
	};
	const warningHeader = headers.get("x-warning");
	if (warningHeader !== null) {
		let warning: string;
		try {
			warning = decodeURIComponent(warningHeader).trim();
		} catch {
			warning = "";
		}
		// Aviso ilegivel nao pode sumir: o arquivo continua fora do padrao.
		result.warning = Array.from(warning || GENERIC_WARNING).slice(0, MAX_WARNING).join("");
	}
	return result;
}

// Mensagem de erro do container (JSON {error}) ou texto bruto truncado, para a UI mostrar
// o motivo real em vez de "erro desconhecido".
export function containerErrorMessage(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
			return parsed.error.trim().slice(0, 1000);
		}
	} catch {
		// corpo nao era JSON
	}
	const text = body.trim().slice(0, 500);
	return text === "" ? `Container respondeu HTTP ${status} sem detalhe.` : `HTTP ${status}: ${text}`;
}

export interface PublicJob {
	id: string;
	platform: Platform;
	url: string;
	status: JobStatus | "expired";
	title?: string;
	bytes?: number;
	error?: string;
	warning?: string;
	/** Resolucao entregue pelo lado menor ("720p"): pode ficar abaixo de 1080p quando so ha H.264 menor. */
	resolution?: string;
	fileUrl?: string;
	createdAt: number;
	updatedAt: number;
}

export function toPublicJob(job: JobRecord, fileExists: boolean, basePath: string): PublicJob {
	const out: PublicJob = {
		id: job.id,
		platform: job.platform,
		url: job.url,
		status: job.status,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
	if (job.title) out.title = job.title;
	if (job.bytes !== undefined) out.bytes = job.bytes;
	if (job.error) out.error = job.error;
	if (job.warning) out.warning = job.warning;
	if (job.width && job.height) out.resolution = `${Math.min(job.width, job.height)}p`;
	if (job.status === "done") {
		if (fileExists) out.fileUrl = `${basePath}/api/files/${job.id}`;
		else out.status = "expired";
	}
	return out;
}
