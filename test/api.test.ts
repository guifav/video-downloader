import { describe, expect, it } from "vitest";
import { handleApi, MAX_BODY_BYTES, type ApiEnv, type JobStub } from "../src/api";
import type { JobRecord } from "../src/job";

const ID = "11111111-1111-4111-8111-111111111111";

function fakeEnv() {
	const jobs = new Map<string, JobRecord>();
	const files = new Map<string, { body: string; disposition: string }>();
	const created: JobRecord[] = [];
	let recent: { id: string; createdAt: number }[] = [];
	let indexFails = false;
	const env: ApiEnv = {
		JOB_INDEX: {
			getByName: () => ({
				async add(entry) {
					if (indexFails) throw new Error("indice fora");
					recent = [entry, ...recent.filter((e) => e.id !== entry.id)];
				},
				async list() {
					return recent;
				},
			}),
		},
		JOBS: {
			getByName(name: string): JobStub {
				return {
					async create(job) {
						created.push(job);
						if (!jobs.has(name)) jobs.set(name, job);
						return jobs.get(name)!;
					},
					async get() {
						return jobs.get(name) ?? null;
					},
				};
			},
		},
		FILES: {
			async head(key) {
				return files.has(key) ? {} : null;
			},
			async get(key) {
				const f = files.get(key);
				if (!f) return null;
				return {
					size: f.body.length,
					body: new Blob([f.body]).stream(),
					writeHttpMetadata(h: Headers) {
						h.set("content-type", "video/mp4");
						h.set("content-disposition", f.disposition);
					},
				} as unknown as R2ObjectBody;
			},
		},
	};
	return {
		env,
		jobs,
		files,
		created,
		recent: () => recent,
		setRecent: (r: { id: string; createdAt: number }[]) => (recent = r),
		failIndex: () => (indexFails = true),
	};
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
	new Request("https://video.example.com/api/jobs", { method: "POST", body, headers });

describe("POST /api/jobs", () => {
	it("cria job com URL canonica e status 202, sem campos internos", async () => {
		const { env, created } = fakeEnv();
		const res = await handleApi(post(JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw?si=x" })), env);
		expect(res.status).toBe(202);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ platform: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", status: "queued" });
		expect(body.attempts).toBeUndefined();
		expect(created).toHaveLength(1);
		expect(created[0].id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it.each([
		["URL de playlist", JSON.stringify({ url: "https://www.youtube.com/playlist?list=PL1" }), 400],
		["host fora da lista", JSON.stringify({ url: "https://vimeo.com/1" }), 400],
		["JSON invalido", "{nope", 400],
		["JSON sem url", JSON.stringify({}), 400],
	])("%s responde %i sem criar job (nao acorda container)", async (_label, body, status) => {
		const { env, created } = fakeEnv();
		const res = await handleApi(post(body), env);
		expect(res.status).toBe(status);
		expect(((await res.json()) as { error: string }).error).toBeTruthy();
		expect(created).toHaveLength(0);
	});

	it("corpo acima do limite responde 413 sem criar job, mesmo sem Content-Length", async () => {
		const { env, created } = fakeEnv();
		const valid = JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" });
		const stream = new Blob([valid.padEnd(MAX_BODY_BYTES, " ") + "INVALID"]).stream();
		const res = await handleApi(
			new Request("https://video.example.com/api/jobs", { method: "POST", body: stream, duplex: "half" } as RequestInit),
			env,
		);
		expect(res.status).toBe(413);
		expect(created).toHaveLength(0);
	});

	it("indexa o job criado e uma falha do indice nao falha o envio", async () => {
		const ok = fakeEnv();
		await handleApi(post(JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" })), ok.env);
		expect(ok.recent().map((e) => e.id)).toEqual([ok.created[0].id]);
		const broken = fakeEnv();
		broken.failIndex();
		const res = await handleApi(post(JSON.stringify({ url: "https://youtu.be/jNQXAC9IVRw" })), broken.env);
		expect(res.status).toBe(202);
		expect(broken.created).toHaveLength(1);
	});

	it("link de compartilhamento e resolvido antes de criar o job; o job guarda a URL canonica", async () => {
		const { env, created } = fakeEnv();
		const seen: string[] = [];
		const outbound = async (url: string) => {
			seen.push(url);
			return new Response(null, { status: 302, headers: { location: "https://www.facebook.com/reel/2300162620759818?rdid=x" } });
		};
		const res = await handleApi(post(JSON.stringify({ url: "https://www.facebook.com/share/v/19giuAapf3/" })), env, outbound);
		expect(res.status).toBe(202);
		expect(seen).toEqual(["https://www.facebook.com/share/v/19giuAapf3/"]);
		expect(created[0]).toMatchObject({
			platform: "facebook",
			videoId: "2300162620759818",
			url: "https://www.facebook.com/reel/2300162620759818",
		});
	});

	it.each([
		["destino que nao e video", 302, "https://www.facebook.com/login/", 400],
		["Facebook fora do ar", 503, undefined, 503],
	])("compartilhamento com %s responde %i sem criar job", async (_label, upstream, location, status) => {
		const { env, created } = fakeEnv();
		const outbound = async () => new Response(null, { status: upstream, headers: location ? { location } : {} });
		const res = await handleApi(post(JSON.stringify({ url: "https://www.facebook.com/share/r/AAA111/" })), env, outbound);
		expect(res.status).toBe(status);
		expect(created).toHaveLength(0);
	});

	it("URL direta de Instagram e Facebook nao faz requisicao externa", async () => {
		const { env, created } = fakeEnv();
		const outbound = async (): Promise<Response> => {
			throw new Error("nao deveria buscar");
		};
		for (const url of ["https://www.instagram.com/reel/CDUMkliABpa/", "https://www.facebook.com/watch/?v=123456"]) {
			expect((await handleApi(post(JSON.stringify({ url })), env, outbound)).status).toBe(202);
		}
		expect(created.map((j) => j.platform)).toEqual(["instagram", "facebook"]);
	});

	it("PUT em /api/jobs e 405", async () => {
		const { env } = fakeEnv();
		expect((await handleApi(new Request("https://v/api/jobs", { method: "PUT" }), env)).status).toBe(405);
	});
});

describe("GET /api/jobs (recentes)", () => {
	const base = (id: string, status: JobRecord["status"]): JobRecord => ({
		id,
		platform: "x",
		videoId: "1",
		url: "https://x.com/a/status/1",
		status,
		attempts: 1,
		createdAt: 1,
		updatedAt: 2,
	});
	it("lista os jobs do indice com estado publico e ignora os que ja sumiram", async () => {
		const f = fakeEnv();
		const a = "11111111-1111-4111-8111-111111111111";
		const b = "22222222-2222-4222-8222-222222222222";
		const gone = "33333333-3333-4333-8333-333333333333";
		f.jobs.set(a, base(a, "running"));
		f.jobs.set(b, { ...base(b, "done"), bytes: 4 });
		f.files.set(`files/${b}`, { body: "abcd", disposition: "attachment" });
		f.setRecent([
			{ id: a, createdAt: 3 },
			{ id: gone, createdAt: 2 },
			{ id: b, createdAt: 1 },
		]);
		const res = await handleApi(new Request("https://v/api/jobs"), f.env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { jobs: Record<string, unknown>[] };
		expect(body.jobs.map((j) => [j.id, j.status])).toEqual([
			[a, "running"],
			[b, "done"],
		]);
		expect(body.jobs[1].fileUrl).toBe(`/api/files/${b}`);
		expect(body.jobs[0].attempts).toBeUndefined();
	});
});

describe("GET /api/jobs/:id e /api/files/:id", () => {
	const job: JobRecord = {
		id: ID,
		platform: "x",
		videoId: "1",
		url: "https://x.com/a/status/1",
		status: "done",
		attempts: 1,
		createdAt: 1,
		updatedAt: 2,
		title: "t",
		ext: "mp4",
		bytes: 4,
	};

	it("job pronto com arquivo expoe fileUrl", async () => {
		const { env, jobs, files } = fakeEnv();
		jobs.set(ID, job);
		files.set(`files/${ID}`, { body: "abcd", disposition: 'attachment; filename="t.mp4"' });
		const body = (await (await handleApi(new Request(`https://v/api/jobs/${ID}`), env)).json()) as Record<string, unknown>;
		expect(body).toMatchObject({ status: "done", fileUrl: `/api/files/${ID}` });
	});

	it("job pronto sem arquivo vira expired", async () => {
		const { env, jobs } = fakeEnv();
		jobs.set(ID, job);
		const body = (await (await handleApi(new Request(`https://v/api/jobs/${ID}`), env)).json()) as Record<string, unknown>;
		expect(body.status).toBe("expired");
	});

	it.each([
		["sem job (estado ja limpo; o lifecycle ainda nao removeu)", null],
		["job failed", { ...job, status: "failed" as const, error: "x" }],
		["job queued", { ...job, status: "queued" as const }],
		["job running", { ...job, status: "running" as const }],
	])("arquivo no R2 %s nao e servido: 404 (notas P3 do PR #11)", async (_label, record) => {
		const { env, jobs, files } = fakeEnv();
		if (record) jobs.set(ID, record);
		files.set(`files/${ID}`, { body: "abcd", disposition: 'attachment; filename="t.mp4"' });
		const res = await handleApi(new Request(`https://v/api/files/${ID}`), env);
		expect(res.status).toBe(404);
	});

	it("arquivo e servido com metadados, tamanho e sem cache", async () => {
		const { env, files, jobs } = fakeEnv();
		jobs.set(ID, job);
		files.set(`files/${ID}`, { body: "abcd", disposition: 'attachment; filename="t.mp4"' });
		const res = await handleApi(new Request(`https://v/api/files/${ID}`), env);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="t.mp4"');
		expect(res.headers.get("content-length")).toBe("4");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(await res.text()).toBe("abcd");
	});

	it.each([
		[`/api/jobs/${ID}`, 404],
		[`/api/files/${ID}`, 404],
		["/api/jobs/123", 400],
		["/api/files/../../etc", 404],
		["/api/files/11111111-1111-1111-1111-111111111111", 400],
		["/api/nada", 404],
		["/", 404],
	])("%s responde %i", async (path, status) => {
		const { env } = fakeEnv();
		expect((await handleApi(new Request(`https://v${path}`), env)).status).toBe(status);
	});

	it("POST em /api/files/:id e 405", async () => {
		const { env } = fakeEnv();
		expect((await handleApi(new Request(`https://v/api/files/${ID}`, { method: "POST" }), env)).status).toBe(405);
	});
});
