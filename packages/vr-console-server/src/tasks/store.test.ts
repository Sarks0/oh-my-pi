import { describe, expect, test } from "bun:test";
import { MemGraphStore } from "./store";
import { makeTaskHostTools } from "./host-tools";

describe("MemGraphStore — the exploration graph contract", () => {
	test("seed creates an origin fact and a goal, linked", async () => {
		const s = new MemGraphStore();
		const { originId, goalId } = await s.seed("find an EOP");
		expect((await s.overview()).goal).toBe("find an EOP");
		expect(s.nodes().find(n => n.id === originId)).toMatchObject({ kind: "fact", state: "origin" });
		expect(s.nodes().find(n => n.id === goalId)).toMatchObject({ kind: "goal", state: "active" });
		expect(s.edges()).toContainEqual({ from: originId, to: goalId, rel: "spawns" });
	});

	test("addIntent puts an open intent on the frontier, linked from the goal", async () => {
		const s = new MemGraphStore();
		const { goalId } = await s.seed("g");
		const i = await s.addIntent("enumerate the IOCTL handlers");
		expect(i).toMatchObject({ kind: "intent", state: "open" });
		expect((await s.overview()).frontierOpen).toBe(1);
		expect(s.edges()).toContainEqual({ from: goalId, to: i.id, rel: "spawns" });
	});

	test("claimIntent moves open → running and is exclusive", async () => {
		const s = new MemGraphStore();
		await s.seed("g");
		const i = await s.addIntent("x");
		const claimed = await s.claimIntent();
		expect(claimed?.id).toBe(i.id);
		expect(s.nodes().find(n => n.id === i.id)?.state).toBe("running");
		expect(await s.claimIntent()).toBeNull(); // the only intent is already running
		expect(await s.overview()).toMatchObject({ frontierOpen: 0, running: 1 });
	});

	test("reportFact records a confirmed fact, a yields edge, and settles the intent", async () => {
		const s = new MemGraphStore();
		await s.seed("g");
		const i = await s.addIntent("x");
		await s.claimIntent();
		const f = await s.reportFact(i.id, "handler 0x222000 memcpy with attacker length");
		expect(f).toMatchObject({ kind: "fact", state: "confirmed", intentId: i.id });
		expect(s.edges()).toContainEqual({ from: i.id, to: f.id, rel: "yields" });
		expect(s.nodes().find(n => n.id === i.id)?.state).toBe("done"); // intent settled
	});

	test("reportFact on an unknown intent throws", async () => {
		const s = new MemGraphStore();
		await s.seed("g");
		expect(s.reportFact(999, "x")).rejects.toThrow(/no such intent/);
	});

	test("reportFinding records a finding node proved by its intent", async () => {
		const s = new MemGraphStore();
		await s.seed("g");
		const i = await s.addIntent("x");
		const f = await s.reportFinding(i.id, "EOP via 0x222000: attacker length → SYSTEM write");
		expect(f).toMatchObject({ kind: "finding", state: "confirmed" });
		expect(s.edges()).toContainEqual({ from: i.id, to: f.id, rel: "proves" });
		expect((await s.overview()).nodes.filter(n => n.kind === "finding")).toHaveLength(1);
	});
});

describe("task host tools — the planner/worker seam", () => {
	const call = async (tools: ReturnType<typeof makeTaskHostTools>, name: string, params: unknown): Promise<string> => {
		const t = tools.find(x => x.name === name);
		if (!t) throw new Error(`no tool ${name}`);
		const r = await t.execute("call", params as never, undefined, undefined as never);
		return (r.content[0] as { text: string }).text;
	};

	test("driving the tools reproduces a planner→worker round end to end", async () => {
		const store = new MemGraphStore();
		await store.seed("prove the EOP");
		const tools = makeTaskHostTools(store);

		// planner emits two intents
		await call(tools, "add_intent", { text: "enumerate device IOCTLs" });
		await call(tools, "add_intent", { text: "check the DACL on \\\\.\\Device\\X" });
		expect((await store.overview()).frontierOpen).toBe(2);

		// worker claims one and reports a fact
		const claimed = JSON.parse(await call(tools, "claim_intent", {})) as { intentId: number; text: string };
		expect(claimed.text).toBe("enumerate device IOCTLs");
		await call(tools, "report_fact", { intentId: claimed.intentId, text: "0x222000 reachable from low-priv" });

		// the graph reflects it: one open intent left, one confirmed fact + yields edge
		const o = await store.overview();
		expect(o.frontierOpen).toBe(1); // one still open
		expect(o.nodes.filter(n => n.kind === "fact" && n.state === "confirmed")).toHaveLength(1);
		expect(o.edges.some(e => e.rel === "yields")).toBe(true);

		// graph_overview tool returns the live graph as JSON
		const viewed = JSON.parse(await call(tools, "graph_overview", {})) as { goal: string };
		expect(viewed.goal).toBe("prove the EOP");
	});

	test("every host tool is read-tier, so the gate auto-runs it with no card", () => {
		// The no-card contract: if any bookkeeping tool became write/exec, an
		// autonomous run would raise a card per intent/fact and drown the operator.
		for (const t of makeTaskHostTools(new MemGraphStore())) {
			expect(t.approval).toBe("read");
		}
	});
});
