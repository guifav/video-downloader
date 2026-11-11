import { describe, expect, it } from "vitest";
import { handleRequest, type GatewayEnv, type Verifier } from "../src/gateway";

function env() {
	const calls = { assets: 0, jobsCreated: 0 };
	const e: GatewayEnv = {
		JOB_INDEX: { getByName: () => ({ add: async () => {}, list: async () => [] }) },
		ASSETS: {
			async fetch() {
				calls.assets++;
				return new Response("<html>ui</html>", { headers: { "content-type": "text/html" } });
			},
		},
		JOBS: {
			getByName() {
				return {
					async create(job) {
						calls.jobsCreated++;
						return job;
					},
					async get() {
						return null;
					},
				};
			},
		},
		FILES: { head: async () => null, get: async () => null },
	};
	return { e, calls };
}

const allow: Verifier = async (token) => (token === "ok" ? { ok: true, email: "owner@example.com" } : { ok: false, reason: "x" });
const req = (path: string, init: RequestInit = {}, token?: string) =>
	new Request(`https://video.example.com${path}`, {
		...init,
		headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), "content-type": "application/json" },
	});

describe("handleRequest", () => {
	it.each([
		["/", {}],
		["/index.html", {}],
		["/api/jobs", { method: "POST", body: JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" }) }],
		["/api/jobs/11111111-1111-4111-8111-111111111111", {}],
		["/api/files/11111111-1111-4111-8111-111111111111", {}],
	])("sem JWT valido, %s responde 403 sem tocar em assets, jobs ou arquivos", async (path, init) => {
		const { e, calls } = env();
		for (const token of [undefined, "lixo"]) {
			const res = await handleRequest(req(path, init, token), e, allow);
			expect(res.status).toBe(403);
		}
		expect(calls).toEqual({ assets: 0, jobsCreated: 0 });
	});

	it("403 diz se a negacao e transitoria (chaves do Access fora) ou de identidade", async () => {
		const { e, calls } = env();
		const keysDown: Verifier = async () => ({ ok: false, reason: "falha ao obter chaves do Access: rede", transient: true });
		const r1 = await handleRequest(req("/api/jobs/11111111-1111-4111-8111-111111111111", {}, "ok"), e, keysDown);
		expect(r1.status).toBe(403);
		expect(r1.headers.get("x-access-denial")).toBe("unavailable");
		expect(((await r1.json()) as { code: string }).code).toBe("access_unavailable");
		const r2 = await handleRequest(req("/api/jobs/11111111-1111-4111-8111-111111111111", {}, "lixo"), e, allow);
		expect(r2.status).toBe(403);
		expect(r2.headers.get("x-access-denial")).toBe("denied");
		expect(((await r2.json()) as { code: string }).code).toBe("access_denied");
		expect(calls).toEqual({ assets: 0, jobsCreated: 0 });
	});

	it("com JWT valido serve a UI pelos assets", async () => {
		const { e, calls } = env();
		const res = await handleRequest(req("/", {}, "ok"), e, allow);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("ui");
		expect(calls.assets).toBe(1);
	});

	it("com JWT valido despacha /api para a API", async () => {
		const { e, calls } = env();
		const res = await handleRequest(
			req("/api/jobs", { method: "POST", body: JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" }) }, "ok"),
			e,
			allow,
		);
		expect(res.status).toBe(202);
		expect(calls.jobsCreated).toBe(1);
		expect(calls.assets).toBe(0);
	});

	it("metodo de escrita fora da API e 405", async () => {
		const { e, calls } = env();
		expect((await handleRequest(req("/", { method: "POST", body: "x" }, "ok"), e, allow)).status).toBe(405);
		expect(calls.assets).toBe(0);
	});

	it("verificador padrao falha fechado com ACCESS_ALLOWED_EMAILS vazia", async () => {
		const { e, calls } = env();
		const res = await handleRequest(req("/", {}, "a.b.c"), {
			...e,
			ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
			ACCESS_AUD: "aud",
			ACCESS_ALLOWED_EMAILS: " , ",
		});
		expect(res.status).toBe(403);
		expect(calls.assets).toBe(0);
	});

	it("verificador padrao falha fechado sem configuracao do Access", async () => {
		const { e, calls } = env();
		const res = await handleRequest(req("/", {}, "qualquer.coisa.aqui"), e);
		expect(res.status).toBe(403);
		expect(calls.assets).toBe(0);
	});
});
