import { useEffect, useState } from "react";
import { api } from "../api";
import type { CampaignDetail, FindingSummary } from "../types";
import { SessionPanel } from "./SessionPanel";

// Windows-profile required gates (vr-lab/docs/validation-gates.md); gate2b is windows-only.
const WINDOWS_GATES = [
	"gate0_poc_compiles",
	"gate1a_canary_clean_repro",
	"gate2_security_impact",
	"gate2b_severity_bar",
	"gate3_privilege_context",
	"gate4_report_package",
] as const;

const TABS = ["Overview", "Findings + Gates", "Surfaces", "Session"] as const;
type Tab = (typeof TABS)[number];

function GateChips({ present }: { present: string[] }) {
	const set = new Set(present);
	return (
		<div className="gatechips">
			{WINDOWS_GATES.map(g => (
				<span key={g} className={`gate${set.has(g) ? " on" : ""}`} title={set.has(g) ? "evidence recorded" : "not started"}>
					{g.replace(/^gate/, "g").replace(/_/g, " ")}
				</span>
			))}
		</div>
	);
}

function FindingCard({ f }: { f: FindingSummary }) {
	return (
		<div className="finding">
			<div className="fid mono">{f.id}</div>
			{f.surface_id && <div className="inv mono">↳ {f.surface_id}</div>}
			{f.security_invariant && <div className="inv">invariant: {f.security_invariant}</div>}
			<GateChips present={f.gates} />
		</div>
	);
}

function FindingsBoard({ findings }: { findings: FindingSummary[] }) {
	const cols: { key: string; cls: string; title: string; state: string }[] = [
		{ key: "h", cls: "hall", title: "Hallucinations", state: "hallucination" },
		{ key: "f", cls: "val", title: "Validated", state: "validated" },
		{ key: "r", cls: "rej", title: "Rejected", state: "rejected" },
	];
	return (
		<div>
			<div className="meta" style={{ marginBottom: 12 }}>
				Read-only over projected host state — a finding leaves <code>hallucinations/</code> only via <code>finding_promote</code> on the host. The console can display and request, never fake a promotion.
			</div>
			<div className="board">
				{cols.map(col => {
					const items = findings.filter(f => f.state === col.state);
					return (
						<div key={col.key} className={`col ${col.cls}`}>
							<h4><span>{col.title}</span><span>{items.length}</span></h4>
							{items.length === 0 && <div className="meta">—</div>}
							{items.map(f => <FindingCard key={f.id} f={f} />)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function CampaignView({ id }: { id: string }) {
	const [camp, setCamp] = useState<CampaignDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("Overview");

	useEffect(() => {
		setCamp(null);
		setErr(null);
		api.campaign(id).then(setCamp).catch(e => setErr(String(e.message ?? e)));
	}, [id]);

	if (err) return <div className="card err">Could not load {id}: {err} <div style={{ marginTop: 8 }}><a href="#/">← back</a></div></div>;
	if (!camp) return <div className="empty">loading {id}…</div>;

	return (
		<div>
			<div className="pagehead">
				<a href="#/" style={{ fontSize: 13 }}>← Campaigns</a>
				<h1>{camp.title ?? camp.id}</h1>
				<span className="sub mono">{camp.id}</span>
				<span className={`badge${camp.platform === "windows" ? " win" : ""}`}>{camp.platform}</span>
			</div>

			<div className="tabs">
				{TABS.map(t => (
					<div key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
						{t}
						{t === "Findings + Gates" ? ` (${camp.findings.length})` : t === "Surfaces" ? ` (${camp.surfaces.length})` : ""}
					</div>
				))}
			</div>

			{tab === "Overview" && (
				<div className="card">
					<div className="kv">
						<div className="k">Platform</div><div>{camp.platform}</div>
						<div className="k">Scope</div><div>{camp.scope ?? "—"}</div>
						<div className="k">Hallucinations</div><div>{camp.counts.hallucinations}</div>
						<div className="k">Validated findings</div><div>{camp.counts.findings}</div>
						<div className="k">Rejected</div><div>{camp.counts.rejected}</div>
						<div className="k">Surfaces</div><div>{camp.counts.surfaces}</div>
					</div>
					<details style={{ marginTop: 14 }}>
						<summary className="meta">campaign.yaml (raw)</summary>
						<pre className="log" style={{ marginTop: 8 }}>{JSON.stringify(camp.raw, null, 2)}</pre>
					</details>
				</div>
			)}
			{tab === "Findings + Gates" && <FindingsBoard findings={camp.findings} />}
			{tab === "Surfaces" && (
				<div className="grid">
					{camp.surfaces.length === 0 && <div className="empty">no surface records</div>}
					{camp.surfaces.map(s => (
						<div key={s.id} className="card">
							<h3 className="mono" style={{ fontSize: 13 }}>{s.id}</h3>
							<pre className="log" style={{ marginTop: 8 }}>{JSON.stringify(s.raw, null, 2)}</pre>
						</div>
					))}
				</div>
			)}
			{tab === "Session" && <SessionPanel />}
		</div>
	);
}
