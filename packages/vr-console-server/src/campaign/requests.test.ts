import { describe, expect, test } from "bun:test";
import { composeGateRecordRequest, composePromoteRequest } from "./requests";

describe("composePromoteRequest", () => {
	test("names the finding, campaign, the host tool, and the fail-closed authority", () => {
		const s = composePromoteRequest("camp-010_spoolsv", "finding-002_oob");
		expect(s).toContain("finding-002_oob");
		expect(s).toContain("camp-010_spoolsv");
		expect(s).toContain("finding_promote"); // the agent must call THIS host tool
		expect(s).toContain("hallucinations/");
		// the authority clause that keeps the request honest (Constraint 1)
		expect(s.toLowerCase()).toContain("do not report");
	});
});

describe("composeGateRecordRequest", () => {
	test("names the gate, status, evidence dir, and gate_record", () => {
		const s = composeGateRecordRequest("camp-1", "finding-001", "gate2_security_impact", "passed");
		expect(s).toContain("gate2_security_impact");
		expect(s).toContain("passed");
		expect(s).toContain("gate_record");
		expect(s).toContain("evidence/gate2_security_impact/");
		// never force a required gate past missing evidence
		expect(s.toLowerCase()).toContain("refuses");
	});
});
