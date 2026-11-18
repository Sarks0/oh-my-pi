import { useEffect, useState } from "react";
import { api } from "../api";
import type { SkillsInfo } from "../types";

/** Skills panel — the skills omp discovered for this working dir (discoverSkills).
 *  A pure FS/settings read, so it resolves without starting the agent session. */
export function Skills() {
	const [info, setInfo] = useState<SkillsInfo | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const load = () => {
		setErr(null);
		api.skills().then(setInfo).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	return (
		<div>
			<div className="pagehead">
				<h1>Skills</h1>
				<span className="sub">skills omp discovered for this working directory</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{!info && !err && <div className="empty">loading…</div>}
			{info?.warnings?.map((w, i) => <div className="card err" key={i}>{w}</div>)}
			{info && info.skills.length === 0 && !err && <div className="empty">No skills discovered.</div>}
			{info && info.skills.length > 0 && (
				<div className="card" style={{ padding: 0 }}>
					<table className="gatetable" style={{ margin: 0 }}>
						<thead>
							<tr style={{ color: "var(--muted)", fontSize: 12 }}>
								<td>Skill</td><td>Description</td>
							</tr>
						</thead>
						<tbody>
							{info.skills.map(s => (
								<tr key={s.name}>
									<td className="mono" style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>{s.name}</td>
									<td className="meta">{s.description || "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
