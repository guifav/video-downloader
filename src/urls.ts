// Decisao unica sobre quais URLs o sistema aceita. O Worker rejeita tudo que nao passar
// aqui antes de criar job ou acordar container; o container repete a checagem de host.

export type Platform = "youtube" | "x" | "instagram" | "facebook" | "tiktok";

export type ParsedVideoUrl =
	| { ok: true; platform: Platform; videoId: string; canonicalUrl: string }
	| { ok: false; error: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTU_BE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const X_HOSTS = new Set([
	"x.com",
	"www.x.com",
	"mobile.x.com",
	"twitter.com",
	"www.twitter.com",
	"mobile.twitter.com",
]);

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
export const FACEBOOK_HOSTS = new Set([
	"facebook.com",
	"www.facebook.com",
	"m.facebook.com",
	"web.facebook.com",
	"mbasic.facebook.com",
]);
const FB_WATCH_HOSTS = new Set(["fb.watch", "www.fb.watch"]);
export const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
// Links curtos do app do TikTok (vm/vt.tiktok.com/<codigo> e tiktok.com/t/<codigo>): src/share.ts resolve.
export const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
// Instagram: /p|reel|reels|tv/<shortcode>/, opcionalmente com o usuario na frente.
const INSTAGRAM_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,64})\/?$/;
const SHARE_PATH = /^\/share\//;
const FB_NUMERIC = /^\d{1,25}$/;
const FB_NAME = /^[A-Za-z0-9.\-_]{1,80}$/;
// TikTok: /@usuario/video/<id>. O usuario pode vir vazio (/@/video/<id>), forma que o proprio link
// curto do app produz e que o yt-dlp aceita.
const TIKTOK_VIDEO_PATH = /^\/@([\w.-]{0,64})\/video\/(\d{8,25})\/?$/;
const X_STATUS_PATH = /^\/([A-Za-z0-9_]{1,15}|i)\/status\/(\d{1,25})(?:\/video\/([1-4]))?\/?$/;

export const UNSUPPORTED =
	"URL nao suportada. Use um video do YouTube, um post do X com video, um post ou reel do Instagram, um video ou reel do Facebook ou um video do TikTok.";
const TIKTOK_NOT_VIDEO = "Link do TikTok precisa apontar para um video (tiktok.com/@usuario/video/...). Fotos, perfis e lives nao sao suportados.";
const TIKTOK_SHORT_UNRESOLVED = "Link curto do TikTok precisa ser resolvido antes; envie pelo formulario.";
const INSTAGRAM_NOT_VIDEO = "Link do Instagram precisa apontar para um post, reel ou IGTV (instagram.com/reel/...).";
const FACEBOOK_NOT_VIDEO =
	"Link do Facebook precisa apontar para um video ou reel. No Facebook, abra o video e use Compartilhar > Copiar link.";
const FACEBOOK_SHARE_UNRESOLVED = "Link de compartilhamento do Facebook precisa ser resolvido antes; envie pelo formulario.";
const INSTAGRAM_SHARE =
	"Links de compartilhamento do Instagram (instagram.com/share/...) ainda nao sao suportados. Abra o link e copie o endereco do post ou reel.";

function youtube(videoId: string | null | undefined): ParsedVideoUrl {
	if (!videoId || !YOUTUBE_ID.test(videoId)) {
		return { ok: false, error: "ID de video do YouTube invalido." };
	}
	return {
		ok: true,
		platform: "youtube",
		videoId,
		canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
	};
}

export function parseVideoUrl(input: unknown): ParsedVideoUrl {
	if (typeof input !== "string" || input.trim() === "") {
		return { ok: false, error: "Informe a URL do video." };
	}
	const raw = input.trim();
	if (raw.length > 2048) return { ok: false, error: "URL longa demais." };

	let url: URL;
	try {
		url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		return { ok: false, error: "URL invalida." };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { ok: false, error: "URL invalida." };
	}
	if (url.username || url.password || url.port) {
		return { ok: false, error: "URL invalida." };
	}
	const host = url.hostname.toLowerCase();
	const path = url.pathname;

	if (YOUTUBE_HOSTS.has(host)) {
		if (path === "/watch") return youtube(url.searchParams.get("v"));
		const short = path.match(/^\/(shorts|live|embed)\/([^/]+)\/?$/);
		if (short) return youtube(short[2]);
		if (path === "/playlist") {
			return { ok: false, error: "Playlists nao sao suportadas; envie um video avulso." };
		}
		return { ok: false, error: "Link do YouTube nao aponta para um video avulso." };
	}

	if (YOUTU_BE_HOSTS.has(host)) {
		const id = path.replace(/^\//, "").replace(/\/$/, "");
		return youtube(id);
	}

	if (INSTAGRAM_HOSTS.has(host)) return instagram(path);
	if (FACEBOOK_HOSTS.has(host)) return facebook(path, url.searchParams);
	if (FB_WATCH_HOSTS.has(host)) {
		return {
			ok: false,
			error: "Links fb.watch exigem login no Facebook. No Facebook, abra o video e use Compartilhar > Copiar link.",
		};
	}

	if (TIKTOK_SHORT_HOSTS.has(host)) return { ok: false, error: TIKTOK_SHORT_UNRESOLVED };
	if (TIKTOK_HOSTS.has(host)) return tiktok(path);

	if (X_HOSTS.has(host)) {
		const match = path.match(X_STATUS_PATH);
		if (!match) {
			return { ok: false, error: "Link do X precisa apontar para um post (/usuario/status/ID)." };
		}
		const [, user, statusId, videoIndex] = match;
		const suffix = videoIndex ? `/video/${videoIndex}` : "";
		return {
			ok: true,
			platform: "x",
			videoId: videoIndex ? `${statusId}-${videoIndex}` : statusId,
			canonicalUrl: `https://x.com/${user}/status/${statusId}${suffix}`,
		};
	}

	return { ok: false, error: UNSUPPORTED };
}

function instagram(path: string): ParsedVideoUrl {
	if (/^\/stories\//.test(path)) return { ok: false, error: "Stories nao sao suportados; envie um post ou reel." };
	if (SHARE_PATH.test(path)) return { ok: false, error: INSTAGRAM_SHARE };
	const match = path.match(INSTAGRAM_PATH);
	if (!match) return { ok: false, error: INSTAGRAM_NOT_VIDEO };
	const kind = match[1] === "reels" ? "reel" : match[1];
	const code = match[2];
	return { ok: true, platform: "instagram", videoId: code, canonicalUrl: `https://www.instagram.com/${kind}/${code}/` };
}

function tiktok(path: string): ParsedVideoUrl {
	if (/^\/t\//.test(path)) return { ok: false, error: TIKTOK_SHORT_UNRESOLVED };
	const match = path.match(TIKTOK_VIDEO_PATH);
	if (!match) return { ok: false, error: TIKTOK_NOT_VIDEO };
	const [, user, id] = match;
	return { ok: true, platform: "tiktok", videoId: id, canonicalUrl: `https://www.tiktok.com/@${user}/video/${id}` };
}

function facebookVideo(id: string | null): ParsedVideoUrl {
	if (!id || !FB_NUMERIC.test(id)) return { ok: false, error: FACEBOOK_NOT_VIDEO };
	return { ok: true, platform: "facebook", videoId: id, canonicalUrl: `https://www.facebook.com/watch/?v=${id}` };
}

// Facebook: so video e reel. Posts, grupos, permalink.php/story.php e lives ficam de fora ate
// haver caso real medido da egress Cloudflare (consulta da issue #6).
function facebook(path: string, query: URLSearchParams): ParsedVideoUrl {
	if (/^\/stories\//.test(path)) return { ok: false, error: "Stories nao sao suportados; envie um video ou reel." };
	if (SHARE_PATH.test(path)) return { ok: false, error: FACEBOOK_SHARE_UNRESOLVED };
	if (/^\/watch\/?$/.test(path) || path === "/video.php") return facebookVideo(query.get("v"));

	const reel = path.match(/^\/reel\/([^/]+)\/?$/);
	if (reel) {
		if (!FB_NUMERIC.test(reel[1])) return { ok: false, error: FACEBOOK_NOT_VIDEO };
		return { ok: true, platform: "facebook", videoId: reel[1], canonicalUrl: `https://www.facebook.com/reel/${reel[1]}` };
	}

	// /<pagina>/videos/<id> ou /<pagina>/videos/<slug>/<id>
	const parts = path.replace(/^\/|\/$/g, "").split("/");
	if (parts.length >= 3 && parts.length <= 4 && parts[1] === "videos" && FB_NAME.test(parts[0])) {
		return facebookVideo(parts[parts.length - 1]);
	}
	return { ok: false, error: FACEBOOK_NOT_VIDEO };
}
