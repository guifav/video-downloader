// @ts-expect-error tipos do Node nao fazem parte do tsconfig do Worker
import { readFileSync } from "node:fs";
// @ts-expect-error tipos do Node nao fazem parte do tsconfig do Worker
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Executa o <script> real de public/index.html num contexto isolado com DOM e fetch falsos.
// Cobre U2 (polling resiliente), U3 (restore sem download automatico) e a corrida restore x envio,
// esta com timers controlaveis (nota do Astra no PR #4, follow-up #5).

// vitest roda a partir da raiz do projeto
const html: string = readFileSync("public/index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];

class El {
	children: El[] = [];
	textContent = "";
	className = "";
	value = "";
	disabled = false;
	href = "";
	title = "";
	clicks = 0;
	listeners: Record<string, (e: { preventDefault(): void }) => void> = {};
	constructor(public tag = "div") {}
	append(...els: El[]) {
		for (const e of els) {
			this.children = this.children.filter((c) => c !== e);
			this.children.push(e);
		}
	}
	prepend(e: El) {
		this.children = [e, ...this.children.filter((c) => c !== e)];
	}
	replaceChildren() {
		this.children = [];
	}
	querySelector(sel: string): El | null {
		for (const c of this.children) {
			if (c.tag === sel) return c;
			const deep = c.querySelector(sel);
			if (deep) return deep;
		}
		return null;
	}
	addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) {
		this.listeners[type] = fn;
	}
	focus() {}
	click() {
		this.clicks++;
	}
	text(): string {
		return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(" | ");
	}
}

type Reply =
	| { status: number; body?: unknown; headers?: Record<string, string>; truncated?: boolean }
	| { networkError: true }
	| { redirect: true };

function respond(r: Reply) {
	if ("networkError" in r) return Promise.reject(new TypeError("Failed to fetch"));
	if ("redirect" in r) return Promise.resolve({ type: "opaqueredirect", status: 0, ok: false, headers: new Map(), json: async () => null });
	const headers = new Map(Object.entries(r.headers ?? {}));
	return Promise.resolve({
		type: "basic",
		status: r.status,
		ok: r.status >= 200 && r.status < 300,
		headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
		body: { cancel: async () => {} },
		json: async () => {
			if (r.truncated) throw new SyntaxError("Unexpected end of JSON input");
			return r.body;
		},
	});
}

// Timers: "auto" dispara cada setTimeout num microtask (polling corre sozinho); "manual" segura os
// timers ate o teste chamar fire(), para provar o estado do polling no meio de uma corrida.
function harness(
	routes: { list: () => Promise<unknown>; post?: () => Promise<unknown>; poll: (id: string) => Reply },
	timers: "auto" | "manual" = "auto",
) {
	const pending: (() => void)[] = [];
	const polls: string[] = [];
	const els: Record<string, El> = {
		form: new El("form"),
		url: new El("input"),
		submit: new El("button"),
		"form-error": new El("p"),
		jobs: new El("ul"),
	};
	const fetchFn = (path: string, options?: { method?: string }) => {
		if (path === "/api/jobs" && options?.method === "POST") return routes.post!();
		if (path === "/api/jobs") return routes.list();
		const id = path.split("/").pop()!;
		polls.push(id);
		return respond(routes.poll(id));
	};
	const context = {
		document: {
			getElementById: (id: string) => els[id],
			createElement: (tag: string) => new El(tag),
		},
		fetch: fetchFn,
		setTimeout: (fn: () => void) => (timers === "auto" ? queueMicrotask(fn) : pending.push(fn)),
		Date,
		Math,
		JSON,
		Error,
		Promise,
		Set,
		Map,
		console,
		queueMicrotask,
	};
	runInNewContext(script, context);
	const items = () => els.jobs.children;
	const submit = (url: string) => {
		els.url.value = url;
		els.form.listeners.submit({ preventDefault() {} });
	};
	// Dispara so os timers pendentes agora (uma volta do polling de cada job), nunca os novos. Cada
	// timer e uma macrotarefa: as microtasks que ele gera drenam antes do proximo, como no navegador.
	const fire = async () => {
		for (const fn of pending.splice(0)) {
			fn();
			await settle();
		}
	};
	return { els, items, submit, fire, pending: () => pending.length, polls };
}

const settle = async (rounds = 60) => {
	for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
	id,
	platform: "youtube",
	url: `https://www.youtube.com/watch?v=${id}`,
	status,
	createdAt: Date.now(),
	...extra,
});
const done = (id: string) => job(id, "done", { title: "T", bytes: 10, fileUrl: `/api/files/${id}` });

describe("UI (script real de public/index.html)", () => {
	it("U3: job restaurado que termina nao dispara download", async () => {
		let polls = 0;
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [job("r", "running")] } }),
			poll: () => (++polls < 2 ? { status: 200, body: job("r", "running") } : { status: 200, body: done("r") }),
		});
		await settle();
		expect(h.items()[0].className).toBe("status-done");
		expect(h.items()[0].querySelector("a")!.clicks).toBe(0);
	});

	it("job enviado que termina dispara download uma vez", async () => {
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [] } }),
			post: () => respond({ status: 202, body: job("n", "queued") }),
			poll: () => ({ status: 200, body: done("n") }),
		});
		h.submit("https://youtu.be/n");
		await settle();
		expect(h.items()[0].querySelector("a")!.clicks).toBe(1);
	});

	it("corrida: envio promove o job do restore com o polling ainda pendente e baixa quando ele termina (Kimi R2)", async () => {
		let releasePost!: () => void;
		const postGate = new Promise<void>((r) => (releasePost = r));
		let finished = false;
		const h = harness(
			{
				list: () => respond({ status: 200, body: { jobs: [job("x", "running")] } }),
				post: async () => {
					await postGate;
					return respond({ status: 202, body: job("x", "queued") });
				},
				poll: () => ({ status: 200, body: finished ? done("x") : job("x", "running") }),
			},
			"manual",
		);
		h.submit("https://youtu.be/x");
		await settle();
		// restore ja acompanha o job e o polling dele esta parado no timer
		expect(h.pending()).toBe(1);
		expect(h.polls).toHaveLength(0);
		releasePost();
		await settle();
		// promovido sem novo acompanhamento: um timer so, nenhuma consulta, nenhum clique ainda
		expect(h.items()).toHaveLength(1);
		expect(h.pending()).toBe(1);
		expect(h.polls).toHaveLength(0);
		expect(h.items()[0].querySelector("a")).toBeNull();
		await h.fire();
		expect(h.polls).toEqual(["x"]);
		expect(h.items()[0].className).toBe("status-running");
		finished = true;
		await h.fire();
		expect(h.items()[0].className).toBe("status-done");
		expect(h.items()[0].querySelector("a")!.clicks).toBe(1);
		expect(h.pending()).toBe(0);
	});

	it("corrida: restore termina o job antes da resposta do POST e o envio baixa na hora, uma vez", async () => {
		let releasePost!: () => void;
		const postGate = new Promise<void>((r) => (releasePost = r));
		const h = harness(
			{
				list: () => respond({ status: 200, body: { jobs: [job("y", "running")] } }),
				post: async () => {
					await postGate;
					return respond({ status: 202, body: job("y", "queued") });
				},
				poll: () => ({ status: 200, body: done("y") }),
			},
			"manual",
		);
		h.submit("https://youtu.be/y");
		await settle();
		await h.fire();
		// restore levou o job ate o fim sem baixar (U3)
		expect(h.items()[0].className).toBe("status-done");
		expect(h.items()[0].querySelector("a")!.clicks).toBe(0);
		expect(h.pending()).toBe(0);
		releasePost();
		await settle();
		// o envio clica na hora, sem timer nem consulta nova
		expect(h.items()[0].querySelector("a")!.clicks).toBe(1);
		expect(h.polls).toEqual(["y"]);
		expect(h.pending()).toBe(0);
		await h.fire();
		expect(h.items()[0].querySelector("a")!.clicks).toBe(1);
	});

	it.each([
		["queda de rede", { networkError: true } as Reply],
		["200 com JSON cortado", { status: 200, truncated: true } as Reply],
		["403 access_unavailable", { status: 403, headers: { "x-access-denial": "unavailable" }, body: { code: "access_unavailable" } } as Reply],
		["403 access_unavailable com corpo cortado", { status: 403, headers: { "x-access-denial": "unavailable" }, truncated: true } as Reply],
		["500", { status: 500, body: { error: "x" } } as Reply],
	])("U2: %s no meio do polling nao falha o job e ele conclui", async (_label, glitch) => {
		let polls = 0;
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [job("g", "running")] } }),
			poll: () => {
				polls++;
				if (polls === 1) return glitch;
				return { status: 200, body: done("g") };
			},
		});
		await settle();
		expect(polls).toBeGreaterThanOrEqual(2);
		expect(h.items()[0].className).toBe("status-done");
	});

	it.each([
		["403 access_denied", { status: 403, headers: { "x-access-denial": "denied" }, body: { code: "access_denied" } } as Reply, "Sessão expirada"],
		["redirect do Access", { redirect: true } as Reply, "Sessão expirada"],
		["404", { status: 404, body: { error: "Job nao encontrado ou expirado." } } as Reply, "Job nao encontrado"],
	])("%s encerra o acompanhamento com a mensagem certa", async (_label, reply, message) => {
		let polls = 0;
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [job("t", "running")] } }),
			poll: () => {
				polls++;
				return reply;
			},
		});
		await settle();
		expect(polls).toBe(1);
		expect(h.items()[0].className).toBe("status-failed");
		expect(h.items()[0].text()).toContain(message);
	});

	it("job concluido com aviso mostra o aviso; sem aviso, nada", async () => {
		const warning = "Video em VP9: nao deu tempo de converter para H.264.";
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [{ ...done("w"), warning }, done("n")] } }),
			poll: (id) => ({ status: 200, body: id === "w" ? { ...done("w"), warning } : done("n") }),
		});
		await settle();
		const [withWarning, plain] = h.items();
		expect(withWarning.children.some((c) => c.className === "meta warning" && c.textContent === warning)).toBe(true);
		expect(plain.children.some((c) => c.className === "meta warning")).toBe(false);
	});

	it("job concluido mostra a resolucao entregue junto da plataforma e do tamanho (follow-up #5)", async () => {
		const h = harness({
			list: () => respond({ status: 200, body: { jobs: [{ ...done("r"), resolution: "720p" }, done("s")] } }),
			poll: (id) => ({ status: 200, body: id === "r" ? { ...done("r"), resolution: "720p" } : done("s") }),
		});
		await settle();
		const [withRes, plain] = h.items();
		expect(withRes.children.find((c) => c.className === "meta")!.textContent).toBe("YouTube · 10 B · 720p");
		expect(plain.children.find((c) => c.className === "meta")!.textContent).toBe("YouTube · 10 B");
	});

	it("titulos e erros entram como texto, nunca como HTML", async () => {
		const evil = '<img src=x onerror="alert(1)">';
		const h = harness({
			list: () =>
				respond({ status: 200, body: { jobs: [job("e", "failed", { error: evil }), { ...done("d"), title: evil }] } }),
			poll: () => ({ status: 200, body: done("d") }),
		});
		await settle();
		const texts = h.items().map((li) => li.text());
		expect(texts.join(" ")).toContain(evil);
		expect(html).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
	});
});
