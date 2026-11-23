/**
 * GraphStore — the exploration graph (TASKS-DESIGN §3.2 / §5). Two impls behind
 * one async interface:
 *   - MemGraphStore: in-memory, for the spike and unit tests.
 *   - PgGraphStore:  Postgres-backed, per task, for real tasks.
 * The method set is the contract both honour (the spike's in-memory store "carried
 * forward" to Postgres as promised in the T0 plan).
 *
 * Faithful to ARTEX's model (db/constants.go): kinds goal/intent/fact, rels
 * spawns/yields. A worker claims an open intent (open → running) and reports a
 * fact (fact node + `yields` edge), which settles the intent (→ done).
 */
import type { Db } from "../db/client";

export type NodeKind = "goal" | "intent" | "fact" | "finding" | "hint";
export type EdgeRel = "spawns" | "yields" | "proves" | "derived_from";

export interface GraphNode {
	id: number;
	kind: NodeKind;
	/** origin | active (goal) | open/running/done (intent) | confirmed (fact) */
	state: string;
	text: string;
	/** for a fact: the intent it answers */
	intentId?: number;
}

export interface GraphEdge {
	from: number;
	to: number;
	rel: EdgeRel;
}

export interface GraphOverview {
	goal: string | null;
	frontierOpen: number;
	running: number;
	nodes: Array<{ id: number; kind: NodeKind; state: string; text: string }>;
	edges: GraphEdge[];
}

/** The contract the planner/worker host tools depend on. */
export interface GraphStore {
	seed(goal: string): Promise<{ originId: number; goalId: number }>;
	addIntent(text: string): Promise<GraphNode>;
	claimIntent(): Promise<GraphNode | null>;
	reportFact(intentId: number, text: string): Promise<GraphNode>;
	overview(): Promise<GraphOverview>;
}

// ---------------------------------------------------------------------------
// In-memory (spike + tests)
// ---------------------------------------------------------------------------

export class MemGraphStore implements GraphStore {
	#nodes: GraphNode[] = [];
	#edges: GraphEdge[] = [];
	#seq = 0;
	#goalId: number | undefined;

	#add(kind: NodeKind, state: string, text: string): GraphNode {
		const node: GraphNode = { id: ++this.#seq, kind, state, text };
		this.#nodes.push(node);
		return node;
	}
	#edge(from: number, to: number, rel: EdgeRel): void {
		this.#edges.push({ from, to, rel });
	}

	async seed(goal: string): Promise<{ originId: number; goalId: number }> {
		const origin = this.#add("fact", "origin", "task origin");
		const g = this.#add("goal", "active", goal);
		this.#edge(origin.id, g.id, "spawns");
		this.#goalId = g.id;
		return { originId: origin.id, goalId: g.id };
	}

	async addIntent(text: string): Promise<GraphNode> {
		const n = this.#add("intent", "open", text);
		if (this.#goalId !== undefined) this.#edge(this.#goalId, n.id, "spawns");
		return n;
	}

	async claimIntent(): Promise<GraphNode | null> {
		const open = this.#nodes.find(n => n.kind === "intent" && n.state === "open");
		if (!open) return null;
		open.state = "running";
		return open;
	}

	async reportFact(intentId: number, text: string): Promise<GraphNode> {
		const intent = this.#nodes.find(n => n.id === intentId && n.kind === "intent");
		if (!intent) throw new Error(`no such intent: ${intentId}`);
		const fact = this.#add("fact", "confirmed", text);
		fact.intentId = intentId;
		this.#edge(intentId, fact.id, "yields");
		intent.state = "done";
		return fact;
	}

	async overview(): Promise<GraphOverview> {
		const goal = this.#nodes.find(n => n.kind === "goal");
		return {
			goal: goal?.text ?? null,
			frontierOpen: this.#nodes.filter(n => n.kind === "intent" && n.state === "open").length,
			running: this.#nodes.filter(n => n.kind === "intent" && n.state === "running").length,
			nodes: this.#nodes.map(n => ({ id: n.id, kind: n.kind, state: n.state, text: n.text })),
			edges: [...this.#edges],
		};
	}

	nodes(): readonly GraphNode[] {
		return this.#nodes;
	}
	edges(): readonly GraphEdge[] {
		return this.#edges;
	}
}

// ---------------------------------------------------------------------------
// Postgres (one store per task)
// ---------------------------------------------------------------------------

function toNode(row: { id: unknown; kind: string; state: string; text: string; intent_id?: unknown }): GraphNode {
	return {
		id: Number(row.id),
		kind: row.kind as NodeKind,
		state: row.state,
		text: row.text,
		intentId: row.intent_id != null ? Number(row.intent_id) : undefined,
	};
}

export class PgGraphStore implements GraphStore {
	constructor(
		private db: Db,
		private taskId: number,
	) {}

	async seed(goal: string): Promise<{ originId: number; goalId: number }> {
		const [origin] = await this.db`INSERT INTO exploration_nodes (task_id, kind, state, text) VALUES (${this.taskId}, 'fact', 'origin', 'task origin') RETURNING id`;
		const [g] = await this.db`INSERT INTO exploration_nodes (task_id, kind, state, text) VALUES (${this.taskId}, 'goal', 'active', ${goal}) RETURNING id`;
		await this.db`INSERT INTO exploration_edges (task_id, from_id, to_id, rel) VALUES (${this.taskId}, ${origin.id}, ${g.id}, 'spawns')`;
		return { originId: Number(origin.id), goalId: Number(g.id) };
	}

	async #goalNodeId(): Promise<number | undefined> {
		const [g] = await this.db`SELECT id FROM exploration_nodes WHERE task_id=${this.taskId} AND kind='goal' ORDER BY id LIMIT 1`;
		return g ? Number(g.id) : undefined;
	}

	async addIntent(text: string): Promise<GraphNode> {
		const [n] = await this.db`INSERT INTO exploration_nodes (task_id, kind, state, text) VALUES (${this.taskId}, 'intent', 'open', ${text}) RETURNING id, kind, state, text, intent_id`;
		const goalId = await this.#goalNodeId();
		if (goalId !== undefined) await this.db`INSERT INTO exploration_edges (task_id, from_id, to_id, rel) VALUES (${this.taskId}, ${goalId}, ${n.id}, 'spawns')`;
		return toNode(n);
	}

	/** Atomic claim: lock one open intent and flip it, so concurrent workers never
	 *  take the same one (FOR UPDATE SKIP LOCKED). Returns null if the frontier is dry. */
	async claimIntent(): Promise<GraphNode | null> {
		const rows = await this.db`
			UPDATE exploration_nodes SET state='running'
			WHERE id = (
				SELECT id FROM exploration_nodes
				WHERE task_id=${this.taskId} AND kind='intent' AND state='open'
				ORDER BY id LIMIT 1
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, kind, state, text, intent_id`;
		return rows.length ? toNode(rows[0]) : null;
	}

	async reportFact(intentId: number, text: string): Promise<GraphNode> {
		const [intent] = await this.db`SELECT id FROM exploration_nodes WHERE id=${intentId} AND task_id=${this.taskId} AND kind='intent'`;
		if (!intent) throw new Error(`no such intent: ${intentId}`);
		const [fact] = await this.db`INSERT INTO exploration_nodes (task_id, kind, state, text, intent_id) VALUES (${this.taskId}, 'fact', 'confirmed', ${text}, ${intentId}) RETURNING id, kind, state, text, intent_id`;
		await this.db`INSERT INTO exploration_edges (task_id, from_id, to_id, rel) VALUES (${this.taskId}, ${intentId}, ${fact.id}, 'yields')`;
		await this.db`UPDATE exploration_nodes SET state='done' WHERE id=${intentId}`;
		return toNode(fact);
	}

	async overview(): Promise<GraphOverview> {
		const nodes = await this.db`SELECT id, kind, state, text FROM exploration_nodes WHERE task_id=${this.taskId} ORDER BY id`;
		const edges = await this.db`SELECT from_id, to_id, rel FROM exploration_edges WHERE task_id=${this.taskId} ORDER BY id`;
		const goal = nodes.find((n: { kind: string }) => n.kind === "goal") as { text: string } | undefined;
		const intents = nodes.filter((n: { kind: string }) => n.kind === "intent");
		return {
			goal: goal?.text ?? null,
			frontierOpen: intents.filter((n: { state: string }) => n.state === "open").length,
			running: intents.filter((n: { state: string }) => n.state === "running").length,
			nodes: nodes.map((n: { id: unknown; kind: string; state: string; text: string }) => ({ id: Number(n.id), kind: n.kind as NodeKind, state: n.state, text: n.text })),
			edges: edges.map((e: { from_id: unknown; to_id: unknown; rel: string }) => ({ from: Number(e.from_id), to: Number(e.to_id), rel: e.rel as EdgeRel })),
		};
	}
}
