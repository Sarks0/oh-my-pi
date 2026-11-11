import { useEffect, useState } from "react";
import { api } from "../api";
import type { ApprovalRecord } from "../types";

const STATUS_CLASS: Record<string, string> = {
	allowed: "passed", denied: "failed", pending: "blocked", timeout: "na",
};

function fmtTime(s?: string | null): string {
	if (!s) return "—";
	try { return new Date(s).toLocaleString(); } catch { return s; }
}

export function ApprovalRecords() {
	const [rows, setRows] = useState<ApprovalRecord[] | null>(null);
	const [disabled, setDisabled] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const load = () => {
		api.approvals().then(r => {
			if (Array.isArray(r)) { setRows(r); setDisabled(false); } else { setDisabled(true); }
		}).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Approval Records</h1>
				<span className="sub">every tool-approval decision, audited (projection only — campaign-mcp stays the authority)</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{disabled && <div className="card"><div className="meta">Approval auditing requires Postgres. Set <code>DATABASE_URL</code> on the server to persist and view records.</div></div>}
			{!disabled && rows === null && !err && <div className="empty">loading…</div>}
			{!disabled && rows?.length === 0 && <div className="empty">No approval decisions recorded yet.</div>}
			{!disabled && rows && rows.length > 0 && (
				<div className="card" style={{ padding: 0 }}>
					<table className="gatetable" style={{ margin: 0 }}>
						<thead>
							<tr style={{ color: "var(--muted)", fontSize: 12 }}>
								<td>Raised</td><td>Status</td><td>Answer</td><td>Source</td><td>Prompt</td><td>Decided</td>
							</tr>
						</thead>
						<tbody>
							{rows.map(r => (
								<tr key={r.id}>
									<td className="meta mono">{fmtTime(r.raised_at)}</td>
									<td><span className={`gate ${STATUS_CLASS[r.status] ?? ""}`}>{r.status}</span></td>
									<td className="mono">{r.answer ?? "—"}</td>
									<td className="meta">{r.decision_source ?? "—"}</td>
									<td style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.compact ?? ""}>{r.compact ?? "—"}</td>
									<td className="meta mono">{fmtTime(r.decided_at)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
