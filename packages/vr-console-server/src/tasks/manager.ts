/**
 * TaskManager — owns the live TaskEngine per running task and reflects engine
 * state back to the tasks table + task_activity (TASKS-DESIGN §3.3 control). The
 * server's control route (start/pause/resume/stop) goes through here.
 */
import type { Db } from "../db/client";
import { TaskEngine } from "./engine";
import { makeOmpRunner } from "./runner-omp";
import { getTask, graphStoreForTask, type TaskStatus } from "./tasks";

export class TaskManager {
	#engines = new Map<number, TaskEngine>();

	constructor(
		private db: Db,
		private defaultCwd: string,
	) {}

	async #setStatus(id: number, status: TaskStatus): Promise<void> {
		await this.db`UPDATE tasks SET status=${status} WHERE id=${id}`;
	}
	#logActivity(id: number, kind: string, detail: string): void {
		this.db`INSERT INTO task_activity (task_id, kind, detail) VALUES (${id}, ${kind}, ${detail})`.catch(() => {});
	}

	/** Start (or resume) a task's engine. */
	async start(id: number): Promise<void> {
		const existing = this.#engines.get(id);
		if (existing) {
			if (existing.state === "running") return;
			if (existing.state === "paused") {
				existing.start();
				await this.#setStatus(id, "running");
				return;
			}
		}
		const task = await getTask(this.db, id);
		if (!task) throw new Error(`no such task: ${id}`);

		const engine = new TaskEngine(graphStoreForTask(this.db, id), task.goal, makeOmpRunner({ cwd: task.cwd ?? this.defaultCwd }), {
			concurrency: task.config.concurrency,
			heartbeatMs: task.config.heartbeatMinutes != null ? task.config.heartbeatMinutes * 60_000 : undefined,
			maxRounds: task.config.timeoutMinutes != null ? undefined : undefined,
			onActivity: (kind, detail) => this.#logActivity(id, kind, detail),
		});
		this.#engines.set(id, engine);
		engine.start();
		await this.#setStatus(id, "running");
		void this.#reflectTermination(id, engine);
	}

	/** When the loop ends on its own (goal met / max rounds), mirror the terminal
	 *  state onto the task row and drop the engine. Pause/stop handle their own. */
	async #reflectTermination(id: number, engine: TaskEngine): Promise<void> {
		await engine.settle();
		if (engine.state === "completed") {
			await this.#setStatus(id, "completed");
			this.#engines.delete(id);
		} else if (engine.state === "stopped") {
			await this.#setStatus(id, "stopped");
			this.#engines.delete(id);
		}
	}

	async pause(id: number): Promise<void> {
		const e = this.#engines.get(id);
		if (e) await e.pause();
		await this.#setStatus(id, "paused");
	}

	async stop(id: number): Promise<void> {
		const e = this.#engines.get(id);
		if (e) {
			await e.stop();
			this.#engines.delete(id);
		}
		await this.#setStatus(id, "stopped");
	}

	state(id: number): string | undefined {
		return this.#engines.get(id)?.state;
	}

	async disposeAll(): Promise<void> {
		await Promise.all([...this.#engines.values()].map(e => e.stop().catch(() => {})));
		this.#engines.clear();
	}
}
