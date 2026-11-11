import { describe, expect, it } from "vitest";
import { readLimitedText } from "../src/http";

function chunked(parts: string[]): Request {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(ctrl) {
			for (const p of parts) ctrl.enqueue(enc.encode(p));
			ctrl.close();
		},
	});
	return new Request("https://x/api/jobs", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("readLimitedText", () => {
	it("le o corpo inteiro dentro do limite", async () => {
		expect(await readLimitedText(new Request("https://x", { method: "POST", body: '{"url":"a"}' }), 64)).toEqual({
			ok: true,
			text: '{"url":"a"}',
		});
	});

	it("rejeita pelo Content-Length declarado", async () => {
		const req = new Request("https://x", { method: "POST", body: "a".repeat(10), headers: { "content-length": "100" } });
		expect(await readLimitedText(req, 64)).toMatchObject({ ok: false, status: 413 });
	});

	it("rejeita corpo sem Content-Length que passa do limite, sem truncar", async () => {
		const valid = JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" });
		const req = chunked([valid.padEnd(4096, " "), "INVALID"]);
		expect(await readLimitedText(req, 4096)).toMatchObject({ ok: false, status: 413 });
	});

	it("aceita corpo exatamente no limite", async () => {
		const r = await readLimitedText(chunked(["a".repeat(32), "b".repeat(32)]), 64);
		expect(r).toEqual({ ok: true, text: "a".repeat(32) + "b".repeat(32) });
	});

	it("rejeita UTF-8 invalido", async () => {
		const req = new Request("https://x", { method: "POST", body: new Uint8Array([0xff, 0xfe]) });
		expect(await readLimitedText(req, 64)).toMatchObject({ ok: false, status: 400 });
	});

	it("corpo ausente vira texto vazio", async () => {
		expect(await readLimitedText(new Request("https://x", { method: "POST" }), 64)).toEqual({ ok: true, text: "" });
	});
});
