import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, makeDb, migrate } from "./client";
import { syncCampaigns } from "./projection";
import { costSummary, recordUsage, usageFromEvent } from "../cost/ledger";
import { listApprovalRecords, recordRaise, recordResolve } from "../approval/audit";

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip; // skip cleanly when no test DB is configured

suite("Postgres projection + cost ledger", () => {
	let sql: Db;
	let LAB: string;

	beforeAll(async () => {
		sql = makeDb(URL as string);
		await migrate(sql);
		await sql.unsafe("TRUNCATE campaigns_mirror, findings_mirror, llm_usage, sync_state, approval_records");

		LAB = await mkdtemp(join(tmpdir(), "vrlab-db-"));
		const camp = join(LAB, "campaigns", "active", "camp-db_1");
		await mkdir(join(camp, "hallucinations", "finding-001_x", "evidence", "gate0_poc_compiles"), { recursive: true });
		await mkdir(join(camp, "findings", "finding-002_y", "evidence", "gate4_report_package"), { recursive: true });
		await writeFile(join(camp, "campaign.yaml"), "platform: windows\nscope: db test\ntarget: t.sys\n");
		await writeFile(join(camp, "hallucinations", "finding-001_x", "finding.yaml"), "surface_id: s1\nstate: hallucination\n");
		await writeFile(join(camp, "findings", "finding-002_y", "finding.yaml"), "surface_id: s1\nstate: validated\ngates:\n  gate4_report_package:\n    status: passed\n    required: true\n    evidence: []\n");
	});

	afterAll(async () => {
		await sql.unsafe("TRUNCATE campaigns_mirror, findings_mirror, llm_usage, sync_state, approval_records");
		await sql.end();
		await rm(LAB, { recursive: true, force: true });
	});

	test("syncCampaigns mirrors campaigns + findings (one-way, host→db)", async () => {
		const res = await syncCampaigns(sql, LAB);
		expect(res).toEqual({ campaigns: 1, findings: 2 });

		const camps = await sql`SELECT id, platform, n_hallucinations, n_findings FROM campaigns_mirror`;
		expect(camps.length).toBe(1);
		expect(camps[0].id).toBe("camp-db_1");
		expect(camps[0].platform).toBe("windows");
		expect(Number(camps[0].n_hallucinations)).toBe(1);

		const fs = await sql`SELECT id, state, gates FROM findings_mirror ORDER BY id`;
		expect(fs.map((r: any) => r.state)).toEqual(["hallucination", "validated"]);
		// jsonb round-trips the GateInfo[] from finding.yaml's gates dict
		expect(fs[1].gates).toEqual([{ name: "gate4_report_package", status: "passed", required: true, evidence_count: 0 }]);
	});

	test("re-sync is idempotent and reflects host removals", async () => {
		await rm(join(LAB, "campaigns", "active", "camp-db_1", "rejected"), { recursive: true, force: true });
		const a = await syncCampaigns(sql, LAB);
		const b = await syncCampaigns(sql, LAB);
		expect(a).toEqual(b);
		const n = await sql`SELECT count(*)::int AS n FROM findings_mirror`;
		expect(n[0].n).toBe(2);
	});

	test("usageFromEvent extracts a ledger row from a message_end", () => {
		const ev = {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "amazon-bedrock",
				model: "us.anthropic.claude-opus-5-5",
				api: "bedrock-converse-stream",
				stopReason: "end_turn",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, totalTokens: 160, cost: { total: 0.0042 } },
			},
		};
		const row = usageFromEvent(ev, { cwd: "/x/campaigns/active/camp-db_1", campaignId: "camp-db_1" });
		expect(row).not.toBeNull();
		expect(row!.total_tokens).toBe(160);
		expect(row!.cost_total).toBeCloseTo(0.0042);
		expect(row!.campaign_id).toBe("camp-db_1");
		// non-assistant / no-usage events are ignored
		expect(usageFromEvent({ type: "turn_start" })).toBeNull();
		expect(usageFromEvent({ type: "message_end", message: { role: "user" } })).toBeNull();
	});

	test("recordUsage + costSummary aggregate the ledger", async () => {
		await recordUsage(sql, usageFromEvent({ type: "message_end", message: { role: "assistant", model: "m1", usage: { totalTokens: 100, cost: { total: 0.01 } } } })!);
		await recordUsage(sql, usageFromEvent({ type: "message_end", message: { role: "assistant", model: "m1", usage: { totalTokens: 200, cost: { total: 0.02 } } } })!);
		const s = await costSummary(sql);
		expect(s.calls).toBe(2);
		expect(s.total_tokens).toBe(300);
		expect(s.total_cost).toBeCloseTo(0.03);
		expect(s.by_model[0].model).toBe("m1");
	});

	test("approval audit: raise writes pending, resolve transitions status", async () => {
		await recordRaise(sql, "approval_1", { full: "run lab-mcp WinRM on canary", compact: "lab winrm", sessionOffered: false, campaignId: "camp-db_1", cwd: "/x" });
		await recordRaise(sql, "approval_2", { compact: "revert snapshot", sessionOffered: true, campaignId: "camp-db_1" });
		let rows = (await listApprovalRecords(sql)) as any[];
		expect(rows.length).toBe(2);
		expect(rows.find(r => r.id === "approval_1").status).toBe("pending");

		await recordResolve(sql, "approval_1", "once");
		await recordResolve(sql, "approval_2", "deny");
		rows = (await listApprovalRecords(sql)) as any[];
		const byId = Object.fromEntries(rows.map(r => [r.id, r]));
		expect(byId.approval_1.status).toBe("allowed");
		expect(byId.approval_1.answer).toBe("once");
		expect(byId.approval_1.decided_at).not.toBeNull();
		expect(byId.approval_2.status).toBe("denied");
		expect(byId.approval_2.answer).toBe("deny");
	});
});
