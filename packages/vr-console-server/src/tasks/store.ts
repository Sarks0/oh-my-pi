/**
 * GraphStore — the T0-spike exploration graph (TASKS-DESIGN §3.2, tasks-t0-spike).
 *
 * In-memory for the spike; T0-proper swaps the backing for Postgres (the methods
 * are the contract that carries forward). Nodes carry a `kind` and `state`; edges
 * a `rel`. The frontier is "intents in state open/running". A worker claims an
 * open intent (open → running) and reports a fact (a fact node + a `yields` edge),
 * which settles the intent (→ done).
 *
 * Faithful to ARTEX's model (db/constants.go): kinds goal/intent/fact, rels
 * spawns/yields. finding/hint/digest are deferred past the spike.
 */
export type NodeKind = "goal" | "intent" | "fact";
export type EdgeRel = "spawns" | "yields";

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

export class GraphStore {
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

	/** Seed the root: an origin fact and the goal, linked (the graph's start). */
	seed(goal: string): { originId: number; goalId: number } {
		const origin = this.#add("fact", "origin", "task origin");
		const g = this.#add("goal", "active", goal);
		this.#edge(origin.id, g.id, "spawns");
		this.#goalId = g.id;
		return { originId: origin.id, goalId: g.id };
	}

	/** Planner: emit a new exploration intent into the frontier (state open). */
	addIntent(text: string): GraphNode {
		const n = this.#add("intent", "open", text);
		if (this.#goalId !== undefined) this.#edge(this.#goalId, n.id, "spawns");
		return n;
	}

	/** Worker: claim one open intent (open → running). Returns null if none open.
	 *  In-process this is trivially atomic; T0-proper does it as a Postgres
	 *  `UPDATE … WHERE state='open' RETURNING` so concurrent workers never collide. */
	claimIntent(): GraphNode | null {
		const open = this.#nodes.find(n => n.kind === "intent" && n.state === "open");
		if (!open) return null;
		open.state = "running";
		return open;
	}

	/** Worker: record a fact for an intent (fact node + `yields` edge) and settle
	 *  the intent (→ done). Throws if the intent id is unknown. */
	reportFact(intentId: number, text: string): GraphNode {
		const intent = this.#nodes.find(n => n.id === intentId && n.kind === "intent");
		if (!intent) throw new Error(`no such intent: ${intentId}`);
		const fact = this.#add("fact", "confirmed", text);
		fact.intentId = intentId;
		this.#edge(intentId, fact.id, "yields");
		intent.state = "done";
		return fact;
	}

	overview(): GraphOverview {
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
