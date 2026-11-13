import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoverageGraph, getCampaign, getFinding, listCampaigns, resolveEvidenceFile } from "./reader";

let LAB: string;
const CAMP = "camp-001_clfs";

beforeAll(async () => {
	LAB = await mkdtemp(join(tmpdir(), "vrlab-"));
	const camp = join(LAB, "campaigns", "active", CAMP);
	await mkdir(join(camp, "surface", "records", "surface-001_ioctl"), { recursive: true });
	await writeFile(join(camp, "campaign.yaml"), "platform: windows\nscope: CLFS driver\ntarget: clfs.sys\n");
	await writeFile(join(camp, "surface", "records", "surface-001_ioctl", "surface.yaml"), "kind: ioctl\nmodule: clfs.sys\n");
	// coverage ledger for the clfs.sys binary (notes-mcp shape)
	await mkdir(join(camp, "coverage"), { recursive: true });
	await writeFile(join(camp, "coverage", "abc123.yaml"), "binary_id: abc123\nmodule_name: clfs.sys\ntotal: 100\nin_scope_total: 80\nreviewed: 40\nstatus: ready\n");

	// hallucination: gate0 passed (with evidence file), gate2 not_started; invariant as {statement}
	const f1 = join(camp, "hallucinations", "finding-001_oob");
	await mkdir(join(f1, "evidence", "gate0_poc_compiles"), { recursive: true });
	await writeFile(join(f1, "finding.yaml"),
		"surface_id: surface-001_ioctl\n" +
		"security_invariant:\n  statement: bounded copy\n" +
		"source: ClfsEncodeBlock\nsink: memcpy\nstate: hallucination\n" +
		"gates:\n" +
		"  gate0_poc_compiles:\n    status: passed\n    required: true\n    evidence:\n      - evidence/gate0_poc_compiles/poc.c\n" +
		"  gate2_security_impact:\n    status: not_started\n    required: true\n    evidence: []\n");
	await writeFile(join(f1, "evidence", "gate0_poc_compiles", "poc.c"), "int main(){return 0;}\n");

	// validated: gate4 passed (with evidence)
	const f2 = join(camp, "findings", "finding-002_uaf");
	await mkdir(join(f2, "evidence", "gate4_report_package"), { recursive: true });
	await writeFile(join(f2, "finding.yaml"), "surface_id: surface-001_ioctl\nstate: validated\ngates:\n  gate4_report_package:\n    status: passed\n    required: true\n    evidence:\n      - evidence/gate4_report_package/report.md\n");
	await writeFile(join(f2, "evidence", "gate4_report_package", "report.md"), "# report\n");

	// rejected: no gates key
	await mkdir(join(camp, "rejected", "finding-003_nullderef"), { recursive: true });
	await writeFile(join(camp, "rejected", "finding-003_nullderef", "finding.yaml"), "surface_id: surface-001_ioctl\n");

	const camp2 = join(LAB, "campaigns", "archived", "camp-000_old");
	await mkdir(camp2, { recursive: true });
	await writeFile(join(camp2, "campaign.yaml"), "platform: windows\n");
});

afterAll(async () => { await rm(LAB, { recursive: true, force: true }); });

describe("listCampaigns", () => {
	test("counts findings and surfaces", async () => {
		const c = (await listCampaigns(LAB, "active"))[0];
		expect(c.id).toBe(CAMP);
		expect(c.counts).toEqual({ hallucinations: 1, findings: 1, rejected: 1, surfaces: 1 });
	});
	test("all scope includes archived", async () => {
		expect((await listCampaigns(LAB, "all")).map(c => c.id)).toEqual(["camp-000_old", CAMP]);
	});
});

describe("getCampaign — real gate status + invariant", () => {
	test("findings carry directory-derived state and parsed gates", async () => {
		const c = await getCampaign(LAB, CAMP);
		const byId = Object.fromEntries(c!.findings.map(f => [f.id, f]));
		const f1 = byId["finding-001_oob"];
		expect(f1.state).toBe("hallucination");
		expect(f1.security_invariant).toBe("bounded copy"); // {statement} unwrapped
		expect(f1.gates.map(g => [g.name, g.status])).toEqual([
			["gate0_poc_compiles", "passed"],
			["gate2_security_impact", "not_started"],
		]);
		expect(f1.gates[0].evidence_count).toBe(1);
		expect(byId["finding-002_uaf"].state).toBe("validated");
		expect(byId["finding-003_nullderef"].gates).toEqual([]); // no gates key
	});
});

describe("getFinding + evidence", () => {
	test("detail lists evidence files and source/sink", async () => {
		const f = await getFinding(LAB, CAMP, "finding-001_oob");
		expect(f).not.toBeNull();
		expect(f!.campaign_id).toBe(CAMP);
		expect(f!.source).toBe("ClfsEncodeBlock");
		expect(f!.evidence_files.map(e => e.rel)).toEqual(["evidence/gate0_poc_compiles/poc.c"]);
		expect(f!.evidence_files[0].size).toBeGreaterThan(0);
	});
	test("unknown finding returns null", async () => {
		expect(await getFinding(LAB, CAMP, "finding-999_nope")).toBeNull();
	});
});

describe("buildCoverageGraph", () => {
	test("assembles binary ← surface ← finding with coverage + edges", async () => {
		const g = await buildCoverageGraph(LAB, CAMP);
		const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));

		// binary node carries coverage
		expect(byId["bin:abc123"].kind).toBe("binary");
		expect(byId["bin:abc123"].label).toBe("clfs.sys");
		expect(byId["bin:abc123"].coverage).toEqual({ reviewed: 40, total: 100, in_scope: 80 });

		// surface node + surface→binary edge (module match)
		expect(byId["surf:surface-001_ioctl"].kind).toBe("surface");
		expect(g.edges).toContainEqual({ from: "surf:surface-001_ioctl", to: "bin:abc123", kind: "contains" });

		// finding nodes carry state + cite their surface
		expect(byId["find:finding-001_oob"].status).toBe("hallucination");
		expect(g.edges).toContainEqual({ from: "find:finding-001_oob", to: "surf:surface-001_ioctl", kind: "cites" });
	});
	test("unknown campaign → empty graph (no throw)", async () => {
		expect(await buildCoverageGraph(LAB, "nope")).toEqual({ nodes: [], edges: [] });
	});
});

describe("resolveEvidenceFile — path-guarded", () => {
	test("resolves a real evidence file", async () => {
		const p = await resolveEvidenceFile(LAB, CAMP, "finding-001_oob", "evidence/gate0_poc_compiles/poc.c");
		expect(p).not.toBeNull();
		expect(p!.endsWith("poc.c")).toBe(true);
	});
	test("rejects path traversal", async () => {
		expect(await resolveEvidenceFile(LAB, CAMP, "finding-001_oob", "../../../../etc/passwd")).toBeNull();
		expect(await resolveEvidenceFile(LAB, CAMP, "finding-001_oob", "evidence/../finding.yaml")).toBeNull();
	});
	test("rejects a missing file", async () => {
		expect(await resolveEvidenceFile(LAB, CAMP, "finding-001_oob", "evidence/gate0_poc_compiles/nope.txt")).toBeNull();
	});
});
