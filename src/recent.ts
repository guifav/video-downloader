// Lista de jobs recentes (decisao: estado no servidor, nao no navegador). Permite reencontrar
// jobs depois de recarregar a pagina e entre aparelhos. Puro e testavel; o Durable Object
// JobIndex (src/job-index.ts) so persiste o array.

export interface RecentEntry {
	id: string;
	createdAt: number;
}

// Mesma janela do arquivo (24 h) com folga para um job que termina perto do fim.
export const RECENT_WINDOW_MS = 25 * 60 * 60 * 1000;
export const RECENT_MAX = 50;

export function addRecent(list: RecentEntry[], entry: RecentEntry, now: number): RecentEntry[] {
	const kept = pruneRecent(list.filter((e) => e.id !== entry.id), now);
	return [entry, ...kept].slice(0, RECENT_MAX);
}

export function pruneRecent(list: RecentEntry[], now: number): RecentEntry[] {
	return list
		.filter((e) => now - e.createdAt < RECENT_WINDOW_MS)
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, RECENT_MAX);
}
