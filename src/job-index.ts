import { DurableObject } from "cloudflare:workers";
import { addRecent, pruneRecent, type RecentEntry } from "./recent";

// Indice dos jobs recentes de um usuario: uma instancia por email do Access (indexName em src/api.ts).
export class JobIndex extends DurableObject {
	async add(entry: RecentEntry): Promise<void> {
		const list = (await this.ctx.storage.get<RecentEntry[]>("recent")) ?? [];
		await this.ctx.storage.put("recent", addRecent(list, entry, Date.now()));
	}

	async list(): Promise<RecentEntry[]> {
		const list = (await this.ctx.storage.get<RecentEntry[]>("recent")) ?? [];
		const pruned = pruneRecent(list, Date.now());
		if (pruned.length !== list.length) await this.ctx.storage.put("recent", pruned);
		return pruned;
	}
}
