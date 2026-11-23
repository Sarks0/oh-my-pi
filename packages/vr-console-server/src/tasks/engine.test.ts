import { describe, expect, test } from "bun:test";
import { MemGraphStore } from "./store";
import { TaskEngine, type TaskAgentRunner } from "./engine";

/** A planner that seeds a fixed set of intents once, then declares the goal met
 *  as soon as the frontier is drained. The worker reports a fact for each intent. */
function autoRunner(intents: string[]): TaskAgentRunner {
	let planned = false;
	return {
		async plan(store) {
			if (!planned) {
				for (const t of intents) await store.addIntent(t);
				planned = true;
				return { met: false };
			}
			const o = await store.overview();
			const drained = o.frontierOpen === 0 && o.running === 0;
			return { met: drained, reason: drained ? "all intents resolved" : undefined };
		},
		async work(store, intent) {
			await store.reportFact(intent.id, `result for ${intent.text}`);
		},
	};
}

const until = async (cond: () => Promise<boolean> | boolean, ms = 2000): Promise<void> => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await cond()) return;
		await Bun.sleep(5);
	}
	throw new Error("timeout waiting for condition");
};

describe("TaskEngine — the autonomous loop", () => {
	test("drives a goal to completion: plan → dispatch → facts → goal met", async () => {
		const store = new MemGraphStore();
		await store.seed("prove the EOP");
		const engine = new TaskEngine(store, "prove the EOP", autoRunner(["a", "b", "c"]), { heartbeatMs: 50 });
		engine.start();
		await engine.settle();

		expect(engine.state).toBe("completed");
		expect(engine.completionReason).toMatch(/resolved/);
		const o = await store.overview();
		expect(o.frontierOpen).toBe(0);
		expect(o.nodes.filter(n => n.kind === "fact" && n.state === "confirmed")).toHaveLength(3); // one per intent
		expect(o.nodes.filter(n => n.kind === "intent" && n.state === "done")).toHaveLength(3);
	});

	test("never runs more workers than the concurrency limit", async () => {
		const store = new MemGraphStore();
		await store.seed("g");
		let active = 0;
		let peak = 0;
		const runner: TaskAgentRunner = {
			...autoRunner(["1", "2", "3", "4", "5", "6"]),
			async work(s, intent) {
				active++;
				peak = Math.max(peak, active);
				await Bun.sleep(10);
				await s.reportFact(intent.id, "x");
				active--;
			},
		};
		const engine = new TaskEngine(store, "g", runner, { concurrency: 2, heartbeatMs: 50 });
		engine.start();
		await engine.settle();

		expect(engine.state).toBe("completed");
		expect(peak).toBeLessThanOrEqual(2); // the pool never exceeded the limit
		expect((await store.overview()).nodes.filter(n => n.kind === "fact" && n.state === "confirmed")).toHaveLength(6);
	});

	test("pause cancels in-flight work and returns its intent to the frontier", async () => {
		const store = new MemGraphStore();
		await store.seed("g");
		// a worker that blocks until aborted (never reports a fact on its own)
		const runner: TaskAgentRunner = {
			async plan(s) {
				if ((await s.overview()).nodes.every(n => n.kind !== "intent")) {
					await s.addIntent("long-running");
					return { met: false };
				}
				return { met: false };
			},
			async work(_s, _intent, signal) {
				await new Promise<void>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
			},
		};
		const engine = new TaskEngine(store, "g", runner, { heartbeatMs: 10_000 });
		engine.start();
		await until(async () => (await store.overview()).running === 1); // worker claimed it

		await engine.pause();
		expect(engine.state).toBe("paused");
		const o = await store.overview();
		expect(o.running).toBe(0); // no longer running
		expect(o.frontierOpen).toBe(1); // the intent is back on the frontier for later
	});

	test("stop halts the loop", async () => {
		const store = new MemGraphStore();
		await store.seed("g");
		const runner: TaskAgentRunner = {
			async plan(s) {
				if ((await s.overview()).nodes.every(n => n.kind !== "intent")) await s.addIntent("x");
				return { met: false };
			},
			async work(_s, _i, signal) {
				await new Promise<void>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
			},
		};
		const engine = new TaskEngine(store, "g", runner, { heartbeatMs: 10_000 });
		engine.start();
		await until(async () => (await store.overview()).running === 1);
		await engine.stop();
		expect(engine.state).toBe("stopped");
		expect((await store.overview()).running).toBe(0);
	});
});
