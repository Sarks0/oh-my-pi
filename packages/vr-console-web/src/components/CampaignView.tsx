import { useEffect, useState } from "react";
import { api } from "../api";
import type { CampaignDetail, FindingDetail, FindingSummary, GateInfo, GateStatus } from "../types";
import { SessionPanel } from "./SessionPanel";

// Windows-profile required gates (vr-lab/docs/validation-gates.md); gate2b is windows-only.
const WINDOWS_GATES = [
	"gate0_poc_compiles",
	"gate1a_canary_clean_repro",
	"gate2_security_impact",
	"gate2b_severity_bar",
	"gate3_privilege_context",
	"gate4_report_package",
];
const STATUS_CLASS: Record<GateStatus, string> = {
	passed: "passed", failed: "failed", blocked: "blocked",
	in_progress: "inprogress", not_applicable: "na", not_started: "",
};
const GATE_STATUSES: GateStatus[] = ["not_started", "in_progress", "passed", "failed", "blocked", "not_applicable"];
const shortGate = (n: string) => n.replace(/^gate/, "g").replace(/_/g, " ");

const TABS = ["Overview", "Findings + Gates", "Surfaces", "Session"] as const;
type Tab = (typeof TABS)[number];

function GateChips({ gates }: { gates: GateInfo[] }) {
	const list: GateInfo[] = gates.length
		? gates
		: WINDOWS_GATES.map(name => ({ name, status: "not_started" as GateStatus, required: true, evidence_count: 0 }));
	return (
		<div className="gatechips">
			{list.map(g => (
				<span key={g.name} className={`gate ${STATUS_CLASS[g.status]}`} title={`${g.name}: ${g.status}${g.required ? " (required)" : ""} · ${g.evidence_count} evidence file(s)`}>
					{shortGate(g.name)}{g.evidence_count ? ` ·${g.evidence_count}` : ""}
				</span>
			))}
		</div>
	);
}

function FindingCard({ f, onOpen }: { f: FindingSummary; onOpen: () => void }) {
	return (
		<div className="finding click" onClick={onOpen}>
			<div className="fid mono">{f.id}</div>
			{f.surface_id && <div className="inv mono">↳ {f.surface_id}</div>}
			{f.security_invariant && <div className="inv">invariant: {f.security_invariant}</div>}
			<GateChips gates={f.gates} />
		</div>
	);
}

function EvidencePreview({ url, name }: { url: string; name: string }) {
	const [text, setText] = useState<string | null>(null);
	const [binary, setBinary] = useState(false);
	useEffect(() => {
		let on = true;
		fetch(url).then(async r => {
			const ct = r.headers.get("content-type") || "";
			if (/^(text\/|application\/(json|xml|javascript|x-yaml)|application\/octet-stream)/.test(ct) || ct === "") {
				const t = await r.text();
				if (on) setText(t.length > 20000 ? t.slice(0, 20000) + "\n…[truncated]" : t);
			} else if (on) setBinary(true);
		}).catch(() => on && setBinary(true));
		return () => { on = false; };
	}, [url]);
	return (
		<div style={{ marginTop: 8 }}>
			<div className="meta" style={{ display: "flex", justifyContent: "space-between" }}>
				<span className="mono">{name}</span>
				<a href={url} target="_blank" rel="noreferrer">download ↗</a>
			</div>
			{binary ? <div className="meta">binary file — use download</div> : <pre className="log" style={{ maxHeight: 300 }}>{text ?? "loading…"}</pre>}
		</div>
	);
}

function GateRequest({ onRequest }: { onRequest: (status: string) => void }) {
	const [status, setStatus] = useState<string>("passed");
	return (
		<span style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
			<select
				value={status}
				onChange={e => setStatus(e.target.value)}
				style={{ background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 4px", fontSize: 11 }}
			>
				{GATE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
			</select>
			<button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => onRequest(status)}>request record</button>
		</span>
	);
}

function FindingDetailPanel({ campaignId, fid, onClose }: { campaignId: string; fid: string; onClose: () => void }) {
	const [f, setF] = useState<FindingDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	useEffect(() => {
		setF(null); setErr(null); setOpen(null); setMsg(null);
		api.finding(campaignId, fid).then(setF).catch(e => setErr(String(e.message ?? e)));
	}, [campaignId, fid]);

	const doRequest = (p: Promise<{ instruction: string }>) =>
		p.then(r => setMsg(`Requested — approve it in the Session tab. The agent will run the host tool (which raises an approval card). Instruction: "${r.instruction.slice(0, 140)}…"`))
			.catch(e => setMsg(`Request failed: ${String(e.message ?? e)}`));

	return (
		<div className="detail">
			<div className="pagehead" style={{ marginBottom: 10 }}>
				<button onClick={onClose}>← findings</button>
				<h1 style={{ fontSize: 15 }} className="mono">{fid}</h1>
				{f?.state === "hallucination" && (
					<button className="primary" style={{ marginLeft: "auto" }} onClick={() => doRequest(api.requestPromote(campaignId, fid))}>Request promote →</button>
				)}
			</div>
			{msg && <div className="card" style={{ marginBottom: 10, borderLeft: "3px solid var(--accent)" }}><div className="meta">{msg}</div></div>}
			{err && <div className="card err">{err}</div>}
			{!err && !f && <div className="empty">loading…</div>}
			{f && (
				<div className="card">
					<div className="kv">
						<div className="k">State</div><div>{f.state} (in <code>{f.dir}/</code>)</div>
						<div className="k">Surface</div><div className="mono">{f.surface_id ?? "—"}</div>
						<div className="k">Invariant</div><div>{f.security_invariant ?? "—"}</div>
						{f.source && <><div className="k">Source</div><div className="mono">{f.source}</div></>}
						{f.sink && <><div className="k">Sink</div><div className="mono">{f.sink}</div></>}
					</div>

					<h4 style={{ margin: "16px 0 6px" }}>Gates</h4>
					<table className="gatetable">
						<tbody>
							{(f.gates.length ? f.gates : []).map(g => (
								<tr key={g.name}>
									<td className="mono">{g.name}</td>
									<td><span className={`gate ${STATUS_CLASS[g.status]}`}>{g.status}</span></td>
									<td className="meta">{g.required ? "required" : "optional"}</td>
									<td className="meta">{g.evidence_count} file(s)</td>
									<td><GateRequest onRequest={s => doRequest(api.requestGateRecord(campaignId, fid, g.name, s))} /></td>
								</tr>
							))}
							{f.gates.length === 0 && <tr><td className="meta" colSpan={4}>no gates recorded yet (seeded not_started on the host)</td></tr>}
						</tbody>
					</table>

					<h4 style={{ margin: "16px 0 6px" }}>Evidence ({f.evidence_files.length})</h4>
					{f.evidence_files.length === 0 && <div className="meta">no evidence files on disk</div>}
					{f.evidence_files.map(ev => (
						<div key={ev.rel} className="evrow">
							<div className="evhead" onClick={() => setOpen(open === ev.rel ? null : ev.rel)}>
								<span className="mono">{ev.rel}</span>
								<span className="meta">{ev.size} B {open === ev.rel ? "▾" : "▸"}</span>
							</div>
							{open === ev.rel && <EvidencePreview url={api.evidenceUrl(campaignId, fid, ev.rel)} name={ev.name} />}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function FindingsBoard({ findings, onOpen }: { findings: FindingSummary[]; onOpen: (id: string) => void }) {
	const cols = [
		{ cls: "hall", title: "Hallucinations", state: "hallucination" },
		{ cls: "val", title: "Validated", state: "validated" },
		{ cls: "rej", title: "Rejected", state: "rejected" },
	];
	return (
		<div>
			<div className="meta" style={{ marginBottom: 12 }}>
				Read-only over projected host state — a finding leaves <code>hallucinations/</code> only via <code>finding_promote</code> on the host. The console can display and request, never fake a promotion. Click a finding for its gates &amp; evidence.
			</div>
			<div className="board">
				{cols.map(col => {
					const items = findings.filter(f => f.state === col.state);
					return (
						<div key={col.cls} className={`col ${col.cls}`}>
							<h4><span>{col.title}</span><span>{items.length}</span></h4>
							{items.length === 0 && <div className="meta">—</div>}
							{items.map(f => <FindingCard key={f.id} f={f} onOpen={() => onOpen(f.id)} />)}
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
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		setCamp(null); setErr(null); setSelected(null);
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
					<div key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => { setTab(t); setSelected(null); }}>
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
			{tab === "Findings + Gates" && (selected
				? <FindingDetailPanel campaignId={camp.id} fid={selected} onClose={() => setSelected(null)} />
				: <FindingsBoard findings={camp.findings} onOpen={setSelected} />)}
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
