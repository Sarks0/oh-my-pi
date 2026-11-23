import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { TaskGraphView } from "./TaskGraphView";
import type { Task, TaskActivity, TaskGraph } from "../types";

const STATUS_CLASS: Record<string, string> = {
	draft: "na", running: "inprogress", paused: "blocked", completed: "passed", timed_out: "failed", stopped: "failed",
};

function fmtTime(s: string): string {
	try { return new Date(s).toLocaleTimeString(); } catch { return s; }
}

/** Task detail (TASKS-DESIGN §7): the task header + status controls that drive the
 *  live engine, the exploration-graph DAG, and the activity timeline. Polls while the
 *  task is running so the graph and timeline update as the planner/workers progress. */
export function TaskView({ id, onBack }: { id: number; onBack: () => void }) {
	const [task, setTask] = useState<Task | null>(null);
	const [graph, setGraph] = useState<TaskGraph | null>(null);
	const [activity, setActivity] = useState<TaskActivity[]>([]);
	const [err, setErr] = useState<string | null>(null);
	const [tab, setTab] = useState<"graph" | "activity" | "overview">("graph");
	const timer = useRef<ReturnType<typeof setInterval> | null>(null);

	const load = () => {
		api.task(id).then(setTask).catch(e => setErr(String(e.message ?? e)));
		api.taskGraph(id).then(setGraph).catch(() => {});
		api.taskActivity(id).then(setActivity).catch(() => {});
	};
	useEffect(() => { setErr(null); load(); }, [id]);

	// poll while running (the engine advances the graph + activity in the background)
	useEffect(() => {
		if (timer.current) { clearInterval(timer.current); timer.current = null; }
		if (task?.status === "running") timer.current = setInterval(load, 3000);
		return () => { if (timer.current) clearInterval(timer.current); };
	}, [task?.status, id]);

	const control = async (action: "start" | "pause" | "resume" | "stop") => {
		try { await api.taskControl(id, action); load(); } catch (e) { setErr(String((e as Error).message ?? e)); }
	};

	if (err) return <div><div className="pagehead"><button onClick={onBack}>← tasks</button></div><div className="card err">{err}</div></div>;
	if (!task) return <div className="empty">loading…</div>;

	const running = task.status === "running";
	const facts = graph?.nodes.filter(n => n.kind === "fact" && n.state === "confirmed").length ?? 0;
	const findings = graph?.nodes.filter(n => n.kind === "finding").length ?? 0;

	return (
		<div>
			<div className="pagehead">
				<button onClick={onBack}>← tasks</button>
				<h1 style={{ marginLeft: 10 }}>{task.name || `task #${task.id}`}</h1>
				<span className={`gate ${STATUS_CLASS[task.status] ?? ""}`} style={{ marginLeft: 8 }}>{task.status}</span>
				{running && <span className="meta" style={{ marginLeft: 8, fontSize: 11 }}>● live</span>}
				<div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
					{!running && task.status !== "completed" && <button className="primary" onClick={() => control(task.status === "paused" ? "resume" : "start")}>{task.status === "paused" ? "resume" : "start"}</button>}
					{running && <button onClick={() => control("pause")}>pause</button>}
					{task.status !== "stopped" && task.status !== "completed" && <button className="deny" onClick={() => control("stop")}>stop</button>}
					<button onClick={load}>refresh</button>
				</div>
			</div>
			<div className="meta" style={{ marginBottom: 6 }}>{task.goal}</div>
			<div className="meta" style={{ marginBottom: 10, fontSize: 12 }}>
				frontier {graph?.frontierOpen ?? 0} open · {graph?.running ?? 0} running · {facts} fact{facts === 1 ? "" : "s"}{findings ? ` · ${findings} finding${findings === 1 ? "" : "s"}` : ""}
			</div>

			<div className="tabs" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<button className={tab === "graph" ? "primary" : ""} onClick={() => setTab("graph")}>Exploration graph</button>
				<button className={tab === "activity" ? "primary" : ""} onClick={() => setTab("activity")}>Activity</button>
				<button className={tab === "overview" ? "primary" : ""} onClick={() => setTab("overview")}>Overview</button>
			</div>

			{tab === "graph" && <div className="card">{graph ? <TaskGraphView graph={graph} /> : <div className="empty">no graph</div>}</div>}

			{tab === "activity" && (
				<div className="card" style={{ padding: 0 }}>
					{activity.length === 0 && <div className="empty">No activity yet — start the task to run a planner round.</div>}
					{activity.length > 0 && (
						<table className="gatetable" style={{ margin: 0 }}>
							<thead><tr style={{ color: "var(--muted)", fontSize: 12 }}><td>Time</td><td>Event</td><td>Detail</td></tr></thead>
							<tbody>
								{activity.map(a => (
									<tr key={a.id}>
										<td className="meta mono" style={{ whiteSpace: "nowrap" }}>{fmtTime(a.ts)}</td>
										<td><span className="gate">{a.kind}</span></td>
										<td className="meta">{a.detail ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			)}

			{tab === "overview" && (
				<div className="card">
					<div className="kv">
						<div className="k">Goal</div><div>{task.goal}</div>
						<div className="k">Working dir</div><div className="mono" style={{ wordBreak: "break-all" }}>{task.cwd ?? "—"}</div>
						<div className="k">Mutations</div><div><span className={`gate ${task.config.allowMutations ? "failed" : "passed"}`}>{task.config.allowMutations ? "enabled" : "read-only-only"}</span></div>
						<div className="k">Concurrency</div><div>{task.config.concurrency ?? 2} workers</div>
						<div className="k">Created</div><div className="meta mono">{new Date(task.createdAt).toLocaleString()}</div>
					</div>
				</div>
			)}
		</div>
	);
}
