/**
 * TaskEngine — the per-task autonomous loop (TASKS-DESIGN §3.3). ARTEX's per-task
 * goroutines become async loops here: a serialized planner round, a bounded worker
 * pool draining the frontier, re-trigger on change, heartbeat backstop, and
 * pause/resume/stop.
 *
 * The agent is injected (TaskAgentRunner): the real runner drives omp sessions
 * (runner-omp.ts, Tier-2), a mock runner drives the store deterministically so this
 * whole orchestration is unit-testable without a model.
 */
import type { GraphNode, GraphStore } from "./store";

/** How the engine runs the two agent roles. Both roles act ONLY through the store
 *  (the real runner does so via the host tools inside an omp session). */
export interface TaskAgentRunner {
	/** One planner round against the live graph: may add intents / set goals.
	 *  Returns whether the goal is met (and why). */
	plan(store: GraphStore, goal: string, signal: AbortSignal): Promise<{ met: boolean; reason?: string }>;
	/** One worker on a claimed intent: does the work and reports fact(s), which
	 *  settles the intent. Throwing (e.g. on abort) returns the intent to the frontier. */
	work(store: GraphStore, intent: GraphNode, signal: AbortSignal): Promise<void>;
}

export interface EngineOptions {
	/** Max concurrent workers (default 2). */
	concurrency?: number;
	/** Deadlock backstop: a planner round fires at least this often (default 10 min). */
	heartbeatMs?: number;
	/** Safety cap on planner rounds so a never-completing planner can't spin forever. */
	maxRounds?: number;
	onActivity?: (kind: string, detail: string) => void;
	/** Fired whenever the graph changes (for a WS task broadcast). */
	onChange?: () => void;
}

export type EngineState = "idle" | "running" | "paused" | "completed" | "stopped";

export class TaskEngine {
	#state: EngineState = "idle";
	#workers = new Map<number, Promise<void>>();
	#ac = new AbortController();
	#trigger: { promise: Promise<void>; resolve: () => void } | undefined;
	#loopDone: Promise<void> | undefined;
	#rounds = 0;
	#reason: string | undefined;

	readonly concurrency: number;
	readonly heartbeatMs: number;
	readonly maxRounds: number;

	constructor(
		private store: GraphStore,
		private goal: string,
		private runner: TaskAgentRunner,
		private opts: EngineOptions = {},
	) {
		this.concurrency = Math.max(1, opts.concurrency ?? 2);
		this.heartbeatMs = opts.heartbeatMs ?? 10 * 60_000;
		this.maxRounds = opts.maxRounds ?? 1000;
	}

	get state(): EngineState {
		return this.#state;
	}
	get completionReason(): string | undefined {
		return this.#reason;
	}

	#activity(kind: string, detail: string): void {
		this.opts.onActivity?.(kind, detail);
	}
	#onChange(): void {
		this.opts.onChange?.();
	}
	#poke(): void {
		const t = this.#trigger;
		this.#trigger = undefined;
		t?.resolve();
	}

	/** Begin (or resume) the loop. Idempotent while running. */
	start(): void {
		if (this.#state === "running") return;
		this.#state = "running";
		this.#ac = new AbortController();
		this.#loopDone = this.#loop();
	}

	async #loop(): Promise<void> {
		while (this.#state === "running") {
			if (this.#rounds++ >= this.maxRounds) {
				this.#finish("stopped", "max planner rounds reached");
				return;
			}
			const verdict = await this.#plan();
			if ((this.#state as EngineState) !== "running") return;

			await this.#dispatch();

			const empty = await this.#frontierEmpty();
			if (empty && this.#workers.size === 0 && verdict.met) {
				this.#finish("completed", verdict.reason);
				return;
			}
			if ((this.#state as EngineState) !== "running") return;
			await this.#waitForTrigger();
		}
	}

	async #plan(): Promise<{ met: boolean; reason?: string }> {
		try {
			const v = await this.runner.plan(this.store, this.goal, this.#ac.signal);
			this.#activity("planner_round", v.met ? `goal met${v.reason ? `: ${v.reason}` : ""}` : "planner round");
			this.#onChange();
			return v;
		} catch (err) {
			this.#activity("planner_error", String(err));
			return { met: false };
		}
	}

	/** Claim and start workers up to the concurrency limit. */
	async #dispatch(): Promise<void> {
		while (this.#state === "running" && this.#workers.size < this.concurrency) {
			const intent = await this.store.claimIntent();
			if (!intent) break;
			this.#activity("intent_claimed", `#${intent.id} ${intent.text}`);
			const p = this.#runWorker(intent).finally(() => {
				this.#workers.delete(intent.id);
				this.#onChange();
				this.#poke(); // a worker finished → re-plan
			});
			this.#workers.set(intent.id, p);
		}
	}

	async #runWorker(intent: GraphNode): Promise<void> {
		try {
			await this.runner.work(this.store, intent, this.#ac.signal);
			this.#activity("worker_done", `#${intent.id}`);
		} catch (err) {
			// aborted or failed → return the intent to the frontier for a later run
			await this.store.releaseIntent(intent.id).catch(() => {});
			this.#activity("worker_aborted", `#${intent.id}: ${String(err)}`);
		}
	}

	#waitForTrigger(): Promise<void> {
		const tr = Promise.withResolvers<void>();
		this.#trigger = tr;
		const hb = setTimeout(() => this.#poke(), this.heartbeatMs);
		return tr.promise.finally(() => clearTimeout(hb));
	}

	async #frontierEmpty(): Promise<boolean> {
		const o = await this.store.overview();
		return o.frontierOpen === 0 && o.running === 0;
	}

	async #drain(): Promise<void> {
		await Promise.allSettled([...this.#workers.values()]);
		// sweep any intents still 'running' (a worker that neither reported nor released)
		const o = await this.store.overview();
		for (const n of o.nodes) {
			if (n.kind === "intent" && n.state === "running") await this.store.releaseIntent(n.id).catch(() => {});
		}
	}

	#finish(state: "completed" | "stopped", reason?: string): void {
		this.#state = state;
		this.#reason = reason;
		this.#activity("status_change", reason ? `${state}: ${reason}` : state);
	}

	/** Pause: cancel running workers (their intents return to the frontier) and halt
	 *  the loop. Resume with start(). */
	async pause(): Promise<void> {
		if (this.#state !== "running") return;
		this.#state = "paused";
		this.#ac.abort();
		this.#poke();
		await this.#loopDone?.catch(() => {});
		await this.#drain();
		this.#activity("status_change", "paused");
		this.#onChange();
	}

	/** Stop for good. */
	async stop(): Promise<void> {
		if (this.#state === "completed" || this.#state === "stopped") return;
		this.#state = "stopped";
		this.#ac.abort();
		this.#poke();
		await this.#loopDone?.catch(() => {});
		await this.#drain();
		this.#activity("status_change", "stopped");
		this.#onChange();
	}

	/** Wait for the loop to settle (test helper). */
	async settle(): Promise<void> {
		await this.#loopDone?.catch(() => {});
		await Promise.allSettled([...this.#workers.values()]);
	}
}
