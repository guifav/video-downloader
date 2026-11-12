import { FACEBOOK_HOSTS, parseVideoUrl, TIKTOK_HOSTS, TIKTOK_SHORT_HOSTS, type ParsedVideoUrl, type Platform } from "./urls";

// Links de compartilhamento do app do Facebook (facebook.com/share/v|r/<token>) sao opacos: so viram
// URL de video seguindo o redirect do proprio site. O Worker faz isso antes de criar o job, sem nunca
// buscar uma URL arbitraria: cada salto e reconstruido a partir do token, sempre em www.facebook.com,
// e o destino final passa por parseVideoUrl. share/p (post) fica de fora ate haver caso medido.
// Links curtos do app do TikTok (vm.tiktok.com/<codigo>, vt.tiktok.com/<codigo>, tiktok.com/t/<codigo>)
// seguem o mesmo caminho: um 301/302 para www.tiktok.com/@usuario/video/<id>.

export type Outbound = (url: string, init: RequestInit) => Promise<Response>;

export type ResolvedVideoUrl =
	| Extract<ParsedVideoUrl, { ok: true }>
	| { ok: false; error: string; status: 400 | 503 };

function direct(input: unknown): ResolvedVideoUrl {
	const parsed = parseVideoUrl(input);
	return parsed.ok ? parsed : { ok: false, error: parsed.error, status: 400 };
}

export const SHARE_MAX_HOPS = 3;
export const SHARE_TIMEOUT_MS = 8000;
// Com user-agent de navegador o Facebook responde 200 (pagina) ou "unsupportedbrowser"; sem
// navegador, responde o 302 para o video. Medido a partir da egress Cloudflare (issue #6).
export const SHARE_USER_AGENT = "curl/8.5.0";

const TOKEN = /^[A-Za-z0-9_-]{4,64}$/;
const SHARE_KINDS = new Set(["v", "r"]);

const NOT_A_VIDEO =
	"O link de compartilhamento nao leva a um video publico (pode exigir login ou ser foto, perfil ou pagina). Abra o link e cole o endereco do video.";
const TRANSIENT = "Nao foi possivel abrir o link de compartilhamento agora; tente de novo.";

type ShareLink = { url: string; platform: Platform } | { invalid: true; platform: Platform } | null;

const INVALID: Record<string, string> = {
	facebook: "Link de compartilhamento do Facebook invalido ou nao suportado (so video e reel).",
	tiktok: "Link curto do TikTok invalido.",
};

function asUrl(input: string, base?: string): URL | null {
	try {
		return base ? new URL(input, base) : new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
	} catch {
		return null;
	}
}

// Reconhece um link de compartilhamento e devolve a URL canonica a buscar, ou null se nao for um.
export function shareLink(url: URL): ShareLink {
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	if (TIKTOK_SHORT_HOSTS.has(host)) {
		const code = url.pathname.match(/^\/([^/]+)\/?$/);
		if (!code || !TOKEN.test(code[1])) return { invalid: true, platform: "tiktok" };
		return { url: `https://${host}/${code[1]}/`, platform: "tiktok" };
	}
	if (TIKTOK_HOSTS.has(host) && /^\/t\//.test(url.pathname)) {
		const code = url.pathname.match(/^\/t\/([^/]+)\/?$/);
		if (!code || !TOKEN.test(code[1])) return { invalid: true, platform: "tiktok" };
		return { url: `https://www.tiktok.com/t/${code[1]}/`, platform: "tiktok" };
	}
	if (!FACEBOOK_HOSTS.has(host) || !/^\/share\//.test(url.pathname)) return null;
	const match = url.pathname.match(/^\/share\/([a-z]+)\/([^/]+)\/?$/);
	if (!match || !SHARE_KINDS.has(match[1]) || !TOKEN.test(match[2])) return { invalid: true, platform: "facebook" };
	return { url: `https://www.facebook.com/share/${match[1]}/${match[2]}/`, platform: "facebook" };
}

function isTransientStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

export async function resolveVideoUrl(input: unknown, outbound: Outbound): Promise<ResolvedVideoUrl> {
	if (typeof input !== "string") return direct(input);
	const first = asUrl(input.trim());
	const link = first && input.length <= 2048 ? shareLink(first) : null;
	if (!link) return direct(input);
	if ("invalid" in link) return { ok: false, error: INVALID[link.platform], status: 400 };

	let current = link.url;
	for (let hop = 0; hop < SHARE_MAX_HOPS; hop++) {
		let response: Response;
		try {
			response = await outbound(current, {
				method: "GET",
				redirect: "manual",
				headers: { "user-agent": SHARE_USER_AGENT, accept: "text/html" },
				signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
			});
		} catch {
			return { ok: false, error: TRANSIENT, status: 503 };
		}
		response.body?.cancel().catch(() => {});
		if (isTransientStatus(response.status)) return { ok: false, error: TRANSIENT, status: 503 };
		const location = response.headers.get("location");
		if (response.status < 300 || response.status > 399 || !location) {
			return { ok: false, error: NOT_A_VIDEO, status: 400 };
		}
		const target = asUrl(location, current);
		if (!target) return { ok: false, error: NOT_A_VIDEO, status: 400 };
		const next = shareLink(target);
		if (next && !("invalid" in next) && next.platform === link.platform) {
			current = next.url;
			continue;
		}
		const parsed = parseVideoUrl(target.toString());
		if (parsed.ok && parsed.platform === link.platform) return parsed;
		return { ok: false, error: NOT_A_VIDEO, status: 400 };
	}
	return { ok: false, error: NOT_A_VIDEO, status: 400 };
}
