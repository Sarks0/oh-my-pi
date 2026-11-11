import { useEffect, useState } from "react";
import { api } from "../api";
import type { CampaignSummary } from "../types";

export function Dashboard() {
	const [camps, setCamps] = useState<CampaignSummary[] | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		api.campaigns("all").then(setCamps).catch(e => setErr(String(e.message ?? e)));
	}, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Dashboard</h1>
				<span className="sub">active &amp; archived campaigns (read-only projection of the host FS)</span>
			</div>
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
