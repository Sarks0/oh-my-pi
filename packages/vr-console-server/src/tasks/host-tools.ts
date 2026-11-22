/**
 * Task host tools (tasks-t0-spike) — the four omp `customTools` the planner and
 * worker use to read and mutate the exploration GraphStore. They are declared
 * `approval: "read"`, which omp's gate auto-allows even under always-ask
 * (tools/approval.ts:206 → `tier === "read"` ⇒ policy "allow"). So the graph
 * bookkeeping never raises a card; only real work tools (Bash, vr-lab MCP) do.
 *
 * Wired into a session via `createAgentSession({ customTools })` (sdk.ts:790).
 * `parameters` is a plain JSON Schema object (omp's accepted "legacy" form) so
 * this needs no schema library — it resolves against the published omp SDK too.
 */
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { GraphStore } from "./store";

/** A text tool result in omp's shape. */
function text(s: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: s }] };
}

/** A JSON Schema object for a tool's parameters. */
function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: "object", properties, required, additionalProperties: false };
}

/** Build the task host tools over a store. The `read` tier is the whole point:
 *  these mutate console-domain state (the graph), not a target, so they must not
 *  card — otherwise an autonomous run drowns the operator in approvals. */
export function makeTaskHostTools(store: GraphStore): CustomTool[] {
	const tools = [
		{
			name: "graph_overview",
			label: "Graph overview",
			description: "Read the current exploration graph: the goal, frontier counts, nodes and edges.",
			parameters: objectSchema({}),
			approval: "read",
			async execute() {
				return text(JSON.stringify(store.overview()));
			},
		},
		{
			name: "add_intent",
			label: "Add intent",
			description: "Emit one exploration intent into the frontier (a direction a worker should pursue).",
			parameters: objectSchema({ text: { type: "string", description: "The intent, one concrete next direction." } }, ["text"]),
			approval: "read",
			async execute(_id: string, params: unknown) {
				const p = params as { text: string };
				const n = store.addIntent(p.text);
				return text(`intent #${n.id} added to the frontier`);
			},
		},
		{
			name: "claim_intent",
			label: "Claim intent",
			description: "Claim one open intent from the frontier to work on (open → running). Returns null if none are open.",
			parameters: objectSchema({}),
			approval: "read",
			async execute() {
				const n = store.claimIntent();
				return text(n ? JSON.stringify({ intentId: n.id, text: n.text }) : "no open intents");
			},
		},
		{
			name: "report_fact",
			label: "Report fact",
			description: "Record a fact (result or conclusion, including a negative result) for the intent you claimed; settles the intent.",
			parameters: objectSchema(
				{
					intentId: { type: "number", description: "The id returned by claim_intent." },
					text: { type: "string", description: "The fact you found." },
				},
				["intentId", "text"],
			),
			approval: "read",
			async execute(_id: string, params: unknown) {
				const p = params as { intentId: number; text: string };
				const f = store.reportFact(p.intentId, p.text);
				return text(`fact #${f.id} recorded (yields intent #${p.intentId})`);
			},
		},
	];
	return tools as unknown as CustomTool[];
}
