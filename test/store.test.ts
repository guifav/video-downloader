import { describe, expect, it } from "vitest";
import { makeJobStore, type StorageLike } from "../src/store";
import type { JobRecord } from "../src/job";

// Storage falso com semantica transacional: escritas dentro da transacao so valem se ela concluir.
function fakeStorage() {
	const data = new Map<string, unknown>();
	let alarm: number | null = null;
	const log: string[] = [];
	let failInside: "put" | "setAlarm" | null = null;
	const storage = {
		async get<T>(key: string) {
			return data.get(key) as T | undefined;
		},
		async deleteAll() {
			log.push("deleteAll");
			data.clear();
		},
		async deleteAlarm() {
			log.push("deleteAlarm");
			alarm = null;
		},
		async transaction<T>(closure: (txn: never) => Promise<T>) {
			log.push("transaction");
			const staged = new Map<string, unknown>();
			let stagedAlarm: number | undefined;
			const txn = {
				async get<T>(key: string) {
					return (staged.has(key) ? staged.get(key) : data.get(key)) as T | undefined;
				},
				async getAlarm() {
					return stagedAlarm ?? alarm;
				},
				async put(key: string, value: unknown) {
					if (failInside === "put") throw new Error("put falhou");
					staged.set(key, value);
				},
				async setAlarm(at: number) {
					if (failInside === "setAlarm") throw new Error("setAlarm falhou");
					stagedAlarm = at;
				},
			};
			const result = await closure(txn as never);
			for (const [k, v] of staged) data.set(k, v);
			if (stagedAlarm !== undefined) alarm = stagedAlarm;
			return result;
		},
	};
	return {
		storage: storage as unknown as StorageLike,
		data,
		log,
		alarm: () => alarm,
		setAlarm: (a: number | null) => (alarm = a),
		failInside: (f: "put" | "setAlarm" | null) => (failInside = f),
	};
}

const job = { id: "j", status: "done" } as unknown as JobRecord;

describe("makeJobStore", () => {
	it("commit grava job e alarm dentro de uma transacao", async () => {
		const f = fakeStorage();
		const store = makeJobStore(f.storage);
		await store.commit(job, 123);
		expect(f.log).toEqual(["transaction"]);
		expect(await store.load()).toEqual(job);
		expect(f.alarm()).toBe(123);
	});

	it("falha no setAlarm nao deixa o estado gravado sozinho", async () => {
		const f = fakeStorage();
		const store = makeJobStore(f.storage);
		f.failInside("setAlarm");
		await expect(store.commit(job, 123)).rejects.toThrow("setAlarm falhou");
		expect(await store.load()).toBeNull();
		expect(f.alarm()).toBeNull();
	});

	it("clear apaga alarm e dados", async () => {
		const f = fakeStorage();
		const store = makeJobStore(f.storage);
		await store.commit(job, 5);
		await store.clear();
		expect(f.log).toEqual(["transaction", "deleteAlarm", "deleteAll"]);
		expect(await store.load()).toBeNull();
		expect(f.alarm()).toBeNull();
	});

	it("armIfIdle arma so quando ha job e nenhum alarm, numa transacao", async () => {
		const f = fakeStorage();
		const store = makeJobStore(f.storage);
		expect(await store.armIfIdle(50)).toBeNull();
		expect(f.alarm()).toBeNull();
		await store.commit(job, 7);
		expect(await store.armIfIdle(50)).toEqual(job);
		expect(f.alarm()).toBe(7);
		f.setAlarm(null);
		f.log.length = 0;
		expect(await store.armIfIdle(50)).toEqual(job);
		expect(f.alarm()).toBe(50);
		expect(f.log).toEqual(["transaction"]);
	});
});
