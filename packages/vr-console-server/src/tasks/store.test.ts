import { describe, expect, test } from "bun:test";
import { GraphStore } from "./store";
import { makeTaskHostTools } from "./host-tools";

describe("GraphStore — the exploration graph contract", () => {
	test("seed creates an origin fact and a goal, linked", () => {
		const s = new GraphStore();
		const { originId, goalId } = s.seed("find an EOP");
		const o = s.overview();
		expect(o.goal).toBe("find an EOP");
		expect(s.nodes().find(n => n.id === originId)).toMatchObject({ kind: "fact", state: "origin" });
		expect(s.nodes().find(n => n.id === goalId)).toMatchObject({ kind: "goal", state: "active" });
		expect(s.edges()).toContainEqual({ from: originId, to: goalId, rel: "spawns" });
	});

	test("addIntent puts an open intent on the frontier, linked from the goal", () => {
		const s = new GraphStore();
		const { goalId } = s.seed("g");
		const i = s.addIntent("enumerate the IOCTL handlers");
		expect(i).toMatchObject({ kind: "intent", state: "open" });
		expect(s.overview().frontierOpen).toBe(1);
		expect(s.edges()).toContainEqual({ from: goalId, to: i.id, rel: "spawns" });
	});

	test("claimIntent moves open → running and is exclusive", () => {
		const s = new GraphStore();
		s.seed("g");
		const i = s.addIntent("x");
		const claimed = s.claimIntent();
		expect(claimed?.id).toBe(i.id);
		expect(s.nodes().find(n => n.id === i.id)?.state).toBe("running");
		expect(s.claimIntent()).toBeNull(); // the only intent is already running
		expect(s.overview()).toMatchObject({ frontierOpen: 0, running: 1 });
	});

	test("reportFact records a confirmed fact, a yields edge, and settles the intent", () => {
		const s = new GraphStore();
		s.seed("g");
		const i = s.addIntent("x");
		s.claimIntent();
		const f = s.reportFact(i.id, "handler 0x222000 memcpy with attacker length");
		expect(f).toMatchObject({ kind: "fact", state: "confirmed", intentId: i.id });
		expect(s.edges()).toContainEqual({ from: i.id, to: f.id, rel: "yields" });
		expect(s.nodes().find(n => n.id === i.id)?.state).toBe("done"); // intent settled
	});

	test("reportFact on an unknown intent throws", () => {
		const s = new GraphStore();
		s.seed("g");
		expect(() => s.reportFact(999, "x")).toThrow(/no such intent/);
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
		const store = new GraphStore();
		store.seed("prove the EOP");
		const tools = makeTaskHostTools(store);

		// planner emits two intents
		await call(tools, "add_intent", { text: "enumerate device IOCTLs" });
		await call(tools, "add_intent", { text: "check the DACL on \\\\.\\Device\\X" });
		expect(store.overview().frontierOpen).toBe(2);

		// worker claims one and reports a fact
		const claimed = JSON.parse(await call(tools, "claim_intent", {})) as { intentId: number; text: string };
		expect(claimed.text).toBe("enumerate device IOCTLs");
		await call(tools, "report_fact", { intentId: claimed.intentId, text: "0x222000 reachable from low-priv" });

		// the graph reflects it: one open intent left, one confirmed fact + yields edge
		const o = store.overview();
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
		for (const t of makeTaskHostTools(new GraphStore())) {
			expect(t.approval).toBe("read");
		}
	});
});
