/**
 * Approval policy — the pinned, in-repo ruleset (not fetched; build-local supply-chain
 * discipline) compiled down to omp's exact-name `tools.approval` map.
 *
 * Grounded in DESIGN §7.3:
 * - omp has NO prefix/glob matching in `tools.approval` — keys are exact minted names
 *   (`resolveApproval` policyKey = tool.name, approval.ts:401), so the ruleset is
 *   matched against the LIVE roster and emitted as exact-name verdicts.
 * - MCP tool names mint as `mcp__<server>_<tool>` with every non-[a-z0-9_] char
 *   (hyphens included) collapsed to `_` (tool-bridge.ts:471-540). So `lab-mcp` →
 *   `mcp__lab_mcp_<tool>`.
 * - omp tiers EVERY MCP tool as `write` (tool-bridge.ts:735) and every tool call is
 *   wrapped by ExtensionToolWrapper → requestApproval → ui.approve (wrapper.ts:478),
 *   our fail-closed card. So the ONLY way a side-effecting tool runs without a human
 *   card is an `allow` verdict here.
 *
 * Two safety rules this file enforces (review P1-1 + P0-4):
 * 1. Auto-run (`allow`) comes ONLY from an EXPLICIT exact-name allowlist, never from a
 *    verb regex. A tool that mutates but happens to end in a read verb (e.g. a crafted
 *    `..._get`) is therefore never silently auto-allowed; unlisted tools fall through to
 *    a human card (`prompt`), or to `deny` under the safe default below.
 * 2. Until research-content redaction exists (Constraint 2), mutating and unclassified
 *    tools are HARD-DENIED in code (read-only-only), not merely carded — the previews on
 *    a card carry tool args (decompiles, blobs). The operator opts into mutations with
 *    VR_CONSOLE_ALLOW_MUTATIONS=1 once they accept that, which flips those to `prompt`.
 */
export type ApprovalVerdict = "allow" | "deny" | "prompt";

/** Semantic class of a tool, independent of the final verdict. */
export type ToolClass = "readOnly" | "mutation" | "unknown";

/** Mutation / side-effect signatures: a match means the tool can change host state. */
const MUTATION_PATTERNS: readonly RegExp[] = [
	/^mcp__lab_mcp_/, // lab-mcp = WinRM into a live VM
	/^mcp__(fuzz|crash|binary)_mcp_/, // host-bound compute (fuzz / crash / Ghidra)
	/^mcp__proxmoxmcp_/, // Proxmox VM lifecycle
	/_(promote|revert|snapshot|create|write|run|exec|delete|save|mark|reject|set|update|put|post|add|remove)(_|$)/, // mutation verbs anywhere
];

/** Read-only query signatures on the record/knowledge servers. Marks a tool as safe to
 *  CARD (it does not mutate); it does NOT by itself auto-run — only the allowlist does. */
const READ_ONLY_PATTERN = /^mcp__(campaign|notes|target|msrc|kb)_mcp_.*(get|list|history|ask|search|recommend|read|status)$/;

/** Classify a minted tool name. Mutation signatures are checked first, so a tool that
 *  both mutates and ends in a read verb is treated as a mutation, not read-only. */
export function classifyTool(name: string): ToolClass {
	if (MUTATION_PATTERNS.some(p => p.test(name))) return "mutation";
	if (READ_ONLY_PATTERN.test(name)) return "readOnly";
	return "unknown";
}

export interface ApprovalConfig {
	/** Opt-in to running mutating/unknown tools (behind the human card). Default false:
	 *  read-only-only, with mutations and unknowns hard-denied in code. */
	allowMutations: boolean;
	/** Exact minted names that may auto-run with NO card. The ONLY source of `allow`. */
	autoAllow: ReadonlySet<string>;
}

/** The safe posture used when nothing is configured: nothing auto-runs, mutations denied. */
export const SAFE_DEFAULT_CONFIG: ApprovalConfig = { allowMutations: false, autoAllow: new Set() };

/** The verdict for one tool under a config. */
export function verdictFor(name: string, config: ApprovalConfig): ApprovalVerdict {
	if (config.autoAllow.has(name)) return "allow"; // explicitly allowlisted → auto-run
	const cls = classifyTool(name);
	if (cls === "readOnly") return "prompt"; // reads always card (never silent auto-run)
	// mutation or unknown: card only when the operator opted in; else hard-deny in code
	return config.allowMutations ? "prompt" : "deny";
}

/**
 * Compile the policy against the live minted roster → an exact-name → verdict map for
 * omp's `tools.approval`. EVERY name gets an explicit verdict (including `deny`), so the
 * safe default is enforced in config rather than relying on omp's fall-through. Pure.
 */
export function compileApprovalPolicy(liveToolNames: readonly string[], config: ApprovalConfig = SAFE_DEFAULT_CONFIG): Record<string, ApprovalVerdict> {
	const out: Record<string, ApprovalVerdict> = {};
	for (const name of liveToolNames) out[name] = verdictFor(name, config);
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

/**
 * Audit a live roster for the human review that P1-1 asks for. `unclassified` are names
 * that match no signature at all (a new tool nobody has triaged — denied by default until
 * someone decides); `readOnlyNotAllowlisted` are reads that currently only CARD and could
 * be promoted to auto-run by adding them to the allowlist. A CI check on the host can fail
 * when either set is non-empty for the current roster, forcing classification.
 */
export function auditRoster(
	liveToolNames: readonly string[],
	config: ApprovalConfig = SAFE_DEFAULT_CONFIG,
): { allowlisted: string[]; readOnlyNotAllowlisted: string[]; mutation: string[]; unclassified: string[] } {
	const allowlisted: string[] = [];
	const readOnlyNotAllowlisted: string[] = [];
	const mutation: string[] = [];
	const unclassified: string[] = [];
	for (const name of liveToolNames) {
		if (config.autoAllow.has(name)) {
			allowlisted.push(name);
			continue;
		}
		const cls = classifyTool(name);
		if (cls === "readOnly") readOnlyNotAllowlisted.push(name);
		else if (cls === "mutation") mutation.push(name);
		else unclassified.push(name);
	}
	return { allowlisted, readOnlyNotAllowlisted, mutation, unclassified };
}

/**
 * Load the approval config from the environment (impure; call once at boot, pass the
 * result to the pure compiler/auditor). VR_CONSOLE_ALLOW_MUTATIONS=1 opts into mutations;
 * VR_CONSOLE_ALLOWLIST points at a JSON array of exact minted names generated from the
 * host's live roster. A missing/invalid file yields an empty allowlist (the safe default).
 */
export async function loadApprovalConfig(env: Record<string, string | undefined> = process.env): Promise<ApprovalConfig> {
	const allowMutations = /^(1|true|yes|on)$/i.test((env.VR_CONSOLE_ALLOW_MUTATIONS ?? "").trim());
	let autoAllow: ReadonlySet<string> = new Set();
	const file = (env.VR_CONSOLE_ALLOWLIST ?? "").trim();
	if (file) {
		try {
			const parsed: unknown = await Bun.file(file).json();
			if (Array.isArray(parsed)) autoAllow = new Set(parsed.filter((x): x is string => typeof x === "string"));
		} catch {
			/* missing or invalid → empty allowlist, the safe default */
		}
	}
	return { allowMutations, autoAllow };
}
