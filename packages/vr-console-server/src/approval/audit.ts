/**
 * Approval audit (DESIGN §7.6). A row is written when an approval card is RAISED
 * (status=pending) and updated when it RESOLVES, so a crash leaves a pending/timeout
 * forensic trail. Projection only — campaign-mcp stays the gate/promotion authority.
 */
import type { ExtensionApprovalAnswer } from "@oh-my-pi/pi-coding-agent";
import type { Db } from "../db/client";

export interface RaiseInfo {
	full?: string;
	compact?: string;
	sessionOffered: boolean;
	grants?: unknown;
	campaignId?: string;
	cwd?: string;
}

/** Hooks the ConsoleUIContext calls around an approval; a no-op when no DB is set. */
export interface ApprovalAuditor {
	onRaise(id: string, info: RaiseInfo): void;
	onResolve(id: string, answer: ExtensionApprovalAnswer): void;
}

/** Map a normalized answer to {status, answer-string} for the audit row. */
export function classifyAnswer(answer: ExtensionApprovalAnswer): { status: "allowed" | "denied"; answer: string } {
	if (answer === "deny") return { status: "denied", answer: "deny" };
	if (answer === "once" || answer === "session") return { status: "allowed", answer };
	return { status: "allowed", answer: `grant:${answer.grant}${answer.always ? ":always" : ""}` };
}

export async function recordRaise(db: Db, id: string, info: RaiseInfo): Promise<void> {
	await db`INSERT INTO approval_records ${db({
		id,
		campaign_id: info.campaignId ?? null,
		session_cwd: info.cwd ?? null,
		prompt_compact: info.compact ?? null,
		prompt_full: info.full ?? null,
		session_offered: info.sessionOffered,
		grants: info.grants ?? null,
		status: "pending",
		decision_source: "human",
	})} ON CONFLICT (id) DO NOTHING`;
}

export async function recordResolve(db: Db, id: string, answer: ExtensionApprovalAnswer): Promise<void> {
	const { status, answer: ans } = classifyAnswer(answer);
	await db`UPDATE approval_records SET status = ${status}, answer = ${ans}, decided_at = now() WHERE id = ${id} AND status = 'pending'`;
}

/** DB-backed auditor; fire-and-forget so an audit write never blocks the approval. */
export function makeDbAuditor(db: Db, ctx: { campaignId?: string; cwd?: string }): ApprovalAuditor {
	return {
		onRaise(id, info) {
			recordRaise(db, id, { ...info, campaignId: info.campaignId ?? ctx.campaignId, cwd: info.cwd ?? ctx.cwd }).catch(() => {});
		},
		onResolve(id, answer) {
			recordResolve(db, id, answer).catch(() => {});
		},
	};
}

export async function listApprovalRecords(db: Db, limit = 100): Promise<unknown[]> {
	return db`SELECT id, campaign_id, session_cwd, prompt_compact AS compact, status, answer, decision_source, raised_at, decided_at
		FROM approval_records ORDER BY raised_at DESC LIMIT ${limit}`;
}
