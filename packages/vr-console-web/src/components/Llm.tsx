import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ModelDTO, ModelsInfo } from "../types";

function ctxLabel(n: number | null): string {
	if (!n) return "";
	return n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

/** LLM panel — the model picker. Lists every auth-configured chat model omp can
 *  switch to (getAvailable → only providers with credentials), grouped by provider,
 *  and switches the live session's model via POST /api/model. */
export function Llm() {
	const [info, setInfo] = useState<ModelsInfo | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null); // "provider/id" being switched to

	const load = () => {
		setErr(null);
		api.models().then(setInfo).catch(e => setErr(String(e.message ?? e)));
	};
	useEffect(load, []);

	const groups = useMemo(() => {
		const by = new Map<string, Array<ModelDTO & { current: boolean }>>();
		for (const m of info?.models ?? []) (by.get(m.provider) ?? by.set(m.provider, []).get(m.provider)!).push(m);
		return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [info]);

	const switchTo = async (m: ModelDTO) => {
		const ref = `${m.provider}/${m.id}`;
		setBusy(ref);
		setErr(null);
		try {
			const res = await api.setModel(m.provider, m.id);
			if (res.error) setErr(res.error);
			load();
		} catch (e) {
			setErr(String((e as Error).message ?? e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div>
			<div className="pagehead">
				<h1>LLM</h1>
				<span className="sub">the session's model, and every model omp can switch to (providers with credentials)</span>
				<button onClick={load} style={{ marginLeft: "auto" }}>refresh</button>
			</div>
			{err && <div className="card err">{err}</div>}
			{!info && !err && <div className="empty">loading models…</div>}
			{info && (
				<div className="card" style={{ marginBottom: 12 }}>
					<div className="kv">
						<div className="k">Current model</div>
						<div className="mono">
							{info.current ? <><strong>{info.current.provider}/{info.current.id}</strong>{info.current.contextWindow ? <span className="meta"> · {ctxLabel(info.current.contextWindow)}</span> : null}</> : <span className="meta">— (binds on first prompt)</span>}
						</div>
					</div>
				</div>
			)}
			{info && info.models.length === 0 && !err && (
				<div className="empty">No models available — omp found no provider with configured credentials in this environment.</div>
			)}
			{info && groups.map(([provider, models]) => (
				<div className="card" key={provider} style={{ marginBottom: 12 }}>
					<div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
						<strong className="mono">{provider}</strong>
						<span className="meta">{models.length} model{models.length === 1 ? "" : "s"}</span>
					</div>
					<table className="gatetable" style={{ margin: 0 }}>
						<tbody>
							{models.map(m => {
								const ref = `${m.provider}/${m.id}`;
								return (
									<tr key={ref}>
										<td className="mono" style={{ whiteSpace: "nowrap" }}>{m.id}{m.current && <span className="gate passed" style={{ marginLeft: 8 }}>current</span>}</td>
										<td className="meta">{m.name !== m.id ? m.name : ""}</td>
										<td className="meta mono" style={{ whiteSpace: "nowrap" }}>{ctxLabel(m.contextWindow)}</td>
										<td style={{ textAlign: "right" }}>
											<button disabled={m.current || busy !== null} onClick={() => switchTo(m)}>
												{busy === ref ? "switching…" : m.current ? "in use" : "use"}
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			))}
		</div>
	);
}
