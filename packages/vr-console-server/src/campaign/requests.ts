/**
 * Operator action REQUESTS (DESIGN §4.3). The console's "Promote" / "Record gate"
 * buttons do NOT write campaign state — they compose a natural-language instruction
 * the server forwards as a session.prompt. The agent then calls the host campaign-mcp
 * finding_promote / gate_record tool, which is a mutation and therefore raises an
 * approval card (DESIGN §7.3) before it runs. Authority stays on the host FS:
 * gate_record refuses a required gate that passes with no evidence, and
 * finding_promote re-checks the evidence is on disk. The console can DISPLAY and
 * REQUEST; it can never fake a promotion (Constraint 1).
 *
 * Pure string builders — no side effects, unit-testable.
 */
export function composePromoteRequest(campaignId: string, findingId: string): string {
	return [
		`[Operator request] Promote finding "${findingId}" in campaign "${campaignId}" from hallucinations/ to findings/.`,
		`Before promoting: confirm every required gate is "passed" with on-disk evidence under its evidence/<gate>/ directory, using the campaign-mcp read tools.`,
		`Then call the campaign-mcp finding_promote tool for this finding.`,
		`Do NOT report the finding as validated unless finding_promote returns success — it is the only authority that can validate a finding, and it re-checks the evidence on disk.`,
	].join(" ");
}

export function composeGateRecordRequest(campaignId: string, findingId: string, gate: string, status: string): string {
	return [
		`[Operator request] Record gate "${gate}" for finding "${findingId}" in campaign "${campaignId}" with status "${status}".`,
		`Use the campaign-mcp gate_record tool, citing the evidence files under evidence/${gate}/.`,
		`gate_record refuses a required gate marked "passed" with no evidence attached — gather and attach the evidence first if it is missing, do not force the status.`,
	].join(" ");
}
