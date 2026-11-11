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
import { getCampaign, getFinding, listCampaigns, resolveEvidenceFile } from "./campaign/reader";
import { listProgrammes } from "./programmes/reader";
import { type Db, makeDb, migrate } from "./db/client";
import { syncCampaigns } from "./db/projection";
import { costSummary, recentUsage, recordUsage, usageFromEvent } from "./cost/ledger";

const PORT = Number(process.env.PORT ?? 8800);
const CWD = process.env.VR_CONSOLE_CWD ?? process.cwd();
const LAB_ROOT = (process.env.VR_LAB_ROOT ?? "").trim();
const DB_URL = (process.env.DATABASE_URL ?? "").trim();

// Optional Postgres: when DATABASE_URL is set, migrate + enable the cost ledger and
// projection. Without it the console runs on FS reads alone.
let db: Db | undefined;
if (DB_URL) {
	db = makeDb(DB_URL);
	await migrate(db);
	console.log("[vr-console-server] Postgres connected; cost ledger + projection enabled");
}

/** Campaign id if CWD is a campaign dir (…/campaigns/{active,archived}/<id>[/…]). */
function campaignIdFromCwd(cwd: string): string | undefined {
	return cwd.match(/\/campaigns\/(?:active|archived)\/([^/]+)/)?.[1];
}
const DEBUG_HTML = join(import.meta.dir, "..", "public", "index.html");
// Built vr-console-web SPA (the real UI). Falls back to the debug page if unbuilt.
const WEB_DIST = process.env.VR_CONSOLE_WEB_DIST ?? join(import.meta.dir, "..", "..", "vr-console-web", "dist");

/** Serve a file from the web dist, guarding against path escape. Returns undefined if absent. */
async function serveWeb(pathname: string): Promise<Response | undefined> {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	if (rel.includes("..")) return undefined;
	const file = Bun.file(join(WEB_DIST, rel));
	if (await file.exists()) return new Response(file);
	// SPA fallback: unknown non-asset path → index.html (client router handles it)
	if (!rel.includes(".")) {
		const idx = Bun.file(join(WEB_DIST, "index.html"));
		if (await idx.exists()) return new Response(idx, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	return undefined;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function requireLabRoot(): string {
	if (!LAB_ROOT) throw new Error("VR_LAB_ROOT is not set — point it at the vr-lab checkout");
	return LAB_ROOT;
}

/** Read-only campaign REST API (DESIGN §3/§5 — host FS is truth; never writes). */
async function handleApi(url: URL): Promise<Response | undefined> {
	if (url.pathname === "/api/health") {
		return json({ ok: true, cwd: CWD, labRoot: LAB_ROOT || null, db: !!db });
	}
	if (url.pathname === "/api/cost") {
		return json(db ? await costSummary(db) : { enabled: false });
	}
	if (url.pathname === "/api/cost/recent") {
		return json(db ? await recentUsage(db, 50) : []);
	}
	if (url.pathname === "/api/projection/sync") {
		if (!db) return json({ enabled: false });
		return json(await syncCampaigns(db, requireLabRoot()));
	}
	if (url.pathname === "/api/campaigns") {
		const scope = (url.searchParams.get("scope") as "active" | "archived" | "all") ?? "active";
		return json(await listCampaigns(requireLabRoot(), scope));
	}
	if (url.pathname === "/api/programmes") {
		return json(await listProgrammes(requireLabRoot()));
	}
	// evidence file (read-only, path-guarded) — must precede the finding-detail route
	const fileM = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/findings\/([^/]+)\/file$/);
	if (fileM) {
		const abs = await resolveEvidenceFile(requireLabRoot(), decodeURIComponent(fileM[1]), decodeURIComponent(fileM[2]), url.searchParams.get("path") ?? "");
		if (!abs) return json({ error: "evidence file not found" }, 404);
		return new Response(Bun.file(abs)); // Bun infers content-type; text previews in the browser
	}
	// finding detail (gates + evidence listing)
	const fdM = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/findings\/([^/]+)$/);
	if (fdM) {
		const f = await getFinding(requireLabRoot(), decodeURIComponent(fdM[1]), decodeURIComponent(fdM[2]));
		if (!f) return json({ error: "finding not found" }, 404);
		return json(f);
	}
	const m = url.pathname.match(/^\/api\/campaigns\/([^/]+?)(\/findings)?$/);
	if (m) {
		const camp = await getCampaign(requireLabRoot(), decodeURIComponent(m[1]));
		if (!camp) return json({ error: "campaign not found" }, 404);
		return json(m[2] ? camp.findings : camp);
	}
	return undefined;
}

const sockets = new Set<Bun.ServerWebSocket<unknown>>();
function broadcast(frame: unknown): void {
	const text = JSON.stringify(frame);
	for (const ws of sockets) ws.send(text);
}

// One shared adapter/session, created lazily on first client. When a DB is
// configured, tap the raw event stream to append the cost ledger at message_end.
const adapter = new OmpSessionAdapter(broadcast, {
	onRawEvent: db
		? ev => {
				const row = usageFromEvent(ev, { cwd: CWD, campaignId: campaignIdFromCwd(CWD) });
				if (row) recordUsage(db!, row).catch(() => {});
			}
		: undefined,
});
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
		if (url.pathname.startsWith("/api/")) {
			try {
				const res = await handleApi(url);
				if (res) return res;
			} catch (err) {
				return json({ error: String(err) }, err instanceof Error && /VR_LAB_ROOT/.test(err.message) ? 400 : 500);
			}
		}
		const web = await serveWeb(url.pathname);
		if (web) return web;
		if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/debug") {
			return new Response(Bun.file(DEBUG_HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
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
