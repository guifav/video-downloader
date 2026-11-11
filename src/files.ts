// Nome de arquivo para o header Content-Disposition a partir do titulo do video.

const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;
const MAX_BASENAME = 120;

export function safeBasename(title: string | null | undefined, fallback: string): string {
	const cleaned = (title ?? "")
		.normalize("NFC")
		.replace(FORBIDDEN, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	const base = cleaned === "" ? fallback : cleaned;
	// Corta por code point para nao partir surrogate pairs (emoji em titulos).
	const chars = Array.from(base);
	return chars.length > MAX_BASENAME ? chars.slice(0, MAX_BASENAME).join("").trim() : base;
}

function asciiFallback(name: string): string {
	const ascii = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/["\\]/g, "_");
	return ascii.trim() === "" ? "video" : ascii;
}

function rfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDisposition(title: string | null | undefined, fallback: string, ext: string): string {
	const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "mp4";
	const name = `${safeBasename(title, fallback)}.${safeExt}`;
	return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}
