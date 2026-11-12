import { describe, expect, it, vi } from "vitest";
import { resolveVideoUrl, SHARE_MAX_HOPS, SHARE_TIMEOUT_MS, SHARE_USER_AGENT, type Outbound } from "../src/share";

type Hop = { status: number; location?: string } | Error;

// fetch falso: responde pela URL exata e registra cada chamada.
function outbound(table: Record<string, Hop>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn: Outbound = async (url, init) => {
		calls.push({ url, init });
		const hop = table[url];
		if (!hop) throw new Error(`requisicao inesperada: ${url}`);
		if (hop instanceof Error) throw hop;
		const headers = new Headers();
		if (hop.location) headers.set("location", hop.location);
		return new Response(null, { status: hop.status, headers });
	};
	return { fn, calls };
}

const FB_V = "https://www.facebook.com/share/v/19giuAapf3/";

describe("resolveVideoUrl", () => {
	it("link que nao e de compartilhamento nao faz requisicao", async () => {
		const { fn, calls } = outbound({});
		const r = await resolveVideoUrl("https://www.facebook.com/reel/1195289147628387", fn);
		expect(r).toMatchObject({ ok: true, platform: "facebook", canonicalUrl: "https://www.facebook.com/reel/1195289147628387" });
		expect(calls).toHaveLength(0);
		const bad = await resolveVideoUrl("https://vimeo.com/1", fn);
		expect(bad.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("share/v do Facebook segue o 302 ate o reel canonico, com fetch manual e UA nao navegador", async () => {
		const { fn, calls } = outbound({
			[FB_V]: {
				status: 302,
				location:
					"https://www.facebook.com/reel/2300162620759818?rdid=Y3Ip&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fv%2F19giuAapf3%2F",
			},
		});
		const r = await resolveVideoUrl("https://m.facebook.com/share/v/19giuAapf3/?mibextid=wwXIfr", fn);
		expect(r).toMatchObject({
			ok: true,
			platform: "facebook",
			videoId: "2300162620759818",
			canonicalUrl: "https://www.facebook.com/reel/2300162620759818",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(FB_V);
		expect(calls[0].init.redirect).toBe("manual");
		expect(new Headers(calls[0].init.headers).get("user-agent")).toBe(SHARE_USER_AGENT);
		expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
	});

	it("location relativa e cadeia de compartilhamento sao seguidas dentro do limite", async () => {
		const { fn, calls } = outbound({
			"https://www.facebook.com/share/r/AAA111/": { status: 301, location: "/share/v/BBB222/" },
			"https://www.facebook.com/share/v/BBB222/": { status: 302, location: "/watch/?v=123456" },
		});
		const r = await resolveVideoUrl("facebook.com/share/r/AAA111", fn);
		expect(r).toMatchObject({ ok: true, canonicalUrl: "https://www.facebook.com/watch/?v=123456" });
		expect(calls.map((c) => c.url)).toEqual(["https://www.facebook.com/share/r/AAA111/", "https://www.facebook.com/share/v/BBB222/"]);
	});

	it("salto para outro compartilhamento busca a forma canonica, nunca a location crua", async () => {
		const { fn, calls } = outbound({
			"https://www.facebook.com/share/r/AAA111/": { status: 302, location: "http://m.facebook.com/share/v/BBB222/?next=https://evil.com" },
			"https://www.facebook.com/share/v/BBB222/": { status: 302, location: "/reel/123456" },
		});
		const r = await resolveVideoUrl("https://www.facebook.com/share/r/AAA111/", fn);
		expect(r.ok).toBe(true);
		expect(calls.map((c) => c.url)).toEqual(["https://www.facebook.com/share/r/AAA111/", "https://www.facebook.com/share/v/BBB222/"]);
	});

	it.each([
		["destino externo", { status: 302, location: "https://evil.com/reel/1" }],
		["destino interno", { status: 302, location: "http://169.254.169.254/latest" }],
		["pagina de login", { status: 302, location: "https://www.facebook.com/login/?next=x" }],
		["navegador nao suportado", { status: 302, location: "https://www.facebook.com/unsupportedbrowser" }],
		["perfil", { status: 302, location: "https://www.facebook.com/natgeo" }],
		["sem redirect", { status: 200 }],
		["redirect sem location", { status: 302 }],
		["404", { status: 404 }],
	])("%s vira erro claro sem seguir adiante", async (_label, hop) => {
		const { fn, calls } = outbound({ [FB_V]: hop as Hop });
		const r = await resolveVideoUrl(FB_V, fn);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/compartilhamento/);
			expect(r.status).toBe(400);
		}
		expect(calls).toHaveLength(1);
	});

	it("share que leva ao Instagram e recusado (so Facebook)", async () => {
		const { fn } = outbound({ [FB_V]: { status: 302, location: "https://www.instagram.com/reel/CDUMkliABpa/" } });
		const r = await resolveVideoUrl(FB_V, fn);
		expect(r.ok).toBe(false);
	});

	it("share de post e share do Instagram nao sao resolvidos (sem caso medido)", async () => {
		const { fn, calls } = outbound({});
		for (const input of ["https://www.facebook.com/share/p/CCC333/", "https://www.instagram.com/share/reel/BAy9bT6kXv/"]) {
			expect((await resolveVideoUrl(input, fn)).ok).toBe(false);
		}
		expect(calls).toHaveLength(0);
	});

	it("laco de compartilhamento para no limite de saltos", async () => {
		const table: Record<string, Hop> = {};
		for (let i = 0; i < 10; i++) {
			table[`https://www.facebook.com/share/v/LOOP${i}/`] = { status: 302, location: `/share/v/LOOP${i + 1}/` };
		}
		const { fn, calls } = outbound(table);
		const r = await resolveVideoUrl("https://www.facebook.com/share/v/LOOP0/", fn);
		expect(r.ok).toBe(false);
		expect(calls).toHaveLength(SHARE_MAX_HOPS);
	});

	it.each([
		["queda de rede", new TypeError("network")],
		["timeout", new DOMException("timeout", "TimeoutError")],
		["503", { status: 503 }],
		["429", { status: 429 }],
	])("%s e transitorio (503)", async (_label, hop) => {
		const { fn } = outbound({ [FB_V]: hop as Hop });
		const r = await resolveVideoUrl(FB_V, fn);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(503);
			expect(r.error).toMatch(/tente de novo/);
		}
	});

	it.each(["https://www.facebook.com/share/v/../../x/", "https://www.facebook.com/share/v/a/", "https://www.facebook.com/share/x/ABC123/"])(
		"token invalido nao faz requisicao: %s",
		async (input) => {
			const { fn, calls } = outbound({});
			const r = await resolveVideoUrl(input, fn);
			expect(r.ok).toBe(false);
			expect(calls).toHaveLength(0);
		},
	);

	it.each([
		["302 para o video", 302, "https://www.facebook.com/reel/2300162620759818"],
		["200 (pagina)", 200, undefined],
		["503", 503, undefined],
	])("corpo nao nulo e cancelado em cada salto: %s", async (_label, status, location) => {
		let cancelled = 0;
		const fn: Outbound = async () => {
			const body = new ReadableStream<Uint8Array>({
				pull(ctrl) {
					ctrl.enqueue(new Uint8Array(1024));
				},
				cancel() {
					cancelled++;
				},
			});
			const headers = new Headers(location ? { location } : {});
			return new Response(body, { status, headers });
		};
		await resolveVideoUrl(FB_V, fn);
		await new Promise((r) => setTimeout(r, 0));
		expect(cancelled).toBe(1);
	});

	it(
		"salto que nao responde e cortado pelo AbortSignal.timeout real de 8 s: 503 sem job",
		async () => {
			// Contrato literal: nem a constante nem a chamada podem divergir de 8 s (R1 Astra e Kimi, PR #12).
			const EXPECTED_TIMEOUT_MS = 8_000;
			expect(SHARE_TIMEOUT_MS).toBe(EXPECTED_TIMEOUT_MS);
			const timeout = vi.spyOn(AbortSignal, "timeout"); // chama a implementacao real
			try {
				let signal: AbortSignal | undefined;
				const fn: Outbound = (_url, init) =>
					new Promise<Response>((_, reject) => {
						signal = init.signal ?? undefined;
						signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
					});
				const started = Date.now();
				const r = await resolveVideoUrl(FB_V, fn);
				expect(timeout.mock.calls).toEqual([[EXPECTED_TIMEOUT_MS]]);
				expect(r).toMatchObject({ ok: false, status: 503 });
				expect(signal!.aborted).toBe(true);
				expect((signal!.reason as DOMException).name).toBe("TimeoutError");
				// So o piso: o teto fica com o timeout do teste, que detecta travamento sem ficar sensivel
				// a pausa do runner.
				expect(Date.now() - started).toBeGreaterThanOrEqual(EXPECTED_TIMEOUT_MS - 50);
			} finally {
				timeout.mockRestore();
			}
		},
		30_000,
	);

	it("link curto do TikTok (vt, vm e /t/) segue o 301 ate o video canonico", async () => {
		const target = "https://www.tiktok.com/@avery_arnett2/video/7682913384781696269?_r=1&_t=ZS-9ANqD14PtVU";
		for (const [input, first] of [
			["https://vt.tiktok.com/ZSbpfF4Dp/", "https://vt.tiktok.com/ZSbpfF4Dp/"],
			["vm.tiktok.com/ZSbpfF4Dp?x=1", "https://vm.tiktok.com/ZSbpfF4Dp/"],
			["https://tiktok.com/t/ZSbpfF4Dp", "https://www.tiktok.com/t/ZSbpfF4Dp/"],
		]) {
			const { fn, calls } = outbound({ [first]: { status: 301, location: target } });
			const r = await resolveVideoUrl(input, fn);
			expect(r).toMatchObject({
				ok: true,
				platform: "tiktok",
				videoId: "7682913384781696269",
				canonicalUrl: "https://www.tiktok.com/@avery_arnett2/video/7682913384781696269",
			});
			expect(calls.map((c) => c.url)).toEqual([first]);
			expect(calls[0].init).toMatchObject({ redirect: "manual" });
		}
	});

	it("link curto do TikTok que nao leva a video (expirado, produto, outra plataforma) e 400 sem job", async () => {
		for (const location of [
			"https://www.tiktok.com/?_r=1",
			"https://www.tiktok.com/view/product/1737639444571063434",
			"https://www.facebook.com/reel/1195289147628387",
		]) {
			const { fn } = outbound({ "https://vt.tiktok.com/ZSbpfF4Dp/": { status: 302, location } });
			expect(await resolveVideoUrl("https://vt.tiktok.com/ZSbpfF4Dp/", fn)).toMatchObject({ ok: false, status: 400 });
		}
		const { fn, calls } = outbound({});
		expect(await resolveVideoUrl("https://vt.tiktok.com/a/b/", fn)).toMatchObject({ ok: false, status: 400, error: "Link curto do TikTok invalido." });
		expect(calls).toHaveLength(0);
	});
});
