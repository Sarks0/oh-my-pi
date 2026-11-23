import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { McpInfo, McpTool } from "../types";

/** MCP panel — the servers omp connected for this session and the tools they minted
 *  (the exact names the approval policy is keyed on). Grouped by server. */
export function Mcp() {
	const [info, setInfo] = useState<McpInfo | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const load = () => {
		setErr(null);
		api.mcp().then(setInfo).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	const groups = useMemo(() => {
		const by = new Map<string, McpTool[]>();
		for (const t of info?.tools ?? []) {
			const k = t.server ?? "(unknown)";
			(by.get(k) ?? by.set(k, []).get(k)!).push(t);
		}
		// surface every connected server even if it minted no tools
		for (const s of info?.connectedServers ?? []) if (!by.has(s)) by.set(s, []);
		return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [info]);

	return (
		<div>
			<div className="pagehead">
				<h1>MCP</h1>
				<span className="sub">connected MCP servers and the tools they minted into this session</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{!info && !err && <div className="empty">connecting to MCP servers…</div>}
			{info && info.connectedServers.length === 0 && info.tools.length === 0 && (
				<div className="empty">No MCP servers connected for this working directory.</div>
			)}
			{info && groups.map(([server, tools]) => (
				<div className="card" key={server} style={{ marginBottom: 12 }}>
					<div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
						<strong className="mono">{server}</strong>
						<span className="meta">{tools.length} tool{tools.length === 1 ? "" : "s"}</span>
					</div>
					{tools.length === 0 ? (
						<div className="meta">connected — no tools exposed</div>
					) : (
						<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
							{tools.map(t => (
								<code key={t.name} className="chip" title={t.name}>{t.name}</code>
							))}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
