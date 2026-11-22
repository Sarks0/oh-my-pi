/**
 * Tasks T0 spike runner (tasks-t0-spike, Tier-2) — the end-to-end proof that an
 * omp session can be given the task host tools and that a planner session writes
 * intents + a worker session writes a fact, all through the real agent loop, with
 * NO approval card for the bookkeeping tools.
 *
 * Needs a working model (configure omp's provider on the host). In an environment
 * with no model it still proves the WIRING: the session is created with the
 * customTools (registration succeeds) and the prompt dispatches up to the model
 * boundary.
 *
 * Run:  bun run packages/vr-console-server/src/tasks/spike-run.ts
 */
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { GraphStore } from "./store";
import { makeTaskHostTools } from "./host-tools";

const GOAL = "Prove a low-priv -> SYSTEM EOP in the demo driver";

async function makeSession(cwd: string, customTools: ReturnType<typeof makeTaskHostTools>) {
	const base = await Settings.init({ cwd });
	// always-ask on purpose: if a host tool carded it would be denied/throw in this
	// headless run, so a clean completion is itself proof the read tier auto-ran.
	const settings = base.overlay(
		{ "tools.approvalMode": "always-ask", "autolearn.enabled": false, "memory.backend": "off" },
		{ derived: true },
	);
	const res = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		customTools,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	return res.session;
}

function log(step: string): void {
	console.log(`\n=== ${step} ===`);
}

async function main(): Promise<void> {
	const cwd = process.cwd();
	const store = new GraphStore();
	store.seed(GOAL);
	const tools = makeTaskHostTools(store);

	log("1. planner session: emit two intents toward the goal");
	const planner = await makeSession(cwd, tools);
	try {
		await planner.prompt(
			`You are the task PLANNER. The goal is: "${GOAL}".\n` +
				`Call graph_overview to see the graph, then call add_intent EXACTLY TWICE with two concrete, ` +
				`different next directions toward the goal. Use ONLY the add_intent and graph_overview tools. Then stop.`,
		);
	} catch (err) {
		console.log(`  planner turn error (expected where no model is configured): ${String(err)}`);
	} finally {
		await planner.dispose();
	}
	console.log(`  frontier open after planner: ${store.overview().frontierOpen}`);

	log("2. worker session: claim one intent and report a fact");
	const worker = await makeSession(cwd, tools);
	try {
		await worker.prompt(
			`You are a task WORKER. Call claim_intent to take one open intent, then call report_fact with ` +
				`its intentId and a one-line result. Use ONLY claim_intent and report_fact. Then stop.`,
		);
	} catch (err) {
		console.log(`  worker turn error (expected where no model is configured): ${String(err)}`);
	} finally {
		await worker.dispose();
	}

	log("3. final exploration graph");
	const o = store.overview();
	console.log(JSON.stringify(o, null, 2));

	const facts = o.nodes.filter(n => n.kind === "fact" && n.state === "confirmed").length;
	const yields = o.edges.filter(e => e.rel === "yields").length;
	console.log(
		`\nRESULT: intents=${o.nodes.filter(n => n.kind === "intent").length} ` +
			`confirmed-facts=${facts} yields-edges=${yields}` +
			`\n${facts >= 1 && yields >= 1 ? "PASS: a worker wrote a fact through the host-tool seam, uncarded." : "INCOMPLETE: no fact recorded (model did not drive the tools — see the turn errors above)."}`,
	);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
