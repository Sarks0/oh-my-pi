/**
 * Task CRUD over Postgres (TASKS-DESIGN §5/§6). Creating a task seeds its
 * exploration graph (origin fact + goal). The autonomy engine (T1) is not here;
 * this is create-and-inspect only.
 */
import type { Db } from "../db/client";
import { PgGraphStore } from "./store";

export type TaskStatus = "draft" | "running" | "paused" | "completed" | "timed_out" | "stopped";

export interface TaskConfig {
	concurrency?: number;
	heartbeatMinutes?: number;
	timeoutMinutes?: number | null;
	dispatchFirstIntent?: boolean;
	allowMutations?: boolean;
	modelChain?: string[];
}

export interface Task {
	id: number;
	name: string | null;
	goal: string;
	description: string | null;
	category: string | null;
	cwd: string | null;
	status: TaskStatus;
	config: TaskConfig;
	createdAt: string;
}

interface TaskRow {
	id: unknown;
	name: string | null;
	goal: string;
	description: string | null;
	category: string | null;
	cwd: string | null;
	status: string;
	config: TaskConfig | null;
	created_at: string | Date;
}

function toTask(row: TaskRow): Task {
	return {
		id: Number(row.id),
		name: row.name,
		goal: row.goal,
		description: row.description,
		category: row.category,
		cwd: row.cwd,
		status: row.status as TaskStatus,
		config: row.config ?? {},
		createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
	};
}

export interface CreateTaskInput {
	goal: string;
	name?: string;
	description?: string;
	category?: string;
	cwd?: string;
	config?: TaskConfig;
}

/** Create a task and seed its exploration graph (origin fact + goal). */
export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
	const [row] = await db`
		INSERT INTO tasks (name, goal, description, category, cwd, config)
		VALUES (${input.name ?? null}, ${input.goal}, ${input.description ?? null}, ${input.category ?? null}, ${input.cwd ?? null}, ${input.config ?? {}})
		RETURNING id, name, goal, description, category, cwd, status, config, created_at`;
	const task = toTask(row as TaskRow);
	await new PgGraphStore(db, task.id).seed(input.goal);
	return task;
}

export async function listTasks(db: Db, limit = 100): Promise<Task[]> {
	const rows = await db`SELECT id, name, goal, description, category, cwd, status, config, created_at FROM tasks ORDER BY created_at DESC LIMIT ${limit}`;
	return rows.map((r: TaskRow) => toTask(r));
}

export async function getTask(db: Db, id: number): Promise<Task | null> {
	const [row] = await db`SELECT id, name, goal, description, category, cwd, status, config, created_at FROM tasks WHERE id=${id}`;
	return row ? toTask(row as TaskRow) : null;
}

export async function setTaskStatus(db: Db, id: number, status: TaskStatus): Promise<void> {
	await db`UPDATE tasks SET status=${status} WHERE id=${id}`;
	await db`INSERT INTO task_activity (task_id, kind, detail) VALUES (${id}, 'status_change', ${status})`;
}

/** A graph store bound to a task. */
export function graphStoreForTask(db: Db, id: number): PgGraphStore {
	return new PgGraphStore(db, id);
}
