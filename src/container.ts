import { DurableObject } from "cloudflare:workers";
import { JobEngine, type JobBox } from "./engine";
import { makeJobStore, type StorageLike } from "./store";
import type { JobRecord } from "./job";

// Um Durable Object por job: guarda o estado e controla um container dedicado. Toda a logica
// do job esta em JobEngine (src/engine.ts); esta classe so liga o motor ao runtime.

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 60 * 1000;

export interface AppEnv extends Env {
	YT_COOKIES_B64?: string;
	IG_COOKIES_B64?: string;
	FB_COOKIES_B64?: string;
}

export class JobContainer extends DurableObject<AppEnv> {
	private readonly engine: JobEngine;

	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		const storage = ctx.storage;

		const store = makeJobStore(storage as unknown as StorageLike);

		const box: JobBox = {
			ensureStarted: async () => {
				const container = ctx.container!;
				if (!container.running) {
					const containerEnv: Record<string, string> = {};
					// Cookies opcionais de conta descartavel, um secret por plataforma (container/app.py).
					for (const name of ["YT_COOKIES_B64", "IG_COOKIES_B64", "FB_COOKIES_B64"] as const) {
						const value = env[name];
						if (value) containerEnv[name] = value;
					}
					container.start({
						image: container.images.base,
						// 4 vCPU: a conversao para H.264 (container/app.py) roda perto de 2,5x o tempo real em
						// 1080p; com standard-1 um video de 10 min nao cabia no prazo (issue #6).
						instance: "standard-4",
						enableInternet: true,
						env: containerEnv,
					});
				}
				await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
			},
			fetch: (path, init) => ctx.container!.getTcpPort(PORT).fetch(`http://container${path}`, init),
			destroy: async () => {
				if (ctx.container?.running) await ctx.container.destroy();
			},
		};

		this.engine = new JobEngine({
			store,
			box,
			files: {
				put: async (key, body, options) => {
					await env.FILES.put(key, body, {
						httpMetadata: { contentType: options.contentType, contentDisposition: options.contentDisposition },
						customMetadata: options.customMetadata,
					});
				},
				head: async (key) => {
					const object = await env.FILES.head(key);
					return object ? { size: object.size, customMetadata: object.customMetadata ?? {} } : null;
				},
				delete: (key) => env.FILES.delete(key),
			},
			clock: { now: () => Date.now(), sleep: (ms) => scheduler.wait(ms) },
			makeSized: (bytes) => new FixedLengthStream(bytes),
		});
	}

	create(job: JobRecord): Promise<JobRecord> {
		return this.engine.create(job);
	}

	// Toda consulta (UI, lista, smoke) passa pelo watchdog: job sem alarm e rearmado (src/engine.ts).
	get(): Promise<JobRecord | null> {
		return this.engine.watchdog();
	}

	alarm(): Promise<void> {
		return this.engine.onAlarm();
	}
}
