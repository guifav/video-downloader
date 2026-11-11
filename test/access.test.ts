import { beforeEach, describe, expect, it } from "vitest";
import { accessConfigFromEnv, resetAccessCacheForTests, verifyAccessJwt, type AccessConfig } from "../src/access";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag";
const NOW = 1_800_000_000;
const config: AccessConfig = { teamDomain: TEAM, audience: AUD, allowedEmails: ["owner@example.com"] };

function b64url(data: Uint8Array | string): string {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair(kid: string) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, header: Record<string, unknown>) {
	const head = b64url(JSON.stringify(header));
	const body = b64url(JSON.stringify(payload));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const goodPayload = () => ({
	iss: `https://${TEAM}`,
	aud: [AUD],
	email: "Owner@Example.com",
	exp: NOW + 600,
	nbf: NOW - 10,
	iat: NOW - 10,
});

describe("verifyAccessJwt", async () => {
	const k1 = await keypair("k1");
	const other = await keypair("k1");
	let fetches = 0;
	const fetcher = async () => {
		fetches++;
		return { keys: [k1.jwk] };
	};

	beforeEach(() => {
		resetAccessCacheForTests();
		fetches = 0;
	});

	it("aceita token valido e normaliza o email", async () => {
		const token = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: true, email: "owner@example.com" });
	});

	it("reusa as chaves em cache", async () => {
		const token = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		await verifyAccessJwt(token, config, fetcher, NOW);
		await verifyAccessJwt(token, config, fetcher, NOW);
		expect(fetches).toBe(1);
	});

	it.each([
		["sem token", null],
		["malformado", "abc.def"],
		["lixo base64", "!!!.@@@.###"],
	])("rejeita %s", async (_label, token) => {
		expect((await verifyAccessJwt(token, config, fetcher, NOW)).ok).toBe(false);
	});

	it("rejeita assinatura de outra chave com o mesmo kid", async () => {
		const token = await sign(other.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: false, reason: "assinatura invalida" });
	});

	it("rejeita payload adulterado", async () => {
		const token = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		const [h, , s] = token.split(".");
		const forged = `${h}.${b64url(JSON.stringify({ ...goodPayload(), email: "x@evil.com" }))}.${s}`;
		expect((await verifyAccessJwt(forged, config, fetcher, NOW)).ok).toBe(false);
	});

	it("rejeita alg none e HS256", async () => {
		for (const alg of ["none", "HS256"]) {
			const token = await sign(k1.privateKey, goodPayload(), { alg, kid: "k1" });
			expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: false, reason: "algoritmo nao aceito" });
		}
	});

	it.each([
		["emissor", { iss: "https://evil.cloudflareaccess.com" }, "emissor invalido"],
		["audiencia", { aud: ["outra"] }, "audiencia invalida"],
		["expirado", { exp: NOW - 120 }, "token expirado"],
		["sem exp", { exp: undefined }, "token expirado"],
		["nbf futuro", { nbf: NOW + 120 }, "token ainda nao valido"],
		["email fora da lista", { email: "outra@gmail.com" }, "email nao autorizado"],
	])("rejeita %s", async (_label, patch, reason) => {
		const token = await sign(k1.privateKey, { ...goodPayload(), ...patch }, { alg: "RS256", kid: "k1" });
		expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: false, reason });
	});

	it("aceita aud como string", async () => {
		const token = await sign(k1.privateKey, { ...goodPayload(), aud: AUD }, { alg: "RS256", kid: "k1" });
		expect((await verifyAccessJwt(token, config, fetcher, NOW)).ok).toBe(true);
	});

	it("recarrega as chaves quando aparece kid novo (rotacao)", async () => {
		const k2 = await keypair("k2");
		let keys = [k1.jwk];
		const rotating = async () => {
			fetches++;
			return { keys };
		};
		const t1 = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		expect((await verifyAccessJwt(t1, config, rotating, NOW)).ok).toBe(true);
		keys = [k1.jwk, k2.jwk];
		const t2 = await sign(k2.privateKey, goodPayload(), { alg: "RS256", kid: "k2" });
		expect((await verifyAccessJwt(t2, config, rotating, NOW)).ok).toBe(true);
		expect(fetches).toBe(2);
	});

	it("falha fechado sem configuracao ou com erro ao buscar chaves", async () => {
		const token = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		expect((await verifyAccessJwt(token, { ...config, audience: "" }, fetcher, NOW)).ok).toBe(false);
		expect((await verifyAccessJwt(token, { ...config, teamDomain: "" }, fetcher, NOW)).ok).toBe(false);
		const broken = async (): Promise<{ keys: JsonWebKey[] }> => {
			throw new Error("rede");
		};
		expect(await verifyAccessJwt(token, config, broken, NOW)).toEqual({
			ok: false,
			reason: "falha ao obter chaves do Access: rede",
			transient: true,
		});
	});

	it("U1: lista de emails ausente ou vazia falha fechado, mesmo com token valido", async () => {
		const token = await sign(k1.privateKey, goodPayload(), { alg: "RS256", kid: "k1" });
		expect(await verifyAccessJwt(token, { ...config, allowedEmails: [] }, fetcher, NOW)).toEqual({
			ok: false,
			reason: "Access nao configurado no Worker",
		});
	});

	it("U1: token sem email e rejeitado", async () => {
		const token = await sign(k1.privateKey, { ...goodPayload(), email: undefined }, { alg: "RS256", kid: "k1" });
		expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: false, reason: "email nao autorizado" });
	});

	it.each([
		["header null", `${b64url("null")}.${b64url("{}")}.AA`],
		["payload null", `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url("null")}.AA`],
		["header array", `${b64url("[]")}.${b64url("{}")}.AA`],
	])("%s vira 403 controlado, sem excecao", async (_label, token) => {
		expect(await verifyAccessJwt(token, config, fetcher, NOW)).toEqual({ ok: false, reason: "token malformado" });
	});
});

describe("accessConfigFromEnv", () => {
	it("normaliza a lista de emails", () => {
		expect(
			accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: " t ", ACCESS_AUD: "a", ACCESS_ALLOWED_EMAILS: " A@x.com, ,b@y.com" }),
		).toEqual({ teamDomain: "t", audience: "a", allowedEmails: ["a@x.com", "b@y.com"] });
	});
});
