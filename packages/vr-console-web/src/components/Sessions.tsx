import { useEffect, useState } from "react";
import { api } from "../api";
import type { SessionListItem } from "../types";

/** Sessions — the multi-session manager. Lists every omp session the server holds,
 *  creates new ones (each with its own cwd), opens one into the HITL chat, and
 *  disposes the extras. The "default" session is the VR session and is pinned. */
export function Sessions({ activeId, onOpen }: { activeId: string; onOpen: (id: string) => void }) {
	const [rows, setRows] = useState<SessionListItem[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [cwd, setCwd] = useState("");
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);

	const load = () => {
		setErr(null);
		api.sessions().then(r => {
			setRows(r);
			if (!cwd) setCwd(r.find(s => s.id === "default")?.cwd ?? "");
		}).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	const create = async () => {
		setBusy(true);
		setErr(null);
		try {
			const meta = await api.createSession(cwd.trim() || undefined, title.trim() || undefined);
			setTitle("");
			load();
			onOpen(meta.id);
		} catch (e) {
			setErr(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	};

	const dispose = async (id: string) => {
		setErr(null);
		try {
			await api.deleteSession(id);
			if (activeId === id) onOpen("default");
			load();
		} catch (e) {
			setErr(String((e as Error).message ?? e));
		}
	};

	return (
		<div>
			<div className="pagehead">
				<h1>Sessions</h1>
				<span className="sub">every omp session on this server — open one into the HITL chat, or spin up another</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}

			<div className="card" style={{ marginBottom: 12 }}>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
					<input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working dir (cwd) — defaults to the server's" style={{ flex: "2 1 360px" }} />
					<input value={title} onChange={e => setTitle(e.target.value)} placeholder="title (optional)" style={{ flex: "1 1 160px" }} />
					<button className="primary" disabled={busy} onClick={create}>{busy ? "creating…" : "new session"}</button>
				</div>
			</div>

			{!rows && !err && <div className="empty">loading…</div>}
			{rows && rows.length > 0 && (
				<div className="card" style={{ padding: 0 }}>
					<table className="gatetable" style={{ margin: 0 }}>
						<thead>
							<tr style={{ color: "var(--muted)", fontSize: 12 }}>
								<td>Session</td><td>Working dir</td><td>Model</td><td>State</td><td>Clients</td><td></td>
							</tr>
						</thead>
						<tbody>
							{rows.map(s => (
								<tr key={s.id} style={s.id === activeId ? { background: "var(--panel, #0c1620)" } : undefined}>
									<td>
										<strong>{s.title}</strong>
										{s.id === activeId && <span className="gate inprogress" style={{ marginLeft: 8 }}>active</span>}
										{s.id === "default" && <span className="gate" style={{ marginLeft: 6 }}>default</span>}
										<div className="meta mono" style={{ fontSize: 11 }}>{s.id}</div>
									</td>
									<td className="meta mono" style={{ wordBreak: "break-all", maxWidth: 340 }}>{s.cwd}</td>
									<td className="mono meta">{s.model ?? "—"}</td>
									<td><span className={`gate ${s.started ? "passed" : "na"}`}>{s.started ? "running" : "idle"}</span></td>
									<td className="meta mono">{s.sockets}</td>
									<td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
										<button onClick={() => onOpen(s.id)}>open</button>
										{s.id !== "default" && <button className="deny" style={{ marginLeft: 6 }} onClick={() => dispose(s.id)}>stop</button>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
