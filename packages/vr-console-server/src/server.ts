/**
 * vr-console-server (Bun) — HTTP + WebSocket transport around one omp session via
 * the OmpSessionAdapter. Phase 1 Increment 1: live event stream + real approval
 * cards (no autoApprove).
 *
 * WS protocol:
 *   inbound  { type:"prompt", text }              -> adapter.prompt(text)
 *            { type:"reply",  id, value }          -> resolve a pending UI request
 *                                                     (value: approval answer / select / confirm / input)
 *   outbound shaped AgentSessionEvent frames (event-shape.ts)
 *            { type:"approval_request", id, full, compact, session?, grants? }
 *            { type:"select_request"|"confirm_request"|"input_request", id, ... }
 *            { type:"notice", level, message }
 *
 * Run:  bun run packages/vr-console-server/src/server.ts
 * Env:  PORT (8800)   VR_CONSOLE_CWD (session cwd; a vr-lab campaign dir on the host)
 */
import { join } from "node:path";
import { OmpSessionAdapter } from "./adapter/omp-session-adapter";

const PORT = Number(process.env.PORT ?? 8800);
const CWD = process.env.VR_CONSOLE_CWD ?? process.cwd();
const INDEX_HTML = join(import.meta.dir, "..", "public", "index.html");

const sockets = new Set<Bun.ServerWebSocket<unknown>>();
function broadcast(frame: unknown): void {
	const text = JSON.stringify(frame);
	for (const ws of sockets) ws.send(text);
}

// One shared adapter/session, created lazily on first client.
const adapter = new OmpSessionAdapter(broadcast);
let startPromise: Promise<void> | undefined;
function ensureStarted(): Promise<void> {
	if (!startPromise) startPromise = adapter.start(CWD);
	return startPromise;
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
			return new Response(Bun.file(INDEX_HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sockets.add(ws);
			ws.send(JSON.stringify({ type: "notice", level: "info", message: `connected; cwd=${CWD}` }));
			ensureStarted().catch(err =>
				ws.send(JSON.stringify({ type: "notice", level: "error", message: `session start failed: ${String(err)}` })),
			);
		},
		close(ws) {
			sockets.delete(ws);
		},
		async message(ws, raw) {
			let msg: { type?: string; text?: string; id?: string; value?: unknown };
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (msg?.type === "prompt" && typeof msg.text === "string") {
				try {
					await ensureStarted();
					await adapter.prompt(msg.text);
				} catch (err) {
					ws.send(JSON.stringify({ type: "notice", level: "error", message: `prompt failed: ${String(err)}` }));
				}
			} else if (msg?.type === "reply" && typeof msg.id === "string") {
				const ok = adapter.resolveReply(msg.id, msg.value);
				if (!ok) ws.send(JSON.stringify({ type: "notice", level: "warn", message: `stale/unknown reply id ${msg.id}` }));
			}
		},
	},
});

console.log(`[vr-console-server] http://localhost:${server.port}  (cwd=${CWD})`);

async function shutdown(): Promise<void> {
	try {
		await adapter.dispose();
	} finally {
		process.exit(0);
	}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
