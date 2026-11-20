import type { ApprovalRecord, CampaignDetail, CampaignSummary, CoverageGraph, FindingDetail, McpInfo, ModelsInfo, Programme, SessionInfo, SessionListItem, SessionMeta, SkillsInfo, SwitchResult, WsFrame } from "./types";

// Per-launch bearer token. The server prints a launch URL with ?token=…; we read
// it once, keep it, and strip it from the address bar so it is not left on screen.
// It then rides every request (Authorization header) and the WS + asset URLs (query).
const TOKEN = (() => {
	try {
		const u = new URL(location.href);
		const fromUrl = u.searchParams.get("token");
		if (fromUrl) {
			try { localStorage.setItem("vrc.token", fromUrl); } catch { /* private mode */ }
			u.searchParams.delete("token");
			history.replaceState(null, "", u.pathname + u.search + u.hash);
			return fromUrl;
		}
		try { return localStorage.getItem("vrc.token") ?? ""; } catch { return ""; }
	} catch {
		return "";
	}
})();

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return { ...(extra ?? {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
}
/** `&token=…` (or empty) for URLs used as a WS endpoint or an asset src, where no header rides. */
function tokenParam(): string {
	return TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";
}

async function getJson<T>(path: string): Promise<T> {
	const r = await fetch(path, { headers: authHeaders() });
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
	return body as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, {
		method: "POST",
		headers: authHeaders({ "content-type": "application/json" }),
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
	return d as T;
}

async function delJson<T>(path: string): Promise<T> {
	const r = await fetch(path, { method: "DELETE", headers: authHeaders() });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
	return d as T;
}

interface RequestResult { requested: boolean; instruction: string }
const enc = encodeURIComponent;

export const api = {
	health: () => getJson<{ ok: boolean; cwd: string; labRoot: string | null }>("/api/health"),
	campaigns: (scope: "active" | "archived" | "all" = "all") => getJson<CampaignSummary[]>(`/api/campaigns?scope=${scope}`),
	campaign: (id: string) => getJson<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`),
	graph: (id: string) => getJson<CoverageGraph>(`/api/campaigns/${encodeURIComponent(id)}/graph`),
	finding: (campaignId: string, fid: string) =>
		getJson<FindingDetail>(`/api/campaigns/${encodeURIComponent(campaignId)}/findings/${encodeURIComponent(fid)}`),
	evidenceUrl: (campaignId: string, fid: string, rel: string) =>
		`/api/campaigns/${encodeURIComponent(campaignId)}/findings/${encodeURIComponent(fid)}/file?path=${encodeURIComponent(rel)}${tokenParam()}`,
	programmes: () => getJson<Programme[]>("/api/programmes"),
	approvals: () => getJson<ApprovalRecord[] | { enabled: false }>("/api/approvals"),
	requestPromote: (campaignId: string, fid: string) =>
		postJson<RequestResult>(`/api/campaigns/${enc(campaignId)}/findings/${enc(fid)}/request-promote`),
	requestGateRecord: (campaignId: string, fid: string, gate: string, status: string) =>
		postJson<RequestResult>(`/api/campaigns/${enc(campaignId)}/findings/${enc(fid)}/gates/${enc(gate)}/request-record`, { status }),
	// omp operational panels
	session: () => getJson<SessionInfo>("/api/session"),
	mcp: () => getJson<McpInfo>("/api/mcp"),
	skills: () => getJson<SkillsInfo>("/api/skills"),
	models: () => getJson<ModelsInfo>("/api/models"),
	setModel: (provider: string, id: string) => postJson<SwitchResult>("/api/model", { provider, id }),
	// multi-session
	sessions: () => getJson<SessionListItem[]>("/api/sessions"),
	createSession: (cwd?: string, title?: string) => postJson<SessionMeta>("/api/sessions", { cwd, title }),
	deleteSession: (id: string) => delJson<{ disposed: boolean }>(`/api/sessions/${enc(id)}`),
};

export interface WsHandle {
	send: (obj: unknown) => void;
	close: () => void;
}

/** Reconnecting WebSocket to vr-console-server, bound to one session. */
export function connectWs(sessionId: string, onFrame: (f: WsFrame) => void, onStatus: (connected: boolean) => void): WsHandle {
	let ws: WebSocket | undefined;
	let closed = false;
	const open = () => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sessionId)}${tokenParam()}`);
		ws.onopen = () => onStatus(true);
		ws.onmessage = e => {
			try {
				onFrame(JSON.parse(String(e.data)));
			} catch {
				/* ignore */
			}
		};
		ws.onclose = () => {
			onStatus(false);
			if (!closed) setTimeout(open, 1500);
		};
	};
	open();
	return {
		send: obj => {
			try {
				if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
			} catch {
				/* ignore */
			}
		},
		close: () => {
			closed = true;
			ws?.close();
		},
	};
}
