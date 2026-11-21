import { describe, expect, it } from "vitest";
import { handleApi, type ApiEnv } from "../src/api";
import { handleUploads, PART_SIZE, uploadConfigFromEnv, uploadKey, type UploadBucket, type UploadEnv } from "../src/uploads";

const GUI = "owner@example.com";
const OTHER = "other@example.com";
const STUDIO = "service:studio";
const ROGUE = "service:rogue";

// R2 em memoria: objetos com metadados e uploads multipart com partes e etags.
function fakeBucket() {
	const objects = new Map<string, { data: Uint8Array; custom: Record<string, string>; type?: string }>();
	const multipart = new Map<string, { key: string; custom: Record<string, string>; type?: string; parts: Map<number, Uint8Array> }>();
	let seq = 0;
	const toObject = (key: string) => {
		const o = objects.get(key)!;
		return {
			key,
			size: o.data.byteLength,
			customMetadata: o.custom,
			httpMetadata: { contentType: o.type },
			body: new Blob([o.data.slice().buffer as ArrayBuffer]).stream(),
			json: async () => JSON.parse(new TextDecoder().decode(o.data)),
		};
	};
	const mpu = (key: string, uploadId: string) => ({
		key,
		uploadId,
		async uploadPart(n: number, body: ReadableStream | string) {
			const m = multipart.get(uploadId);
			if (!m || m.key !== key) throw new Error("upload desconhecido");
			const data = new Uint8Array(await new Response(body).arrayBuffer());
			m.parts.set(n, data);
			return { partNumber: n, etag: `e${n}-${data.byteLength}` };
		},
		async complete(parts: { partNumber: number; etag: string }[]) {
			const m = multipart.get(uploadId);
			if (!m) throw new Error("upload desconhecido");
			const chunks = parts.map((p) => {
				const d = m.parts.get(p.partNumber);
				if (!d || p.etag !== `e${p.partNumber}-${d.byteLength}`) throw new Error("etag invalida");
				return d;
			});
			const total = chunks.reduce((s, c) => s + c.byteLength, 0);
			const data = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) {
				data.set(c, off);
				off += c.byteLength;
			}
			objects.set(key, { data, custom: m.custom, type: m.type });
			multipart.delete(uploadId);
		},
		async abort() {
			multipart.delete(uploadId);
		},
	});
	const bucket = {
		async get(key: string) {
			return objects.has(key) ? toObject(key) : null;
		},
		async head(key: string) {
			return objects.has(key) ? toObject(key) : null;
		},
		async put(key: string, value: string) {
			objects.set(key, { data: new TextEncoder().encode(value), custom: {} });
		},
		async delete(key: string) {
			objects.delete(key);
		},
		async list(options: { prefix?: string }) {
			const keys = [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? ""));
			return { objects: keys.map(toObject), truncated: false, delimitedPrefixes: [] };
		},
		async createMultipartUpload(key: string, options: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) {
			const uploadId = `u${++seq}`;
			multipart.set(uploadId, { key, custom: options.customMetadata ?? {}, type: options.httpMetadata?.contentType, parts: new Map() });
			return mpu(key, uploadId);
		},
		resumeMultipartUpload(key: string, uploadId: string) {
			return mpu(key, uploadId);
		},
	};
	return { bucket: bucket as unknown as UploadBucket, objects };
}

function setup(shares = "studio=owner@example.com") {
	const { bucket, objects } = fakeBucket();
	const env: UploadEnv = { FILES: bucket, UPLOAD_EMAILS: GUI, UPLOAD_SHARES: shares };
	const call = async (user: string, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
		const res = await handleUploads(new Request(`https://video.example.com${path}`, { method, body, headers }), env, user);
		if (!res) throw new Error("rota nao tratada");
		// biome-ignore lint: corpo JSON livre nos testes
		const parsed: any = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
		return { status: res.status, body: parsed, res };
	};
	const create = (user: string, size: number, extra: Record<string, unknown> = {}) =>
		call(user, "POST", "/api/uploads", JSON.stringify({ name: "fala.m4a", size, type: "audio/mp4", ref: "gui-50", ...extra }));
	const put = (user: string, id: string, n: number, data: Uint8Array, length = data.byteLength) =>
		call(user, "PUT", `/api/uploads/${id}/parts/${n}`, data as unknown as BodyInit, { "content-length": String(length) });
	// Envio inteiro de `size` bytes; devolve o id.
	const send = async (user: string, size: number, extra: Record<string, unknown> = {}) => {
		const c = await create(user, size, extra);
		expect(c.status).toBe(201);
		const parts = [];
		for (let n = 1; n <= c.body.parts; n++) {
			const len = n < c.body.parts ? PART_SIZE : size - PART_SIZE * (c.body.parts - 1);
			const p = await put(user, c.body.id, n, new Uint8Array(len).fill(n));
			expect(p.status).toBe(200);
			parts.push(p.body);
		}
		const done = await call(user, "POST", `/api/uploads/${c.body.id}/complete`, JSON.stringify({ parts }));
		expect(done.status).toBe(201);
		return c.body.id as string;
	};
	return { env, objects, call, create, put, send };
}

describe("uploadConfigFromEnv", () => {
	it("compartilhamento so vale para dono que pode enviar", () => {
		const c = uploadConfigFromEnv({ UPLOAD_EMAILS: " Owner@Example.com ", UPLOAD_SHARES: "studio=owner@example.com, rogue=other@example.com, =x, y=" });
		expect(c.uploaders).toEqual([GUI]);
		expect(c.shares).toEqual(new Map([[STUDIO, [GUI]]]));
	});
});

describe("uploads", () => {
	it("envio em partes monta o arquivo inteiro, com dono, nome e referencia", async () => {
		const t = setup();
		const size = PART_SIZE * 2 + 7;
		const id = await t.send(GUI, size);
		const obj = t.objects.get(uploadKey(id))!;
		expect(obj.data.byteLength).toBe(size);
		expect(obj.data[0]).toBe(1);
		expect(obj.data[PART_SIZE]).toBe(2);
		expect(obj.data[size - 1]).toBe(3);
		expect(obj.custom).toMatchObject({ owner: GUI, name: "fala.m4a", ref: "GUI-50" });
		// O registro provisório some ao concluir.
		expect([...t.objects.keys()].filter((k) => k.startsWith("uploads-pending/"))).toEqual([]);
		const listed = await t.call(GUI, "GET", "/api/uploads");
		expect(listed.body.uploads).toEqual([expect.objectContaining({ id, name: "fala.m4a", ref: "GUI-50", size, type: "audio/mp4" })]);
	});

	it("so quem esta em UPLOAD_EMAILS envia", async () => {
		const t = setup();
		for (const user of [OTHER, STUDIO]) expect((await t.create(user, 10)).status).toBe(403);
	});

	it("outro usuario nao ve, nao baixa e nao continua o envio de ninguem", async () => {
		const t = setup();
		const id = await t.send(GUI, 10);
		expect((await t.call(OTHER, "GET", "/api/uploads")).status).toBe(403);
		expect((await t.call(OTHER, "GET", `/api/uploads/${id}/file`)).status).toBe(404);
		const c = await t.create(GUI, 10);
		expect((await t.put(OTHER, c.body.id, 1, new Uint8Array(10))).status).toBe(403);
		expect((await t.call(OTHER, "POST", `/api/uploads/${c.body.id}/complete`, "{}")).status).toBe(403);
	});

	it("so o servico com compartilhamento le os envios do dono, e nao envia", async () => {
		const t = setup();
		const id = await t.send(GUI, 10);
		const listed = await t.call(STUDIO, "GET", "/api/uploads?ref=GUI-50");
		expect(listed.body.uploads.map((u: { id: string }) => u.id)).toEqual([id]);
		expect((await t.call(STUDIO, "GET", "/api/uploads?ref=GUI-51")).body.uploads).toEqual([]);
		const file = await t.call(STUDIO, "GET", `/api/uploads/${id}/file`);
		expect(file.status).toBe(200);
		expect(file.res.headers.get("content-length")).toBe("10");
		expect(file.res.headers.get("content-disposition")).toContain("fala.m4a");
		expect((await t.call(ROGUE, "GET", "/api/uploads")).status).toBe(403);
		expect((await t.call(ROGUE, "GET", `/api/uploads/${id}/file`)).status).toBe(404);
	});

	it("o servico nao le envios de outro dono, mesmo que outro email possa enviar", async () => {
		const { bucket } = fakeBucket();
		const env: UploadEnv = { FILES: bucket, UPLOAD_EMAILS: `${GUI},${OTHER}`, UPLOAD_SHARES: "studio=owner@example.com" };
		const req = (user: string, method: string, path: string, body?: BodyInit, headers?: Record<string, string>) =>
			handleUploads(new Request(`https://video.example.com${path}`, { method, body, headers }), env, user).then((r) => r!);
		// biome-ignore lint: corpo JSON livre nos testes
		const c: any = await (await req(OTHER, "POST", "/api/uploads", JSON.stringify({ name: "x.mp4", size: 3, type: "video/mp4" }))).json();
		const p = await (await req(OTHER, "PUT", `/api/uploads/${c.id}/parts/1`, new Uint8Array(3) as unknown as BodyInit, { "content-length": "3" })).json();
		expect((await req(OTHER, "POST", `/api/uploads/${c.id}/complete`, JSON.stringify({ parts: [p] }))).status).toBe(201);
		expect(((await (await req(STUDIO, "GET", "/api/uploads")).json()) as { uploads: unknown[] }).uploads).toEqual([]);
		expect((await req(STUDIO, "GET", `/api/uploads/${c.id}/file`)).status).toBe(404);
		expect(((await (await req(GUI, "GET", "/api/uploads")).json()) as { uploads: unknown[] }).uploads).toEqual([]);
	});

	it("recusa parte com tamanho diferente do esperado, numero fora da faixa e lista de partes errada", async () => {
		const t = setup();
		const size = PART_SIZE + 5;
		const c = await t.create(GUI, size);
		expect((await t.put(GUI, c.body.id, 2, new Uint8Array(4))).status).toBe(400);
		expect((await t.put(GUI, c.body.id, 3, new Uint8Array(5))).status).toBe(400);
		const p2 = await t.put(GUI, c.body.id, 2, new Uint8Array(5));
		expect(p2.status).toBe(200);
		const bad = await t.call(GUI, "POST", `/api/uploads/${c.body.id}/complete`, JSON.stringify({ parts: [p2.body] }));
		expect(bad.status).toBe(400);
	});

	it("conclusao aceita o maior envio permitido (20 GB, etags longas como as do R2)", async () => {
		const t = setup();
		const c = await t.create(GUI, 20 * 1024 ** 3);
		expect(c.body.parts).toBe(410);
		const parts = Array.from({ length: c.body.parts }, (_, i) => ({ partNumber: i + 1, etag: "x".repeat(171) }));
		const res = await t.call(GUI, "POST", `/api/uploads/${c.body.id}/complete`, JSON.stringify({ parts }));
		// O falso recusa as etags (502); o que importa e nao ser 413 pelo tamanho do corpo.
		expect(res.status).toBe(502);
	});

	it("valida tamanho, tipo e referencia na criacao", async () => {
		const t = setup();
		for (const extra of [{ type: "text/html" }, { type: "application/octet-stream" }, { ref: "../x" }, { ref: "a b" }]) {
			expect((await t.create(GUI, 10, extra)).status).toBe(400);
		}
		for (const size of [0, -1, 1.5, 21 * 1024 ** 3]) expect((await t.create(GUI, size)).status).toBe(400);
	});

	it("id fora do formato e rota desconhecida respondem 404; outros caminhos nao sao deste modulo", async () => {
		const t = setup();
		expect((await t.call(GUI, "GET", "/api/uploads/abc/file")).status).toBe(404);
		expect((await t.call(GUI, "GET", "/api/uploads/11111111-1111-4111-8111-111111111111/outro")).status).toBe(404);
		expect(await handleUploads(new Request("https://video.example.com/api/jobs"), t.env, GUI)).toBeNull();
	});
});

describe("/api/me", () => {
	it("diz se a conta pode enviar", async () => {
		const env = { UPLOAD_EMAILS: GUI } as unknown as ApiEnv;
		const me = (user: string) => handleApi(new Request("https://video.example.com/api/me"), env, undefined, user).then((r) => r.json());
		expect(await me(GUI)).toEqual({ canUpload: true });
		expect(await me(OTHER)).toEqual({ canUpload: false });
	});
});
