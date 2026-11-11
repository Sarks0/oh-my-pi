/**
 * Projection sync — reflect the host FS campaign state into the mirror tables.
 * ONE direction only: host FS → Postgres. The mirror is never written back; it is
 * healed by re-read (DESIGN §3.1, §3.6). campaign-mcp remains the sole promoter and
 * the gate authority; this just makes campaign state queryable/aggregatable for the
 * dashboard without hitting the FS on every request.
 */
import { getCampaign, listCampaigns } from "../campaign/reader";
import type { Db } from "./client";

export interface SyncResult {
	campaigns: number;
	findings: number;
}

export async function syncCampaigns(sql: Db, labRoot: string): Promise<SyncResult> {
	const camps = await listCampaigns(labRoot, "all");
	let findings = 0;

	for (const c of camps) {
		await sql`
			INSERT INTO campaigns_mirror ${sql({
				id: c.id,
				archived: c.archived,
				platform: c.platform,
				scope: c.scope ?? null,
				title: c.title ?? null,
				n_hallucinations: c.counts.hallucinations,
				n_findings: c.counts.findings,
				n_rejected: c.counts.rejected,
				n_surfaces: c.counts.surfaces,
				raw: c.raw,
			})}
			ON CONFLICT (id) DO UPDATE SET
				archived = EXCLUDED.archived, platform = EXCLUDED.platform, scope = EXCLUDED.scope,
				title = EXCLUDED.title, n_hallucinations = EXCLUDED.n_hallucinations,
				n_findings = EXCLUDED.n_findings, n_rejected = EXCLUDED.n_rejected,
				n_surfaces = EXCLUDED.n_surfaces, raw = EXCLUDED.raw, synced_at = now()`;

		const detail = await getCampaign(labRoot, c.id);
		// Replace this campaign's findings wholesale so host-side removals are reflected.
		await sql`DELETE FROM findings_mirror WHERE campaign_id = ${c.id}`;
		for (const f of detail?.findings ?? []) {
			await sql`INSERT INTO findings_mirror ${sql({
				campaign_id: c.id,
				id: f.id,
				state: f.state,
				surface_id: f.surface_id ?? null,
				security_invariant: f.security_invariant ?? null,
				gates: f.gates,
				raw: f.raw,
			})}`;
			findings++;
		}
	}

	// Drop mirror rows for campaigns that no longer exist on the host.
	const ids = camps.map(c => c.id);
	if (ids.length > 0) {
		await sql`DELETE FROM campaigns_mirror WHERE id <> ALL(${ids})`;
		await sql`DELETE FROM findings_mirror WHERE campaign_id <> ALL(${ids})`;
	} else {
		await sql`DELETE FROM campaigns_mirror WHERE true`;
		await sql`DELETE FROM findings_mirror WHERE true`;
	}

	await sql`
		INSERT INTO sync_state ${sql({ k: "campaigns", v: { campaigns: camps.length, findings } })}
		ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`;

	return { campaigns: camps.length, findings };
}
