import type { CampaignDetail, CampaignSummary, WsFrame } from "./types";

async function getJson<T>(path: string): Promise<T> {
	const r = await fetch(path);
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
	return body as T;
}

export const api = {
	health: () => getJson<{ ok: boolean; cwd: string; labRoot: string | null }>("/api/health"),
	campaigns: (scope: "active" | "archived" | "all" = "all") => getJson<CampaignSummary[]>(`/api/campaigns?scope=${scope}`),
	campaign: (id: string) => getJson<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`),
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
