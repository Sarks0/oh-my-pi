import { useEffect, useState } from "react";
import { api } from "../api";
import { Dashboard } from "./Dashboard";
import { CampaignView } from "./CampaignView";
import { Programmes } from "./Programmes";
import { ApprovalRecords } from "./ApprovalRecords";
import { SessionPanel } from "./SessionPanel";
import { Agent } from "./Agent";
import { Mcp } from "./Mcp";
import { Skills } from "./Skills";
import { Llm } from "./Llm";
import { Sessions } from "./Sessions";
import { Tasks } from "./Tasks";
import { TaskView } from "./TaskView";
import type { SessionListItem } from "../types";

function SessionPage({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	useEffect(() => {
		api.sessions().then(setSessions).catch(() => setSessions([]));
	}, [activeId]);
	const active = sessions.find(s => s.id === activeId);
	return (
		<div>
			<div className="pagehead">
				<h1>HITL Session</h1>
				<span className="sub">the live agent session — prompt it, watch tool calls, approve/deny inline</span>
				<label className="meta" style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
					session
					<select value={activeId} onChange={e => onSelect(e.target.value)}>
						{sessions.length === 0 && <option value={activeId}>{activeId}</option>}
						{sessions.map(s => <option key={s.id} value={s.id}>{s.title}{s.id === "default" ? " (default)" : ""}</option>)}
					</select>
				</label>
			</div>
			{active && <div className="meta mono" style={{ marginBottom: 8, fontSize: 11 }}>cwd: {active.cwd}{active.model ? ` · ${active.model}` : ""}</div>}
			{/* key forces a fresh panel (and WS) when the session changes */}
			<SessionPanel key={activeId} sessionId={activeId} />
		</div>
	);
}

/** Minimal hash router: #/ , #/campaign/<id> */
function useHashRoute(): string {
	const [hash, setHash] = useState(() => location.hash || "#/");
	useEffect(() => {
		const on = () => setHash(location.hash || "#/");
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	return hash;
}

const NAV_FUNCTIONS = [
	{ label: "Dashboard", href: "#/" },
	{ label: "Campaigns", href: "#/" },
	{ label: "Findings + Gates", href: "#/", hint: "open a campaign" },
	{ label: "Surface Graph", href: "#/", hint: "open a campaign" },
	{ label: "HITL Session", href: "#/session" },
	{ label: "Sessions", href: "#/sessions" },
	{ label: "Tasks", href: "#/tasks" },
];
const NAV_SYSTEM: { label: string; href?: string }[] = [
	{ label: "LLM", href: "#/llm" },
	{ label: "Agent", href: "#/agent" },
	{ label: "MCP", href: "#/mcp" },
	{ label: "Skills", href: "#/skills" },
	{ label: "Vault" },
];

export function App() {
	const hash = useHashRoute();
	const [health, setHealth] = useState<{ labRoot: string | null } | null>(null);
	const [activeSession, setActiveSession] = useState<string>(() => {
		try { return localStorage.getItem("vrc.session") || "default"; } catch { return "default"; }
	});
	const selectSession = (id: string) => {
		setActiveSession(id);
		try { localStorage.setItem("vrc.session", id); } catch { /* private mode */ }
	};
	const openSession = (id: string) => {
		selectSession(id);
		location.hash = "#/session";
	};
	useEffect(() => {
		api.health().then(setHealth).catch(() => setHealth(null));
	}, []);

	const campaignMatch = hash.match(/^#\/campaign\/(.+)$/);
	const taskMatch = hash.match(/^#\/task\/(\d+)$/);

	return (
		<div className="app">
			<nav className="sidebar">
				<div className="brand">VR <span>Console</span></div>
				<div className="navgroup">Functions</div>
				{NAV_FUNCTIONS.map((n, i) => {
					const active = (n.label === "Dashboard" && hash === "#/") || (n.href !== "#/" && hash === n.href);
					return (
						<a key={i} className={`navitem${active ? " active" : ""}`} href={n.href}>
							{n.label}
						</a>
					);
				})}
				<div className="navgroup">System</div>
				{NAV_SYSTEM.map((n, i) =>
					n.href ? (
						<a key={i} className={`navitem${hash === n.href ? " active" : ""}`} href={n.href}>{n.label}</a>
					) : (
						<span key={i} className="navitem" title="Phase B2: not yet wired">{n.label}</span>
					),
				)}
				<a className={`navitem${hash === "#/approvals" ? " active" : ""}`} href="#/approvals">Approval Records</a>
				<a className={`navitem${hash === "#/programmes" ? " active" : ""}`} href="#/programmes">Scope + Programmes</a>
				<div style={{ padding: "16px 8px", fontSize: 11, color: "var(--faint)" }} className="mono">
					labRoot: {health?.labRoot ?? "(unset)"}
				</div>
			</nav>
			<main className="main">
				{hash === "#/programmes" ? <Programmes /> : hash === "#/approvals" ? <ApprovalRecords /> : hash === "#/session" ? <SessionPage activeId={activeSession} onSelect={selectSession} /> : hash === "#/sessions" ? <Sessions activeId={activeSession} onOpen={openSession} /> : hash === "#/tasks" ? <Tasks onOpen={id => { location.hash = `#/task/${id}`; }} /> : taskMatch ? <TaskView id={Number(taskMatch[1])} onBack={() => { location.hash = "#/tasks"; }} /> : hash === "#/agent" ? <Agent /> : hash === "#/mcp" ? <Mcp /> : hash === "#/skills" ? <Skills /> : hash === "#/llm" ? <Llm /> : campaignMatch ? <CampaignView id={decodeURIComponent(campaignMatch[1])} /> : <Dashboard />}
			</main>
		</div>
	);
}
