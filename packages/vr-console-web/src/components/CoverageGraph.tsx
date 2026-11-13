import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CoverageGraph as Graph, GraphNode } from "../types";

const COLX: Record<string, number> = { binary: 20, surface: 300, finding: 580 };
const NW = 230, NH = 46, VGAP = 62, TOP = 56;

const C = { green: "#22c55e", amber: "#f59e0b", red: "#ef4444", cyan: "#06b6d4", grey: "#5c6473", line: "#2b313d", accent: "#4a9eed", fg: "#e6e9ef", muted: "#8b93a3" };

function covRatio(n: GraphNode): number | null {
	if (n.kind !== "binary" || !n.coverage || !n.coverage.total) return null;
	return n.coverage.reviewed / n.coverage.total;
}
function nodeStroke(n: GraphNode): string {
	if (n.kind === "surface") return C.cyan;
	if (n.kind === "finding") return n.status === "validated" ? C.green : n.status === "rejected" ? C.red : C.amber;
	const r = covRatio(n);
	if (r == null) return C.grey;
	return r >= 0.66 ? C.green : r >= 0.33 ? C.amber : C.red;
}

export function CoverageGraph({ campaignId }: { campaignId: string }) {
	const [g, setG] = useState<Graph | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		setG(null); setErr(null);
		api.graph(campaignId).then(setG).catch(e => setErr(String(e.message ?? e)));
	}, [campaignId]);

	const layout = useMemo(() => {
		if (!g) return null;
		const pos = new Map<string, { x: number; y: number; cy: number }>();
		const counts: Record<string, number> = { binary: 0, surface: 0, finding: 0 };
		for (const n of g.nodes) {
			const col = COLX[n.kind] ?? COLX.finding;
			const i = counts[n.kind] ?? 0;
			counts[n.kind] = i + 1;
			const y = TOP + i * VGAP;
			pos.set(n.id, { x: col, y, cy: y + NH / 2 });
		}
		const rows = Math.max(counts.binary, counts.surface, counts.finding, 1);
		return { pos, height: TOP + rows * VGAP + 20 };
	}, [g]);

	if (err) return <div className="card err">Could not load graph: {err}</div>;
	if (!g || !layout) return <div className="empty">loading graph…</div>;
	if (g.nodes.length === 0) return <div className="empty">No graph data — add surfaces, findings, and coverage ledgers to this campaign.</div>;

	const { pos, height } = layout;

	return (
		<div className="card" style={{ overflowX: "auto" }}>
			<div className="meta" style={{ marginBottom: 8 }}>
				binary ← surface ← finding. Binary nodes show review coverage (reviewed/total). Function/sink call-path nodes are added from live binary-mcp data on the host.
			</div>
			<svg width={820} height={height} style={{ minWidth: 820 }}>
				{/* column headers */}
				<text x={COLX.binary} y={32} fill={C.muted} fontSize={12}>Binaries (coverage)</text>
				<text x={COLX.surface} y={32} fill={C.muted} fontSize={12}>Surfaces</text>
				<text x={COLX.finding} y={32} fill={C.muted} fontSize={12}>Findings</text>

				{/* edges first (behind nodes) */}
				{g.edges.map((e, i) => {
					const a = pos.get(e.from), b = pos.get(e.to);
					if (!a || !b) return null;
					const [l, r] = a.x < b.x ? [a, b] : [b, a];
					return <line key={i} x1={l.x + NW} y1={l.cy} x2={r.x} y2={r.cy} stroke={e.kind === "cites" ? C.accent : C.grey} strokeWidth={1.5} opacity={0.6} />;
				})}

				{/* nodes */}
				{g.nodes.map(n => {
					const p = pos.get(n.id);
					if (!p) return null;
					const stroke = nodeStroke(n);
					const r = covRatio(n);
					return (
						<g key={n.id}>
							<rect x={p.x} y={p.y} width={NW} height={NH} rx={7} fill="#141821" stroke={stroke} strokeWidth={1.5} />
							<text x={p.x + 10} y={p.y + (n.sub || r != null ? 19 : 28)} fill={C.fg} fontSize={13} fontFamily="ui-monospace, monospace">
								{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}
							</text>
							{n.sub && <text x={p.x + 10} y={p.y + 36} fill={C.muted} fontSize={11}>{n.sub}</text>}
							{r != null && n.coverage && (
								<>
									<rect x={p.x + 10} y={p.y + 30} width={NW - 70} height={6} rx={3} fill="#0c0f14" />
									<rect x={p.x + 10} y={p.y + 30} width={(NW - 70) * r} height={6} rx={3} fill={stroke} />
									<text x={p.x + NW - 50} y={p.y + 36} fill={C.muted} fontSize={10}>{n.coverage.reviewed}/{n.coverage.total}</text>
								</>
							)}
						</g>
					);
				})}
			</svg>
		</div>
	);
}
