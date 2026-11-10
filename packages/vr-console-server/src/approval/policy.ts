/**
 * Approval policy — the pinned, in-repo ARTEX-style ruleset (not fetched; build-local
 * supply-chain discipline) compiled down to omp's exact-name `tools.approval` map.
 *
 * Grounded in DESIGN §7.3:
 * - omp has NO prefix/glob matching in `tools.approval` — keys are exact minted names
 *   (`resolveApproval` policyKey = tool.name, approval.ts:401), so the ruleset is
 *   matched against the LIVE roster and emitted as exact-name verdicts.
 * - MCP tool names mint as `mcp__<server>_<tool>` with every non-[a-z0-9_] char
 *   (hyphens included) collapsed to `_` (tool-bridge.ts:471-540). So `lab-mcp` →
 *   `mcp__lab_mcp_<tool>`, NOT ARTEX's `mcp__lab-mcp__<tool>`.
 * - omp tiers EVERY MCP tool as `write` (tool-bridge.ts:735), so under approvalMode
 *   `always-ask` any tool the ruleset forgets still raises a card (fail-safe). The
 *   ruleset only NARROWS (auto-allow read-only queries); it never widens.
 *
 * NOTE (curation): with no readOnlyHint to lean on, the verb patterns are a
 * convenience, not a classification — `notes-mcp.coverage_mark` mutates, and
 * `campaign-mcp` mutators hold an advisory flock (vr-lab AGENTS.md:169). This list
 * must be reviewed per tool, not trusted as generated.
 */
export type ApprovalVerdict = "allow" | "deny" | "prompt";

export interface ApprovalRule {
	action: ApprovalVerdict;
	pattern: RegExp;
	note: string;
}

/** Ordered: first match wins. */
export const PINNED_RULESET: readonly ApprovalRule[] = [
	// read-only queries on record/knowledge servers → auto-run (no card)
	{ action: "allow", pattern: /^mcp__(campaign|notes|target|msrc|kb)_mcp_.*(get|list|history|ask|search|recommend|read|status)$/, note: "read-only record/knowledge query" },
	// every lab-mcp call is WinRM into a live VM → always card
	{ action: "prompt", pattern: /^mcp__lab_mcp_/, note: "lab-mcp WinRM (live VM side effect)" },
	// host-bound compute → always card
	{ action: "prompt", pattern: /^mcp__(fuzz|crash|binary)_mcp_/, note: "host-bound compute (fuzz/crash/Ghidra)" },
	// Proxmox lifecycle → always card
	{ action: "prompt", pattern: /^mcp__proxmoxmcp_/, note: "Proxmox VM lifecycle" },
	// any mutation verb anywhere → always card (promote, revert, snapshot, create, write, run, exec, delete, save)
	{ action: "prompt", pattern: /_(promote|revert|snapshot|create|write|run|exec|delete|save|mark|reject)(_|$)/, note: "mutation" },
];

/**
 * Compile the pinned ruleset against the live minted tool roster. Returns an
 * exact-name → verdict map suitable for omp's `tools.approval`. Names that match no
 * rule are omitted (they fall through to approvalMode, which cards them when tier
 * `write`). Pure + deterministic — unit-testable without a session.
 */
export function compileApprovalPolicy(liveToolNames: readonly string[]): Record<string, ApprovalVerdict> {
	const out: Record<string, ApprovalVerdict> = {};
	for (const name of liveToolNames) {
		for (const rule of PINNED_RULESET) {
			if (rule.pattern.test(name)) {
				out[name] = rule.action;
				break;
			}
		}
	}
	return out;
}

export function summarizePolicy(policy: Record<string, ApprovalVerdict>): { allow: number; prompt: number; deny: number; total: number } {
	const vals = Object.values(policy);
	return {
		allow: vals.filter(v => v === "allow").length,
		prompt: vals.filter(v => v === "prompt").length,
		deny: vals.filter(v => v === "deny").length,
		total: vals.length,
	};
}
