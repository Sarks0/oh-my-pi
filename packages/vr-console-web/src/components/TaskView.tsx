import { useEffect, useState } from "react";
import { api } from "../api";
import type { Task, TaskGraph } from "../types";

const STATUS_CLASS: Record<string, string> = {
	draft: "na", running: "inprogress", paused: "blocked", completed: "passed", timed_out: "failed", stopped: "failed",
};
const KIND_CLASS: Record<string, string> = { goal: "passed", intent: "inprogress", fact: "", finding: "failed", hint: "blocked" };

/** Task detail (TASKS-DESIGN §7). T0 shell: the task header, status controls (status
 *  transitions only — the planner/worker engine is T1), and the exploration graph
 *  (nodes by kind + edges). The full DAG renderer is T2. */
export function TaskView({ id, onBack }: { id: number; onBack: () => void }) {
	const [task, setTask] = useState<Task | null>(null);
	const [graph, setGraph] = useState<TaskGraph | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [tab, setTab] = useState<"overview" | "graph">("overview");

	const load = () => {
		setErr(null);
		api.task(id).then(setTask).catch(e => setErr(String(e.message ?? e)));
		api.taskGraph(id).then(setGraph).catch(() => setGraph(null));
	};
	useEffect(load, [id]);

	const control = async (action: "start" | "pause" | "resume" | "stop") => {
		try { await api.taskControl(id, action); load(); } catch (e) { setErr(String((e as Error).message ?? e)); }
	};

	if (err) return <div><div className="pagehead"><button onClick={onBack}>← tasks</button></div><div className="card err">{err}</div></div>;
	if (!task) return <div className="empty">loading…</div>;

	const running = task.status === "running";
	return (
		<div>
			<div className="pagehead">
				<button onClick={onBack}>← tasks</button>
				<h1 style={{ marginLeft: 10 }}>{task.name || `task #${task.id}`}</h1>
				<span className={`gate ${STATUS_CLASS[task.status] ?? ""}`} style={{ marginLeft: 8 }}>{task.status}</span>
				<div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
					{!running && task.status !== "completed" && <button className="primary" onClick={() => control(task.status === "paused" ? "resume" : "start")}>{task.status === "paused" ? "resume" : "start"}</button>}
					{running && <button onClick={() => control("pause")}>pause</button>}
					{task.status !== "stopped" && task.status !== "completed" && <button className="deny" onClick={() => control("stop")}>stop</button>}
					<button onClick={load}>refresh</button>
				</div>
			</div>
			<div className="meta" style={{ marginBottom: 10 }}>{task.goal}</div>

			<div className="tabs" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<button className={tab === "overview" ? "primary" : ""} onClick={() => setTab("overview")}>Overview</button>
				<button className={tab === "graph" ? "primary" : ""} onClick={() => setTab("graph")}>Exploration graph</button>
			</div>

			{tab === "overview" && (
				<div className="card">
					<div className="kv">
						<div className="k">Goal</div><div>{task.goal}</div>
						<div className="k">Working dir</div><div className="mono" style={{ wordBreak: "break-all" }}>{task.cwd ?? "—"}</div>
						<div className="k">Mutations</div><div><span className={`gate ${task.config.allowMutations ? "failed" : "passed"}`}>{task.config.allowMutations ? "enabled" : "read-only-only"}</span></div>
						<div className="k">Frontier</div><div>{graph ? `${graph.frontierOpen} open · ${graph.running} running` : "—"}</div>
						<div className="k">Created</div><div className="meta mono">{new Date(task.createdAt).toLocaleString()}</div>
					</div>
					<div className="meta" style={{ marginTop: 10, fontSize: 12 }}>The planner/worker engine is Phase T1. Today a task seeds its exploration graph and supports status transitions.</div>
				</div>
			)}

			{tab === "graph" && (
				<div className="card">
					{!graph && <div className="empty">no graph</div>}
					{graph && (
						<>
							<div className="meta" style={{ marginBottom: 8 }}>{graph.nodes.length} nodes · {graph.edges.length} edges · frontier {graph.frontierOpen} open</div>
							<table className="gatetable" style={{ margin: 0 }}>
								<thead><tr style={{ color: "var(--muted)", fontSize: 12 }}><td>#</td><td>Kind</td><td>State</td><td>Text</td></tr></thead>
								<tbody>
									{graph.nodes.map(n => (
										<tr key={n.id}>
											<td className="meta mono">{n.id}</td>
											<td><span className={`gate ${KIND_CLASS[n.kind] ?? ""}`}>{n.kind}</span></td>
											<td className="meta mono">{n.state}</td>
											<td className="meta">{n.text}</td>
										</tr>
									))}
								</tbody>
							</table>
						</>
					)}
				</div>
			)}
		</div>
	);
}
