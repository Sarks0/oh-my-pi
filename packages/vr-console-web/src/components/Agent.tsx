import { useEffect, useState } from "react";
import { api } from "../api";
import type { SessionInfo } from "../types";

/** Agent panel — the live omp session's posture: model/provider (captured off the
 *  event stream), cwd, the pinned approval mode, and MCP counts. Hitting this route
 *  starts the single in-process session, so model/provider fill in once a turn runs. */
export function Agent() {
	const [info, setInfo] = useState<SessionInfo | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const load = () => {
		setErr(null);
		api.session().then(setInfo).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Agent</h1>
				<span className="sub">the in-process omp session — model, working dir, approval posture, MCP wiring</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{!info && !err && <div className="empty">starting session…</div>}
			{info && (
				<div className="card">
					<div className="kv">
						<div className="k">Status</div>
						<div><span className={`gate ${info.started ? "passed" : "blocked"}`}>{info.started ? "running" : "idle"}</span></div>
						<div className="k">Model</div>
						<div className="mono">{info.model ?? <span className="meta">— (runs on first prompt)</span>}</div>
						<div className="k">Provider</div>
						<div className="mono">{info.provider ?? "—"}{info.api ? <span className="meta"> · {info.api}</span> : null}</div>
						<div className="k">Approval mode</div>
						<div><span className="gate blocked">{info.approvalMode}</span> <span className="meta">fail-closed; every MCP tool cards</span></div>
						<div className="k">Working dir</div>
						<div className="mono" style={{ wordBreak: "break-all" }}>{info.cwd ?? "—"}</div>
						<div className="k">MCP</div>
						<div>{info.mcp.servers} server{info.mcp.servers === 1 ? "" : "s"} · {info.mcp.tools} tool{info.mcp.tools === 1 ? "" : "s"}</div>
					</div>
				</div>
			)}
		</div>
	);
}
