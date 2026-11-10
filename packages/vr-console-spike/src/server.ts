/**
 * vr-console-spike server (Bun).
 *
 * Serves a single debug page and a /ws WebSocket, and bridges the browser to
 * one in-process omp agent session. This is the "transport omp doesn't ship" —
 * the only genuinely new code the spike needs. It is intentionally one session
 * for all clients.
 *
 * Run:
 *   bun run packages/vr-console-spike/src/server.ts
 * Env:
 *   PORT          (default 8799)
 *   VR_SPIKE_CWD  working dir for the agent session; point at a vr-lab campaign
 *                 dir on the Kali host for the real-MCP test (default: cwd)
 */
import { join } from "node:path";
import { type Bridge, startBridge } from "./omp-bridge";

const PORT = Number(process.env.PORT ?? 8799);
const CWD = process.env.VR_SPIKE_CWD ?? process.cwd();
const INDEX_HTML = join(import.meta.dir, "..", "public", "index.html");

const sockets = new Set<Bun.ServerWebSocket<unknown>>();

function broadcast(frame: unknown): void {
	const text = JSON.stringify(frame);
	for (const ws of sockets) ws.send(text);
}

// Lazily create the single shared agent session on the first client.
let bridge: Bridge | undefined;
let bridgePromise: Promise<Bridge> | undefined;
function ensureBridge(): Promise<Bridge> {
	if (!bridgePromise) {
		bridgePromise = startBridge(CWD, broadcast).then(b => (bridge = b));
	}
	return bridgePromise;
}

const server = Bun.serve({
	port: PORT,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req)) return;
			return new Response("websocket upgrade failed", { status: 400 });
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(Bun.file(INDEX_HTML), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sockets.add(ws);
			ws.send(JSON.stringify({ type: "notice", level: "info", message: `connected; cwd=${CWD}` }));
			ensureBridge().catch(err =>
				ws.send(JSON.stringify({ type: "notice", level: "error", message: `bridge failed: ${String(err)}` })),
			);
		},
		close(ws) {
			sockets.delete(ws);
		},
		async message(ws, raw) {
			let msg: { type?: string; text?: string };
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (msg?.type === "prompt" && typeof msg.text === "string") {
				try {
					const b = await ensureBridge();
					await b.prompt(msg.text);
				} catch (err) {
					ws.send(JSON.stringify({ type: "notice", level: "error", message: `prompt failed: ${String(err)}` }));
				}
			}
			// Phase 1: handle { type: "approve", id, decision } here, wired to the
			// approval seam (setToolUIContext / request_permission).
		},
	},
});

console.log(`[vr-console-spike] http://localhost:${server.port}  (cwd=${CWD})`);

async function shutdown(): Promise<void> {
	try {
		await bridge?.dispose();
	} finally {
		process.exit(0);
	}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
