import { useEffect, useState } from "react";
import { api } from "../api";
import type { Task } from "../types";

const STATUS_CLASS: Record<string, string> = {
	draft: "na", running: "inprogress", paused: "blocked", completed: "passed", timed_out: "failed", stopped: "failed",
};

/** Tasks — the autonomous-orchestration list (TASKS-DESIGN). Create a task (seeds
 *  its exploration graph) and open it. The planner/worker engine lands in T1; today
 *  this is create-and-inspect. Requires Postgres (DATABASE_URL). */
export function Tasks({ onOpen }: { onOpen: (id: number) => void }) {
	const [rows, setRows] = useState<Task[] | null>(null);
	const [disabled, setDisabled] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [show, setShow] = useState(false);
	const [goal, setGoal] = useState("");
	const [name, setName] = useState("");
	const [cwd, setCwd] = useState("");
	const [allowMut, setAllowMut] = useState(false);
	const [busy, setBusy] = useState(false);

	const load = () => {
		setErr(null);
		api.tasks().then(r => {
			if (Array.isArray(r)) { setRows(r); setDisabled(false); } else { setDisabled(true); }
		}).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	const create = async () => {
		if (!goal.trim()) return;
		setBusy(true); setErr(null);
		try {
			const t = await api.createTask({ goal: goal.trim(), name: name.trim() || undefined, cwd: cwd.trim() || undefined, config: { allowMutations: allowMut } });
			setGoal(""); setName(""); setShow(false);
			onOpen(t.id);
		} catch (e) {
			setErr(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			<div className="pagehead">
				<h1>Tasks</h1>
				<span className="sub">autonomous runs — a goal, decomposed by a planner into intents workers pursue (engine: T1)</span>
				<button onClick={() => setShow(s => !s)} style={{ marginLeft: "auto" }} className="primary">{show ? "cancel" : "new task"}</button>
				<button onClick={load}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{disabled && <div className="card"><div className="meta">Tasks require Postgres. Set <code>DATABASE_URL</code> on the server to enable the autonomous layer.</div></div>}

			{show && !disabled && (
				<div className="card" style={{ marginBottom: 12 }}>
					<div className="kv">
						<div className="k">Goal</div><div><textarea value={goal} onChange={e => setGoal(e.target.value)} placeholder="What to achieve, e.g. prove a low-priv → SYSTEM EOP in driver X" style={{ width: "100%", minHeight: 54 }} /></div>
						<div className="k">Name</div><div><input value={name} onChange={e => setName(e.target.value)} placeholder="optional" style={{ width: "100%" }} /></div>
						<div className="k">Working dir</div><div><input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="defaults to the server cwd (a campaign dir)" style={{ width: "100%" }} /></div>
						<div className="k">Mutations</div><div><label className="meta" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={allowMut} onChange={e => setAllowMut(e.target.checked)} /> allow mutating tools (else read-only-only)</label></div>
					</div>
					<div style={{ marginTop: 10, textAlign: "right" }}><button className="primary" disabled={busy || !goal.trim()} onClick={create}>{busy ? "creating…" : "create task"}</button></div>
				</div>
			)}

			{!disabled && rows === null && !err && <div className="empty">loading…</div>}
			{!disabled && rows?.length === 0 && <div className="empty">No tasks yet — create one to seed an exploration graph.</div>}
			{!disabled && rows && rows.length > 0 && (
				<div className="card" style={{ padding: 0 }}>
					<table className="gatetable" style={{ margin: 0 }}>
						<thead><tr style={{ color: "var(--muted)", fontSize: 12 }}><td>Task</td><td>Goal</td><td>Status</td><td>Created</td><td></td></tr></thead>
						<tbody>
							{rows.map(t => (
								<tr key={t.id}>
									<td><strong>{t.name || `task #${t.id}`}</strong><div className="meta mono" style={{ fontSize: 11 }}>#{t.id}</div></td>
									<td className="meta" style={{ maxWidth: 420 }}>{t.goal}</td>
									<td><span className={`gate ${STATUS_CLASS[t.status] ?? ""}`}>{t.status}</span></td>
									<td className="meta mono">{new Date(t.createdAt).toLocaleString()}</td>
									<td style={{ textAlign: "right" }}><button onClick={() => onOpen(t.id)}>open</button></td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
