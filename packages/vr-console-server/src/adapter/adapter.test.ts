import { describe, expect, test } from "bun:test";
import { OmpSessionAdapter } from "./omp-session-adapter";

/** The operational-panel getters must return safe, well-shaped data BEFORE a
 *  session exists — the /api/session and /api/mcp routes force a start, but the
 *  getters themselves must never throw on a cold adapter (fail-safe contract). */
describe("OmpSessionAdapter introspection — cold (not started)", () => {
	const make = () => new OmpSessionAdapter(() => {});

	test("started is false before start()", () => {
		expect(make().started).toBe(false);
	});

	test("sessionInfo reports the pinned always-ask posture and null model, zero MCP", () => {
		const info = make().sessionInfo();
		expect(info.started).toBe(false);
		expect(info.approvalMode).toBe("always-ask"); // the fail-closed default, surfaced to the UI
		expect(info.model).toBeNull(); // no turn has run → no model captured
		expect(info.provider).toBeNull();
		expect(info.cwd).toBeUndefined();
		expect(info.mcp).toEqual({ servers: 0, tools: 0 });
	});

	test("mcpInfo returns empty servers/tools without a manager", () => {
		const info = make().mcpInfo();
		expect(info.started).toBe(false);
		expect(info.connectedServers).toEqual([]);
		expect(info.tools).toEqual([]);
	});

	test("listModels is empty with no current model before a session exists", () => {
		const info = make().listModels();
		expect(info.started).toBe(false);
		expect(info.current).toBeNull();
		expect(info.models).toEqual([]);
	});

	test("setModelByRef fails closed when the session is not started", async () => {
		const res = await make().setModelByRef("anthropic", "claude-opus-4-8");
		expect(res.switched).toBe(false);
		expect(res.current).toBeNull();
		expect(res.error).toMatch(/not started/);
	});
});
