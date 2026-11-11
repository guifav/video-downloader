import { describe, expect, it } from "vitest";
import { addRecent, pruneRecent, RECENT_MAX, RECENT_WINDOW_MS } from "../src/recent";

const NOW = 1_800_000_000_000;

describe("recentes", () => {
	it("adiciona no topo, sem duplicar", () => {
		const list = addRecent([{ id: "a", createdAt: NOW - 10 }], { id: "b", createdAt: NOW }, NOW);
		expect(list.map((e) => e.id)).toEqual(["b", "a"]);
		expect(addRecent(list, { id: "a", createdAt: NOW + 1 }, NOW + 1).map((e) => e.id)).toEqual(["a", "b"]);
	});
	it("descarta o que passou da janela e limita o tamanho", () => {
		const old = { id: "old", createdAt: NOW - RECENT_WINDOW_MS };
		const many = Array.from({ length: RECENT_MAX + 10 }, (_, i) => ({ id: `j${i}`, createdAt: NOW - i }));
		const out = pruneRecent([old, ...many], NOW);
		expect(out).toHaveLength(RECENT_MAX);
		expect(out.find((e) => e.id === "old")).toBeUndefined();
		expect(out[0].id).toBe("j0");
	});
});
