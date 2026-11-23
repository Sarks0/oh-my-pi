import { useMemo } from "react";
import type { TaskGraph } from "../types";

const C = { green: "#22c55e", amber: "#f59e0b", red: "#ef4444", cyan: "#06b6d4", grey: "#5c6473", accent: "#4a9eed", fg: "#e6e9ef", muted: "#8b93a3", panel: "#141821" };
const NW = 210, NH = 48, COLW = 260, VGAP = 64, TOP = 40, LEFT = 14;

function kindStroke(kind: string, state: string): string {
	if (kind === "goal") return C.green;
	if (kind === "finding") return C.red;
	if (kind === "intent") return state === "done" ? C.grey : state === "running" ? C.accent : state === "open" ? C.amber : C.grey;
	return C.grey; // fact
}
function relColor(rel: string): string {
	return rel === "yields" ? C.cyan : rel === "proves" ? C.red : C.grey;
}

/** Depth-layered DAG of the exploration graph (TASKS-DESIGN §3.2): goal/intent/
 *  fact/finding nodes left-to-right by longest-path depth, edges coloured by rel
 *  (spawns grey, yields cyan, proves red). */
export function TaskGraphView({ graph }: { graph: TaskGraph }) {
	const layout = useMemo(() => {
		const depth = new Map<number, number>();
		for (const n of graph.nodes) depth.set(n.id, 0);
		for (let pass = 0; pass < graph.nodes.length; pass++) {
			let changed = false;
			for (const e of graph.edges) {
				const d = (depth.get(e.from) ?? 0) + 1;
				if (d > (depth.get(e.to) ?? 0)) { depth.set(e.to, d); changed = true; }
			}
			if (!changed) break;
		}
		const byCol = new Map<number, number>(); // depth → count so far
		const pos = new Map<number, { x: number; y: number; cy: number }>();
		let maxCol = 0, maxRow = 0;
		for (const n of graph.nodes) {
			const d = depth.get(n.id) ?? 0;
			const row = byCol.get(d) ?? 0;
			byCol.set(d, row + 1);
			const x = LEFT + d * COLW;
			const y = TOP + row * VGAP;
			pos.set(n.id, { x, y, cy: y + NH / 2 });
			maxCol = Math.max(maxCol, d);
			maxRow = Math.max(maxRow, row);
		}
		return { pos, width: LEFT + (maxCol + 1) * COLW, height: TOP + (maxRow + 1) * VGAP };
	}, [graph]);

	if (graph.nodes.length === 0) return <div className="empty">No graph yet.</div>;
	const { pos, width, height } = layout;

	return (
		<div style={{ overflowX: "auto" }}>
			<svg width={Math.max(width, 400)} height={height} style={{ minWidth: Math.max(width, 400) }}>
				{graph.edges.map((e, i) => {
					const a = pos.get(e.from), b = pos.get(e.to);
					if (!a || !b) return null;
					const [l, r] = a.x <= b.x ? [a, b] : [b, a];
					const mx = (l.x + NW + r.x) / 2;
					return <path key={i} d={`M ${l.x + NW} ${l.cy} C ${mx} ${l.cy}, ${mx} ${r.cy}, ${r.x} ${r.cy}`} fill="none" stroke={relColor(e.rel)} strokeWidth={1.5} opacity={0.6} />;
				})}
				{graph.nodes.map(n => {
					const p = pos.get(n.id);
					if (!p) return null;
					const stroke = kindStroke(n.kind, n.state);
					const label = n.text.length > 28 ? n.text.slice(0, 27) + "…" : n.text;
					return (
						<g key={n.id}>
							<rect x={p.x} y={p.y} width={NW} height={NH} rx={7} fill={C.panel} stroke={stroke} strokeWidth={1.5} />
							<text x={p.x + 10} y={p.y + 17} fill={stroke} fontSize={10} fontFamily="ui-monospace, monospace">{n.kind} · {n.state}</text>
							<text x={p.x + 10} y={p.y + 35} fill={C.fg} fontSize={12}>{label}</text>
						</g>
					);
				})}
			</svg>
			<div className="meta" style={{ marginTop: 8, display: "flex", gap: 14, fontSize: 11, flexWrap: "wrap" }}>
				<span style={{ color: C.green }}>■ goal</span>
				<span style={{ color: C.amber }}>■ intent (open)</span>
				<span style={{ color: C.accent }}>■ intent (running)</span>
				<span style={{ color: C.grey }}>■ fact / done</span>
				<span style={{ color: C.red }}>■ finding</span>
				<span style={{ color: C.cyan }}>— yields</span>
				<span style={{ color: C.grey }}>— spawns</span>
			</div>
		</div>
	);
}
