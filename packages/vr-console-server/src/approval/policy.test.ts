import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { auditRoster, classifyTool, compileApprovalPolicy, loadApprovalConfig, SAFE_DEFAULT_CONFIG, verdictFor, type ApprovalConfig } from "./policy";

const ENABLED: ApprovalConfig = { allowMutations: true, autoAllow: new Set() };

describe("classifyTool", () => {
	test("read-only query verbs on record/knowledge servers classify readOnly", () => {
		expect(classifyTool("mcp__campaign_mcp_surface_list")).toBe("readOnly");
		expect(classifyTool("mcp__notes_mcp_target_history")).toBe("readOnly");
	});
	test("side-effect servers and mutation verbs classify mutation", () => {
		expect(classifyTool("mcp__lab_mcp_run_command")).toBe("mutation");
		expect(classifyTool("mcp__proxmoxmcp_revert_snapshot")).toBe("mutation");
		expect(classifyTool("mcp__fuzz_mcp_launch")).toBe("mutation");
		expect(classifyTool("mcp__campaign_mcp_finding_promote")).toBe("mutation");
	});
	test("a mutation that ends in a read verb is still a mutation (checked first)", () => {
		// the exact P1-1 bug: the old allow-regex matched a trailing read verb and
		// auto-allowed this despite the `delete` in the middle.
		expect(classifyTool("mcp__campaign_mcp_delete_status")).toBe("mutation");
		expect(classifyTool("mcp__lab_mcp_something_get")).toBe("mutation"); // lab prefix wins
	});
	test("an unrecognized name is unknown", () => {
		expect(classifyTool("mcp__newserver_mcp_frobnicate")).toBe("unknown");
		expect(classifyTool("read")).toBe("unknown");
	});
});

describe("verdictFor / compileApprovalPolicy", () => {
	test("auto-run comes ONLY from the explicit allowlist", () => {
		const cfg: ApprovalConfig = { allowMutations: false, autoAllow: new Set(["mcp__campaign_mcp_surface_list"]) };
		expect(verdictFor("mcp__campaign_mcp_surface_list", cfg)).toBe("allow");
		// a read-only query NOT on the allowlist cards; it is never silently auto-run
		expect(verdictFor("mcp__notes_mcp_target_history", cfg)).toBe("prompt");
	});

	test("a mutating tool ending in a read verb is never auto-allowed (P1-1 regression)", () => {
		// safe default: denied; even with mutations enabled it only CARDS, never allow
		expect(verdictFor("mcp__campaign_mcp_delete_status", SAFE_DEFAULT_CONFIG)).toBe("deny");
		expect(verdictFor("mcp__campaign_mcp_delete_status", ENABLED)).toBe("prompt");
	});

	test("safe default hard-denies mutations and unknowns; opting in cards them", () => {
		for (const name of ["mcp__lab_mcp_run_command", "mcp__newserver_mcp_frobnicate"]) {
			expect(verdictFor(name, SAFE_DEFAULT_CONFIG)).toBe("deny");
			expect(verdictFor(name, ENABLED)).toBe("prompt");
		}
	});

	test("the compiled map gives every name an explicit verdict (deny is not omitted)", () => {
		const names = ["mcp__campaign_mcp_surface_list", "mcp__lab_mcp_run_command", "mcp__x_mcp_zzz"];
		const p = compileApprovalPolicy(names); // SAFE default
		expect(p["mcp__campaign_mcp_surface_list"]).toBe("prompt"); // read, not allowlisted
		expect(p["mcp__lab_mcp_run_command"]).toBe("deny"); // mutation, mutations off
		expect(p["mcp__x_mcp_zzz"]).toBe("deny"); // unknown, denied until classified
		expect(Object.keys(p)).toHaveLength(3); // no name is silently omitted
	});
});

describe("auditRoster — the human-classification signal", () => {
	test("splits the roster so new/unlisted tools surface for review", () => {
		const cfg: ApprovalConfig = { allowMutations: false, autoAllow: new Set(["mcp__campaign_mcp_surface_list"]) };
		const a = auditRoster(
			["mcp__campaign_mcp_surface_list", "mcp__notes_mcp_target_history", "mcp__lab_mcp_run_command", "mcp__new_mcp_frob"],
			cfg,
		);
		expect(a.allowlisted).toEqual(["mcp__campaign_mcp_surface_list"]);
		expect(a.readOnlyNotAllowlisted).toEqual(["mcp__notes_mcp_target_history"]); // candidate to allowlist
		expect(a.mutation).toEqual(["mcp__lab_mcp_run_command"]);
		expect(a.unclassified).toEqual(["mcp__new_mcp_frob"]); // must be triaged
	});
});

describe("loadApprovalConfig", () => {
	const allowlistPath = join(tmpdir(), `vrc-allowlist-${process.pid}.json`);
	afterAll(() => rm(allowlistPath, { force: true }));

	test("defaults to the safe posture with no env", async () => {
		const cfg = await loadApprovalConfig({});
		expect(cfg.allowMutations).toBe(false);
		expect(cfg.autoAllow.size).toBe(0);
	});

	test("VR_CONSOLE_ALLOW_MUTATIONS opts in; the allowlist file seeds auto-allow", async () => {
		await Bun.write(allowlistPath, JSON.stringify(["mcp__campaign_mcp_surface_list", "mcp__notes_mcp_coverage_get"]));
		const cfg = await loadApprovalConfig({ VR_CONSOLE_ALLOW_MUTATIONS: "1", VR_CONSOLE_ALLOWLIST: allowlistPath });
		expect(cfg.allowMutations).toBe(true);
		expect(cfg.autoAllow.has("mcp__campaign_mcp_surface_list")).toBe(true);
		expect(cfg.autoAllow.size).toBe(2);
	});

	test("a missing allowlist file yields an empty allowlist (safe), not a throw", async () => {
		const cfg = await loadApprovalConfig({ VR_CONSOLE_ALLOWLIST: join(tmpdir(), "does-not-exist-xyz.json") });
		expect(cfg.autoAllow.size).toBe(0);
	});
});
