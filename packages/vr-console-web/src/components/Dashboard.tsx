import { useEffect, useState } from "react";
import { api } from "../api";
import type { CampaignSummary } from "../types";

interface Cost { enabled?: boolean; total_cost: number; total_tokens: number; calls: number }

function CostTiles({ cost }: { cost: Cost | null }) {
	if (!cost || cost.enabled === false) return null;
	const tiles = [
		{ label: "LLM cost", value: `$${(cost.total_cost ?? 0).toFixed(4)}` },
		{ label: "Tokens", value: (cost.total_tokens ?? 0).toLocaleString() },
		{ label: "Model calls", value: String(cost.calls ?? 0) },
	];
	return (
		<div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(160px, 220px))", marginBottom: 18 }}>
			{tiles.map(t => (
				<div key={t.label} className="card">
					<div className="meta">{t.label}</div>
					<div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{t.value}</div>
				</div>
			))}
		</div>
	);
}

export function Dashboard() {
	const [camps, setCamps] = useState<CampaignSummary[] | null>(null);
	const [cost, setCost] = useState<Cost | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		api.campaigns("all").then(setCamps).catch(e => setErr(String(e.message ?? e)));
		fetch("/api/cost").then(r => r.json()).then(setCost).catch(() => setCost(null));
	}, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Dashboard</h1>
				<span className="sub">active &amp; archived campaigns (read-only projection of the host FS)</span>
			</div>
			<CostTiles cost={cost} />
			{err && <div className="card err">Could not load campaigns: {err}<div className="meta" style={{ marginTop: 8 }}>Set <code>VR_LAB_ROOT</code> on the server to the vr-lab checkout.</div></div>}
			{!err && camps === null && <div className="empty">loading…</div>}
			{!err && camps?.length === 0 && <div className="empty">No campaigns found under <code>campaigns/</code>.</div>}
			{camps && camps.length > 0 && (
				<div className="grid">
					{camps.map(c => (
						<a key={c.id} className="card click" href={`#/campaign/${encodeURIComponent(c.id)}`}>
							<h3>{c.title ?? c.id}</h3>
							<div className="meta mono">{c.id}</div>
							<div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
								<span className={`badge${c.platform === "windows" ? " win" : ""}`}>{c.platform}</span>
								{c.archived && <span className="badge arch">archived</span>}
								{c.scope && <span className="badge">{c.scope}</span>}
							</div>
							<div className="counts">
								<span className="pill h">hallucinations <b>{c.counts.hallucinations}</b></span>
								<span className="pill f">validated <b>{c.counts.findings}</b></span>
								<span className="pill r">rejected <b>{c.counts.rejected}</b></span>
								<span className="pill s">surfaces <b>{c.counts.surfaces}</b></span>
							</div>
						</a>
					))}
				</div>
			)}
		</div>
	);
}
