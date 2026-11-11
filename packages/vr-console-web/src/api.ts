import type { ApprovalRecord, CampaignDetail, CampaignSummary, FindingDetail, Programme, WsFrame } from "./types";

async function getJson<T>(path: string): Promise<T> {
	const r = await fetch(path);
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
	return body as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
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
	finding: (campaignId: string, fid: string) =>
		getJson<FindingDetail>(`/api/campaigns/${encodeURIComponent(campaignId)}/findings/${encodeURIComponent(fid)}`),
	evidenceUrl: (campaignId: string, fid: string, rel: string) =>
		`/api/campaigns/${encodeURIComponent(campaignId)}/findings/${encodeURIComponent(fid)}/file?path=${encodeURIComponent(rel)}`,
	programmes: () => getJson<Programme[]>("/api/programmes"),
	approvals: () => getJson<ApprovalRecord[] | { enabled: false }>("/api/approvals"),
	requestPromote: (campaignId: string, fid: string) =>
		postJson<RequestResult>(`/api/campaigns/${enc(campaignId)}/findings/${enc(fid)}/request-promote`),
	requestGateRecord: (campaignId: string, fid: string, gate: string, status: string) =>
		postJson<RequestResult>(`/api/campaigns/${enc(campaignId)}/findings/${enc(fid)}/gates/${enc(gate)}/request-record`, { status }),
};

export interface WsHandle {
	send: (obj: unknown) => void;
	close: () => void;
}

/** Reconnecting WebSocket to vr-console-server. */
export function connectWs(onFrame: (f: WsFrame) => void, onStatus: (connected: boolean) => void): WsHandle {
	let ws: WebSocket | undefined;
	let closed = false;
	const open = () => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		ws = new WebSocket(`${proto}://${location.host}/ws`);
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
