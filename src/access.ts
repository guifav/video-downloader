// Defesa em profundidade: alem do Cloudflare Access na borda, o Worker exige e valida o JWT
// que o Access injeta (Cf-Access-Jwt-Assertion). Se o app do Access for removido ou mal
// configurado, o Worker falha fechado em vez de servir o baixador publicamente.

export interface AccessConfig {
	teamDomain: string; // ex.: <time>.cloudflareaccess.com
	audience: string; // AUD tag do app do Access
	allowedEmails: string[]; // obrigatoria: lista vazia falha fechado (U1)
}

// transient: a negacao vem de indisponibilidade (chaves do Access fora), nao da identidade.
export type AccessResult = { ok: true; email: string } | { ok: false; reason: string; transient?: true };

interface Jwk extends JsonWebKey {
	kid?: string;
}

type CertsFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
let certsCache: { url: string; at: number; keys: Jwk[] } | null = null;

export function resetAccessCacheForTests(): void {
	certsCache = null;
}

const defaultFetcher: CertsFetcher = async (url) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`certs HTTP ${res.status}`);
	return (await res.json()) as { keys: Jwk[] };
};

function b64urlToBytes(input: string): Uint8Array {
	const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function decodeJson(segment: string): Record<string, unknown> {
	const value: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("nao e objeto");
	return value as Record<string, unknown>;
}

async function getKeys(certsUrl: string, fetcher: CertsFetcher, forceRefresh: boolean): Promise<Jwk[]> {
	const now = Date.now();
	if (!forceRefresh && certsCache && certsCache.url === certsUrl && now - certsCache.at < CERTS_TTL_MS) {
		return certsCache.keys;
	}
	const { keys } = await fetcher(certsUrl);
	if (!Array.isArray(keys)) throw new Error("certs sem keys");
	certsCache = { url: certsUrl, at: now, keys };
	return keys;
}

export async function verifyAccessJwt(
	token: string | null,
	config: AccessConfig,
	fetcher: CertsFetcher = defaultFetcher,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AccessResult> {
	if (!config.teamDomain || !config.audience || config.allowedEmails.length === 0) {
		return { ok: false, reason: "Access nao configurado no Worker" };
	}
	if (!token) return { ok: false, reason: "sem token do Access" };

	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "token malformado" };
	let header: Record<string, unknown>;
	let payload: Record<string, unknown>;
	try {
		header = decodeJson(parts[0]);
		payload = decodeJson(parts[1]);
	} catch {
		return { ok: false, reason: "token malformado" };
	}
	if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "algoritmo nao aceito" };

	const certsUrl = `https://${config.teamDomain}/cdn-cgi/access/certs`;
	let keys: Jwk[];
	try {
		keys = await getKeys(certsUrl, fetcher, false);
		if (!keys.some((k) => k.kid === header.kid)) keys = await getKeys(certsUrl, fetcher, true);
	} catch (error) {
		return {
			ok: false,
			reason: `falha ao obter chaves do Access: ${error instanceof Error ? error.message : error}`,
			transient: true,
		};
	}
	const jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) return { ok: false, reason: "chave do token desconhecida" };

	let valid = false;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: jwk.kty, n: jwk.n, e: jwk.e },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			b64urlToBytes(parts[2]),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: "assinatura invalida" };

	if (payload.iss !== `https://${config.teamDomain}`) return { ok: false, reason: "emissor invalido" };
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.includes(config.audience)) return { ok: false, reason: "audiencia invalida" };
	if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowSeconds) return { ok: false, reason: "token expirado" };
	if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowSeconds) return { ok: false, reason: "token ainda nao valido" };

	const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
	if (email === "" || !config.allowedEmails.includes(email)) return { ok: false, reason: "email nao autorizado" };
	return { ok: true, email };
}

export function accessConfigFromEnv(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_ALLOWED_EMAILS?: string }): AccessConfig {
	return {
		teamDomain: (env.ACCESS_TEAM_DOMAIN ?? "").trim(),
		audience: (env.ACCESS_AUD ?? "").trim(),
		allowedEmails: (env.ACCESS_ALLOWED_EMAILS ?? "")
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	};
}
