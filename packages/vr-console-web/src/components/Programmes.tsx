import { useEffect, useState } from "react";
import { api } from "../api";
import type { Programme } from "../types";

const fmt = (n?: number) => (typeof n === "number" ? "$" + n.toLocaleString() : "—");

export function Programmes() {
	const [progs, setProgs] = useState<Programme[] | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		api.programmes().then(setProgs).catch(e => setErr(String(e.message ?? e)));
	}, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Scope + Programmes</h1>
				<span className="sub">bounty programme reference (read-only) — scope authority stays on the host</span>
			</div>
			{err && <div className="card err">Could not load programmes: {err}<div className="meta" style={{ marginTop: 8 }}>Set <code>VR_LAB_ROOT</code> to the vr-lab checkout (<code>targets/bounty_programs.yaml</code>).</div></div>}
			{!err && progs === null && <div className="empty">loading…</div>}
			{progs?.length === 0 && <div className="empty">No programmes in <code>targets/bounty_programs.yaml</code>.</div>}
			{progs && progs.length > 0 && (
				<div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
					{progs.map(p => (
						<div key={p.name} className="card">
							<h3>{p.name}</h3>
							{p.description && <div className="meta">{p.description}</div>}
							<div style={{ display: "flex", gap: 6, margin: "8px 0", flexWrap: "wrap" }}>
								{p.competition_level && <span className="badge">competition: {p.competition_level}</span>}
								<span className="badge win">{fmt(p.min_payout)} – {fmt(p.max_payout)}</span>
								<span className="badge">{p.bug_classes.length} classes</span>
							</div>
							<table className="gatetable">
								<tbody>
									{Object.entries(p.payouts_min)
										.sort((a, b) => b[1] - a[1])
										.map(([k, v]) => (
											<tr key={k}>
												<td className="mono">{k}</td>
												<td style={{ textAlign: "right", color: "var(--green)" }}>{fmt(v)}</td>
											</tr>
										))}
								</tbody>
							</table>
							{p.url && <div style={{ marginTop: 8 }}><a href={p.url} target="_blank" rel="noreferrer">programme policy ↗</a></div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
