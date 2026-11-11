import type { AppEnv } from "./container";
import { handleRequest, type GatewayEnv } from "./gateway";
import { fileKey, type JobRecord } from "./job";
import { resolveVideoUrl } from "./share";
import { runScheduled, SMOKE_CASES } from "./smoke";

export { JobContainer } from "./container";
export { JobIndex } from "./job-index";

export default {
	fetch(request: Request, env: AppEnv): Promise<Response> {
		// O stub RPC do Durable Object expoe create/get com tipos de serializacao do runtime;
		// GatewayEnv descreve o mesmo contrato de forma testavel em Node.
		return handleRequest(request, env as unknown as GatewayEnv);
	},

	// Smoke semanal (src/smoke.ts). Roda dentro do Worker: nao passa pelo Access e usa a egress
	// Cloudflare, como os jobs reais.
	async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
		await runScheduled(controller.cron, controller.scheduledTime, {
			cases: SMOKE_CASES,
			now: () => Date.now(),
			uuid: () => crypto.randomUUID(),
			resolve: (url) => resolveVideoUrl(url, (u, init) => fetch(u, init)),
			createJob: async (job: JobRecord) => {
				await env.JOBS.getByName(job.id).create(job);
			},
			index: (name) => env.JOB_INDEX.getByName(name),
			getJob: async (id) => (await env.JOBS.getByName(id).get()) as JobRecord | null,
			fileExists: async (id) => (await env.FILES.head(fileKey(id))) !== null,
			// Relatorio por email so quando configurado (vars ALERT_EMAIL_FROM/ALERT_EMAIL_TO e o
			// binding send_email no wrangler.jsonc); sem isso, o assunto fica so no log do Worker.
			send: async (subject, text) => {
				const from = (env.ALERT_EMAIL_FROM ?? "").trim();
				const to = (env.ALERT_EMAIL_TO ?? "").trim();
				if (!from || !to || !env.ALERT_EMAIL) return;
				await env.ALERT_EMAIL.send({ from, to, subject, text });
			},
		});
	},
} satisfies ExportedHandler<AppEnv>;
