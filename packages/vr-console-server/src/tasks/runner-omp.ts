/**
 * OmpRunner — the real TaskAgentRunner (TASKS-DESIGN §3.1). The planner and worker
 * are omp sessions created with the task host tools (host-tools.ts); the engine
 * drives them. This is the Tier-2 path: it needs a working model configured in
 * omp on the host. The engine logic is proven with a mock runner (engine.test.ts);
 * this is the production binding.
 *
 * Cancellation: on the engine's abort signal the in-flight session is disposed, so
 * pause/stop cancels a running planner/worker turn.
 */
import { createAgentSession, type CustomTool, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { GraphNode, GraphStore } from "./store";
import { makeTaskHostTools } from "./host-tools";
import type { TaskAgentRunner } from "./engine";

export interface OmpRunnerOptions {
	/** The task's working dir (a campaign dir): drives MCP discovery for the worker. */
	cwd: string;
}

async function makeSession(cwd: string, customTools: CustomTool[]) {
	const base = await Settings.init({ cwd });
	const settings = base.overlay(
		{ "tools.approvalMode": "always-ask", "autolearn.enabled": false, "memory.backend": "off" },
		{ derived: true },
	);
	const res = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		customTools,
		enableMCP: true, // the worker uses the vr-lab MCP tools (approval-gated)
		enableLsp: false,
		hasUI: false,
	});
	return res.session;
}

/** Run a session's turn, cancelling (disposing) it if the engine aborts. */
async function runTurn(session: { prompt(t: string): Promise<unknown>; dispose(): Promise<void> }, prompt: string, signal: AbortSignal): Promise<void> {
	const onAbort = () => {
		session.dispose().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await session.prompt(prompt);
	} finally {
		signal.removeEventListener("abort", onAbort);
		await session.dispose().catch(() => {});
	}
}

function plannerPrompt(goal: string): string {
	return (
		`You are the task PLANNER. The goal is:\n"${goal}"\n\n` +
		`1. Call graph_overview to read the current exploration graph (goal, open/running intents, facts).\n` +
		`2. Decide the next exploration directions. For each genuinely NEW direction that is not already an open or running intent, call add_intent once. Do not re-emit an intent that already exists in different words. Produce 0 intents only if every direction is already covered or is waiting on running work.\n` +
		`3. Judge whether the goal is met from the facts in the graph, then call report_goal_status exactly once with met=true/false and a one-line reason.\n` +
		`Use ONLY graph_overview, add_intent, and report_goal_status. Then stop.`
	);
}

function workerPrompt(intent: GraphNode): string {
	return (
		`You are a task WORKER. You have claimed this intent:\n"#${intent.id}: ${intent.text}"\n\n` +
		`Do the work to satisfy it using your real tools, then call report_fact with intentId=${intent.id} and a concise result (including a negative result if that is the outcome). Report every concrete fact you establish. If you prove a real, evidenced security finding, call report_finding (intentId=${intent.id}) as well. Then stop. Do not invent new directions — that is the planner's job.`
	);
}

export function makeOmpRunner(opts: OmpRunnerOptions): TaskAgentRunner {
	return {
		async plan(store, goal, signal) {
			let verdict: { met: boolean; reason?: string } = { met: false };
			const goalTool = {
				name: "report_goal_status",
				label: "Report goal status",
				description: "Call exactly once at the end of the round: whether the task goal is met, and a one-line reason.",
				parameters: { type: "object", properties: { met: { type: "boolean" }, reason: { type: "string" } }, required: ["met"], additionalProperties: false },
				approval: "read",
				async execute(_id: string, params: unknown) {
					const p = params as { met?: boolean; reason?: string };
					verdict = { met: !!p.met, reason: p.reason };
					return { content: [{ type: "text" as const, text: "goal status recorded" }] };
				},
			} as unknown as CustomTool;
			const session = await makeSession(opts.cwd, [...makeTaskHostTools(store), goalTool]);
			await runTurn(session, plannerPrompt(goal), signal);
			return verdict;
		},

		async work(store, intent, signal) {
			const session = await makeSession(opts.cwd, makeTaskHostTools(store));
			await runTurn(session, workerPrompt(intent), signal);
		},
	};
}
