import type { JobStore } from "./engine";
import type { JobRecord } from "./job";

// Adaptador do storage do Durable Object para o JobStore do motor. Separado de container.ts
// (que importa cloudflare:workers) para ser testavel em Node.

type TxnLike = Pick<DurableObjectTransaction, "put" | "setAlarm" | "get" | "getAlarm">;
export type StorageLike = Pick<DurableObjectStorage, "get" | "deleteAll" | "deleteAlarm"> & {
	transaction<T>(closure: (txn: TxnLike) => Promise<T>): Promise<T>;
};

export function makeJobStore(storage: StorageLike): JobStore {
	return {
		load: async () => (await storage.get<JobRecord>("job")) ?? null,
		// Estado e proximo alarm na mesma transacao: nunca um sem o outro.
		commit: (job, alarmAt) =>
			storage.transaction(async (txn) => {
				await txn.put("job", job);
				await txn.setAlarm(alarmAt);
			}),
		// Watchdog (src/engine.ts): leitura do job, do alarm e o agendamento na mesma transacao, sem
		// regravar o job, para nunca sobrescrever um estado mais novo.
		armIfIdle: (alarmAt) =>
			storage.transaction(async (txn) => {
				const job = (await txn.get<JobRecord>("job")) ?? null;
				if (job && (await txn.getAlarm()) === null) await txn.setAlarm(alarmAt);
				return job;
			}),
		// deleteAll() nao remove o alarm; os dois sao necessarios.
		clear: async () => {
			await storage.deleteAlarm();
			await storage.deleteAll();
		},
	};
}
