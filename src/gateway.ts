import { accessConfigFromEnv, verifyAccessJwt, type AccessResult } from "./access";
import { handleApi, type ApiEnv } from "./api";

// Porta de entrada do Worker: exige JWT valido do Access em toda requisicao (inclusive a UI
// estatica) e so entao despacha para a API ou para os assets. Testavel em Node.

export interface GatewayEnv extends ApiEnv {
	ASSETS: { fetch(request: Request): Promise<Response> };
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	ACCESS_ALLOWED_EMAILS?: string;
}

export type Verifier = (token: string | null, env: GatewayEnv) => Promise<AccessResult>;

const defaultVerifier: Verifier = (token, env) => verifyAccessJwt(token, accessConfigFromEnv(env));

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
	});
}

export async function handleRequest(request: Request, env: GatewayEnv, verify: Verifier = defaultVerifier): Promise<Response> {
	const access = await verify(request.headers.get("cf-access-jwt-assertion"), env);
	if (!access.ok) {
		console.warn("acesso negado:", access.reason);
		// Sempre 403 (U1). O codigo diz a UI se vale tentar de novo (chaves do Access indisponiveis)
		// ou se a sessao precisa ser refeita.
		// A classificacao vai tambem no header, que chega antes do corpo: a UI decide mesmo se a
		// leitura do corpo falhar.
		return access.transient
			? json({ error: "Verificacao de acesso indisponivel; tentando de novo.", code: "access_unavailable" }, 403, {
					"x-access-denial": "unavailable",
				})
			: json({ error: "Acesso negado. Recarregue a pagina para entrar de novo.", code: "access_denied" }, 403, {
					"x-access-denial": "denied",
				});
	}

	const { pathname } = new URL(request.url);
	if (pathname.startsWith("/api/")) return handleApi(request, env);
	if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Metodo nao permitido." }, 405);
	return env.ASSETS.fetch(request);
}
