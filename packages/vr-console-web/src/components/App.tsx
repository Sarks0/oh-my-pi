import { useEffect, useState } from "react";
import { api } from "../api";
import { Dashboard } from "./Dashboard";
import { CampaignView } from "./CampaignView";
import { Programmes } from "./Programmes";
import { ApprovalRecords } from "./ApprovalRecords";

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
	{ label: "HITL Session", href: "#/", hint: "open a campaign" },
];
const NAV_SYSTEM = ["LLM", "Agent", "MCP", "Skills (vr-*)", "Vault"];

export function App() {
	const hash = useHashRoute();
	const [health, setHealth] = useState<{ labRoot: string | null } | null>(null);
	useEffect(() => {
		api.health().then(setHealth).catch(() => setHealth(null));
	}, []);

	const campaignMatch = hash.match(/^#\/campaign\/(.+)$/);

	return (
		<div className="app">
			<nav className="sidebar">
				<div className="brand">VR <span>Console</span></div>
				<div className="navgroup">Functions</div>
				{NAV_FUNCTIONS.map((n, i) => (
					<a key={i} className={`navitem${hash === "#/" && n.label === "Dashboard" ? " active" : ""}`} href={n.href}>
						{n.label}
					</a>
				))}
				<div className="navgroup">System</div>
				{NAV_SYSTEM.map((n, i) => (
					<span key={i} className="navitem" title="Phase 2+: not yet wired">{n}</span>
				))}
				<a className={`navitem${hash === "#/approvals" ? " active" : ""}`} href="#/approvals">Approval Records</a>
				<a className={`navitem${hash === "#/programmes" ? " active" : ""}`} href="#/programmes">Scope + Programmes</a>
				<div style={{ padding: "16px 8px", fontSize: 11, color: "var(--faint)" }} className="mono">
					labRoot: {health?.labRoot ?? "(unset)"}
				</div>
			</nav>
			<main className="main">
				{hash === "#/programmes" ? <Programmes /> : hash === "#/approvals" ? <ApprovalRecords /> : campaignMatch ? <CampaignView id={decodeURIComponent(campaignMatch[1])} /> : <Dashboard />}
			</main>
		</div>
	);
}
