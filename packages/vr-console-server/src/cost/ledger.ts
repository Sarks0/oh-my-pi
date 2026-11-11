/**
 * Cost / token ledger (DESIGN §9.1). omp computes usage + provider cost on each
 * message; the console taps it at `message_end` (one subscribe, no second model
 * call) and appends a row. We reuse omp's `usage.cost.total` rather than a local
 * rate card, so the ledger tracks whatever provider actually billed.
 */
import type { Db } from "../db/client";

export interface UsageRow {
	campaign_id: string | null;
	session_cwd: string | null;
	provider: string | null;
	model: string | null;
	api: string | null;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	total_tokens: number;
	cost_total: number;
	stop_reason: string | null;
}

/** Extract a ledger row from a RAW AgentSessionEvent, or null if it carries no usage. */
export function usageFromEvent(event: unknown, ctx: { campaignId?: string; cwd?: string } = {}): UsageRow | null {
	const e = event as { type?: string; message?: any };
	if (e?.type !== "message_end") return null;
	const m = e.message;
	if (!m || m.role !== "assistant" || !m.usage) return null;
	const u = m.usage;
	return {
		campaign_id: ctx.campaignId ?? null,
		session_cwd: ctx.cwd ?? null,
		provider: m.provider ?? null,
		model: m.model ?? null,
		api: m.api ?? null,
		input: Number(u.input ?? 0),
		output: Number(u.output ?? 0),
		cache_read: Number(u.cacheRead ?? 0),
		cache_write: Number(u.cacheWrite ?? 0),
		total_tokens: Number(u.totalTokens ?? 0),
		cost_total: Number(u.cost?.total ?? 0),
		stop_reason: m.stopReason ?? null,
	};
}

export async function recordUsage(sql: Db, row: UsageRow): Promise<void> {
	await sql`INSERT INTO llm_usage ${sql(row as unknown as Record<string, unknown>)}`;
}

export interface CostSummary {
	total_cost: number;
	total_tokens: number;
	calls: number;
	by_model: Array<{ model: string | null; cost: number; tokens: number; calls: number }>;
}

export async function costSummary(sql: Db): Promise<CostSummary> {
	const totals = (await sql`
		SELECT coalesce(sum(cost_total), 0)::float8 AS total_cost,
		       coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
		       count(*)::int AS calls
		FROM llm_usage`)[0];
	const byModel = await sql`
		SELECT model, sum(cost_total)::float8 AS cost, sum(total_tokens)::bigint AS tokens, count(*)::int AS calls
		FROM llm_usage GROUP BY model ORDER BY cost DESC NULLS LAST LIMIT 20`;
	return {
		total_cost: Number(totals.total_cost),
		total_tokens: Number(totals.total_tokens),
		calls: Number(totals.calls),
		by_model: byModel.map((r: any) => ({ model: r.model, cost: Number(r.cost), tokens: Number(r.tokens), calls: Number(r.calls) })),
	};
}

export async function recentUsage(sql: Db, limit = 50): Promise<unknown[]> {
	return sql`SELECT * FROM llm_usage ORDER BY ts DESC LIMIT ${limit}`;
}
