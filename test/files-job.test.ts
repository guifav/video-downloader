import { describe, expect, it } from "vitest";
import { contentDisposition, safeBasename } from "../src/files";
import { containerErrorMessage, fitMetadata, parseContainerSuccess, toPublicJob, type JobRecord } from "../src/job";

describe("safeBasename", () => {
	it("remove caracteres proibidos e colapsa espacos", () => {
		expect(safeBasename('a/b\\c:d*e?f"g<h>i|j\n k', "id")).toBe("a b c d e f g h i j k");
	});
	it("usa fallback quando o titulo some", () => {
		expect(safeBasename("", "jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
		expect(safeBasename("///", "id")).toBe("id");
		expect(safeBasename(undefined, "id")).toBe("id");
		expect(safeBasename("...", "id")).toBe("id");
		expect(safeBasename("nice update.", "id")).toBe("nice update");
		expect(safeBasename(" .hidden. ", "id")).toBe("hidden");
	});
	it("corta em 120 code points sem quebrar emoji", () => {
		const out = safeBasename("😀".repeat(200), "id");
		expect(Array.from(out)).toHaveLength(120);
		expect(out).toBe("😀".repeat(120));
	});
});

describe("contentDisposition", () => {
	it("gera fallback ASCII e filename* UTF-8", () => {
		expect(contentDisposition("Ação é \"top\"", "id", "mp4")).toBe(
			`attachment; filename="Acao e top.mp4"; filename*=UTF-8''A%C3%A7%C3%A3o%20%C3%A9%20top.mp4`,
		);
	});
	it("nao deixa CR/LF entrar no header", () => {
		const header = contentDisposition("a\r\nSet-Cookie: x=1", "id", "mp4");
		expect(header).not.toMatch(/[\r\n]/);
	});
	it("forca extensao segura", () => {
		expect(contentDisposition("t", "id", "../exe")).toContain('filename="t.mp4"');
	});
});

describe("parseContainerSuccess", () => {
	it("le tamanho, titulo e extensao", () => {
		const r = parseContainerSuccess(
			new Headers({ "content-length": "2048", "x-title": encodeURIComponent("Título"), "x-ext": "MP4" }),
		);
		expect(r).toEqual({ ok: true, title: "Título", ext: "mp4", bytes: 2048 });
	});
	it.each([undefined, "0", "-1", "abc", "1.5"])("rejeita content-length %s", (len: string | undefined) => {
		const headers = new Headers();
		if (len !== undefined) headers.set("content-length", len);
		expect(parseContainerSuccess(headers).ok).toBe(false);
	});
	it("le o aviso percent-encoded e limita o tamanho", () => {
		const warning = "Vídeo em VP9: não deu tempo de converter para H.264.";
		const r = parseContainerSuccess(new Headers({ "content-length": "1", "x-warning": encodeURIComponent(warning) }));
		expect(r).toEqual({ ok: true, title: "", ext: "mp4", bytes: 1, warning });
		const long = parseContainerSuccess(new Headers({ "content-length": "1", "x-warning": encodeURIComponent("a".repeat(2000)) }));
		expect(long.ok && long.warning?.length).toBe(200);
	});
	it("aviso malformado nao some: vira aviso generico", () => {
		const r = parseContainerSuccess(new Headers({ "content-length": "1", "x-warning": "%E0%A4%A" }));
		expect(r.ok && r.warning).toMatch(/H\.264/);
	});
	it("le codec de origem e tamanho entregue; valores invalidos sao ignorados (follow-up #5)", () => {
		const r = parseContainerSuccess(
			new Headers({ "content-length": "1", "x-source-codec": "VP9", "x-video-size": "1080x1920" }),
		);
		expect(r).toEqual({ ok: true, title: "", ext: "mp4", bytes: 1, sourceCodec: "vp9", width: 1080, height: 1920 });
		for (const [codec, size] of [
			["vp9; rm -rf", "0x720"],
			["a".repeat(21), "1920x"],
			["", "99999x1080"],
			["av01", "1920X1080"],
		]) {
			const bad = parseContainerSuccess(new Headers({ "content-length": "1", "x-source-codec": codec, "x-video-size": size }));
			expect(bad.ok && [bad.width, bad.height]).toEqual([undefined, undefined]);
			if (codec === "av01") expect(bad.ok && bad.sourceCodec).toBe("av01");
			else expect(bad.ok && bad.sourceCodec).toBeUndefined();
		}
	});
	it("tolera x-title malformado e extensao estranha", () => {
		const r = parseContainerSuccess(new Headers({ "content-length": "1", "x-title": "%E0%A4%A", "x-ext": "../sh" }));
		expect(r).toEqual({ ok: true, title: "", ext: "mp4", bytes: 1 });
	});
});

describe("fitMetadata (R1 Kimi, PR #14)", () => {
	const bytes = (m: Record<string, string>) =>
		Object.entries(m).reduce((n, [k, v]) => n + new TextEncoder().encode(k).length + new TextEncoder().encode(v).length, 0);
	it("titulo de 300 emojis e aviso de 200 emojis cabem em 2048 bytes sem perder os campos fixos", () => {
		const meta = {
			platform: "instagram",
			url: `https://www.instagram.com/reel/${"A".repeat(60)}/`,
			title: "😀".repeat(300),
			ext: "mp4",
			warning: "😀".repeat(200),
			sourceCodec: "vp9",
			size: "1080x1920",
		};
		expect(bytes(meta)).toBeGreaterThan(2048);
		const fit = fitMetadata(meta);
		expect(bytes(fit)).toBeLessThanOrEqual(2048);
		expect(fit).toMatchObject({ platform: "instagram", url: meta.url, ext: "mp4", sourceCodec: "vp9", size: "1080x1920" });
		// corta por code point: nada de surrogate solto
		expect(fit.title).toMatch(/^(😀)*$/u);
		expect(fit.title.length).toBeGreaterThan(0);
	});
	it("dentro do orcamento nao muda nada", () => {
		const meta = { platform: "x", url: "https://x.com/a/status/1", title: "Título", ext: "mp4" };
		expect(fitMetadata(meta)).toEqual(meta);
	});
	it("so o titulo nao basta: corta tambem o aviso", () => {
		const meta = { title: "t", warning: "é".repeat(1500) };
		const fit = fitMetadata(meta, 1000);
		expect(bytes(fit)).toBeLessThanOrEqual(1000);
		expect(fit.title).toBe("");
		expect(fit.warning.length).toBeGreaterThan(0);
	});
});

describe("containerErrorMessage", () => {
	it("usa o campo error do JSON", () => {
		expect(containerErrorMessage(422, JSON.stringify({ error: "Sign in to confirm" }))).toBe("Sign in to confirm");
	});
	it("cai para texto bruto e para mensagem padrao", () => {
		expect(containerErrorMessage(500, "boom")).toBe("HTTP 500: boom");
		expect(containerErrorMessage(502, "")).toBe("Container respondeu HTTP 502 sem detalhe.");
	});
});

describe("toPublicJob", () => {
	const base: JobRecord = {
		id: "11111111-1111-4111-8111-111111111111",
		platform: "youtube",
		videoId: "jNQXAC9IVRw",
		url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
		status: "done",
		attempts: 1,
		createdAt: 1,
		updatedAt: 2,
		title: "Me at the zoo",
		ext: "mp4",
		bytes: 10,
	};
	it("expoe fileUrl quando o arquivo existe", () => {
		expect(toPublicJob(base, true, "").fileUrl).toBe(`/api/files/${base.id}`);
	});
	it("expoe o aviso do arquivo", () => {
		expect(toPublicJob({ ...base, warning: "Video em VP9" }, true, "").warning).toBe("Video em VP9");
		expect(toPublicJob(base, true, "").warning).toBeUndefined();
	});
	it("expoe a resolucao entregue pelo lado menor (1080p vertical e horizontal), sem o codec interno", () => {
		expect(toPublicJob({ ...base, width: 1920, height: 1080, sourceCodec: "vp9" }, true, "").resolution).toBe("1080p");
		expect(toPublicJob({ ...base, width: 720, height: 1280 }, true, "").resolution).toBe("720p");
		expect(toPublicJob(base, true, "").resolution).toBeUndefined();
		expect((toPublicJob({ ...base, sourceCodec: "vp9" }, true, "") as unknown as Record<string, unknown>).sourceCodec).toBeUndefined();
	});
	it("marca expired quando o R2 ja apagou o arquivo", () => {
		const out = toPublicJob(base, false, "");
		expect(out.status).toBe("expired");
		expect(out.fileUrl).toBeUndefined();
	});
	it("nao vaza campos internos", () => {
		const out = toPublicJob({ ...base, status: "failed", error: "x" }, false, "") as unknown as Record<string, unknown>;
		expect(out.attempts).toBeUndefined();
		expect(out.videoId).toBeUndefined();
		expect(out.error).toBe("x");
	});
});
