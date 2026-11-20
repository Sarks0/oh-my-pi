/**
 * vr-console-server (Bun) — HTTP + WebSocket transport over a SessionRegistry of
 * omp sessions. A "default" session is created from VR_CONSOLE_CWD at boot so the
 * VR domain panels and every unscoped route keep working; more sessions are made
 * on demand (POST /api/sessions) and addressed under /api/sessions/:id/*.
 *
 * WS protocol ( /ws?session=<id> — defaults to the "default" session ):
 *   inbound  { type:"prompt", text }              -> that session's prompt
 *            { type:"reply",  id, value }          -> resolve a pending UI request
 *                                                     (value: approval answer / select / confirm / input)
 *   outbound shaped AgentSessionEvent frames (event-shape.ts), scoped to the
 *            session the socket is bound to (and replayed from history on connect)
 *            { type:"approval_request", id, full, compact, session?, grants? }
 *            { type:"select_request"|"confirm_request"|"input_request", id, ... }
 *            { type:"notice", level, message }
 *
 * Run:  bun run packages/vr-console-server/src/server.ts
 * Env:  PORT (8800)   VR_CONSOLE_CWD (the default session's cwd; a vr-lab campaign dir)
 */
import { join } from "node:path";
import { discoverSkills } from "@oh-my-pi/pi-coding-agent";
import { SessionRegistry } from "./session/registry";
import { buildCoverageGraph, getCampaign, getFinding, listCampaigns, resolveEvidenceFile } from "./campaign/reader";
import { composeGateRecordRequest, composePromoteRequest } from "./campaign/requests";
import { listProgrammes } from "./programmes/reader";
import { type Db, makeDb, migrate } from "./db/client";
import { syncCampaigns } from "./db/projection";
import { costSummary, recentUsage } from "./cost/ledger";
import { listApprovalRecords } from "./approval/audit";

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

/** Skills for a cwd — a pure FS/settings read, so no running session is needed. */
async function readSkills(cwd: string): Promise<{ skills: Array<{ name: string; description: string }>; warnings: string[] }> {
	const { skills, warnings } = await discoverSkills(cwd);
	return {
		skills: skills.map((s: { name: string; description?: string }) => ({ name: s.name, description: s.description ?? "" })),
		warnings: Array.isArray(warnings) ? warnings.map((w: unknown) => String((w as { message?: string })?.message ?? w)) : [],
	};
}

/** Read-only campaign REST API (DESIGN §3/§5 — host FS is truth; never writes). */
async function handleApi(url: URL, method: string): Promise<Response | undefined> {
	if (url.pathname === "/api/health") {
		return json({ ok: true, cwd: CWD, labRoot: LAB_ROOT || null, db: !!db });
	}
	// --- omp operational panels (general cockpit, not VR-specific) ---
	// The unscoped routes target the DEFAULT session (back-compat); the session
	// list and the /api/sessions/:id/* routes below are the multi-session surface.
	if (url.pathname === "/api/sessions") {
		return json(registry.list());
	}
	const sm = matchSession(url.pathname);
	if (sm && method === "GET") {
		if (!registry.has(sm.id)) return json({ error: `no such session: ${sm.id}` }, 404);
		if (sm.rest === "session") {
			await registry.ensureStarted(sm.id);
			return json(registry.adapter(sm.id)!.sessionInfo());
		}
		if (sm.rest === "mcp") {
			await registry.ensureStarted(sm.id);
			return json(registry.adapter(sm.id)!.mcpInfo());
		}
		if (sm.rest === "models") {
			await registry.ensureStarted(sm.id);
			return json(registry.adapter(sm.id)!.listModels());
		}
		if (sm.rest === "skills") {
			return json(await readSkills(registry.meta(sm.id)!.cwd));
		}
	}
	if (url.pathname === "/api/session") {
		await ensureStarted();
		return json(defaultAdapter().sessionInfo());
	}
	if (url.pathname === "/api/mcp") {
		await ensureStarted();
		return json(defaultAdapter().mcpInfo());
	}
	if (url.pathname === "/api/models") {
		await ensureStarted();
		return json(defaultAdapter().listModels());
	}
	if (url.pathname === "/api/skills") {
		return json(await readSkills(CWD));
	}
	if (url.pathname === "/api/cost") {
		return json(db ? await costSummary(db) : { enabled: false });
	}
	if (url.pathname === "/api/cost/recent") {
		return json(db ? await recentUsage(db, 50) : []);
	}
	if (url.pathname === "/api/approvals") {
		return json(db ? await listApprovalRecords(db, 100) : { enabled: false });
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
	// coverage/surface graph
	const graphM = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/graph$/);
	if (graphM) {
		return json(await buildCoverageGraph(requireLabRoot(), decodeURIComponent(graphM[1])));
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

// Many sessions behind one server. The "default" session is created from
// VR_CONSOLE_CWD at boot so every existing route and the VR domain panels keep
// targeting it; additional sessions are created on demand via /api/sessions.
const DEFAULT_ID = "default";
const registry = new SessionRegistry({ db });
registry.create({ id: DEFAULT_ID, cwd: CWD, title: campaignIdFromCwd(CWD) ?? "primary" });

/** The default session's adapter — the target of the back-compat (unscoped) routes. */
function defaultAdapter() {
	const a = registry.adapter(DEFAULT_ID);
	if (!a) throw new Error("default session missing");
	return a;
}
/** Start the default session (back-compat `ensureStarted()` with no id). */
function ensureStarted(): Promise<void> {
	return registry.ensureStarted(DEFAULT_ID);
}

/** Resolve a session route `/api/sessions/:id/<rest>` → { id, rest } or undefined. */
function matchSession(pathname: string): { id: string; rest: string } | undefined {
	const m = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
	if (!m) return undefined;
	return { id: decodeURIComponent(m[1]), rest: m[2] ?? "" };
}

/**
 * Operator action REQUESTS (DESIGN §4.3): POST routes that compose an instruction and
 * forward it to the agent as a session.prompt. They do NOT write campaign/gate state —
 * the agent calls the host campaign-mcp tool, which is a mutation and raises an approval
 * card first. The response echoes the composed instruction; the work streams to the WS.
 */
async function handleApiWrite(url: URL, req: Request): Promise<Response | undefined> {
	// --- multi-session lifecycle ---
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { cwd?: string; title?: string };
		const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : CWD;
		const meta = registry.create({ cwd, title: body.title });
		return json(meta, 201);
	}
	const sm = matchSession(url.pathname);
	if (sm) {
		if (!registry.has(sm.id)) return json({ error: `no such session: ${sm.id}` }, 404);
		// Switch a session's model (operator control, not an agent tool — no approval gate).
		if (sm.rest === "model" && req.method === "POST") {
			const body = (await req.json().catch(() => ({}))) as { provider?: string; id?: string };
			if (typeof body.provider !== "string" || typeof body.id !== "string") return json({ error: "provider and id are required" }, 400);
			await registry.ensureStarted(sm.id);
			const result = await registry.adapter(sm.id)!.setModelByRef(body.provider, body.id);
			return json(result, result.error ? 409 : 200);
		}
		if (sm.rest === "" && req.method === "DELETE") {
			if (sm.id === DEFAULT_ID) return json({ error: "the default session cannot be disposed" }, 400);
			await registry.dispose(sm.id);
			return json({ disposed: true });
		}
	}

	// --- back-compat (default session) model switch ---
	if (url.pathname === "/api/model" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { provider?: string; id?: string };
		if (typeof body.provider !== "string" || typeof body.id !== "string") return json({ error: "provider and id are required" }, 400);
		await ensureStarted();
		const result = await defaultAdapter().setModelByRef(body.provider, body.id);
		return json(result, result.error ? 409 : 200);
	}

	// --- VR operator action requests (target the default/VR session) ---
	const promoteM = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/findings\/([^/]+)\/request-promote$/);
	if (promoteM) {
		const instruction = composePromoteRequest(decodeURIComponent(promoteM[1]), decodeURIComponent(promoteM[2]));
		await ensureStarted();
		defaultAdapter().prompt(instruction).catch(() => {}); // fire; the turn (and its approval card) stream to the WS
		return json({ requested: true, instruction });
	}
	const gateM = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/findings\/([^/]+)\/gates\/([^/]+)\/request-record$/);
	if (gateM) {
		const body = (await req.json().catch(() => ({}))) as { status?: string };
		const status = typeof body.status === "string" ? body.status : "passed";
		const instruction = composeGateRecordRequest(decodeURIComponent(gateM[1]), decodeURIComponent(gateM[2]), decodeURIComponent(gateM[3]), status);
		await ensureStarted();
		defaultAdapter().prompt(instruction).catch(() => {});
		return json({ requested: true, instruction });
	}
	return undefined;
}

/** Per-socket data: which session this WebSocket is bound to (set at upgrade). */
interface WsData {
	sessionId: string;
}

const server = Bun.serve<WsData>({
	port: PORT,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			// A socket is bound to one session for its lifetime (chosen at connect time).
			const sessionId = url.searchParams.get("session") || DEFAULT_ID;
			if (srv.upgrade(req, { data: { sessionId } })) return;
			return new Response("websocket upgrade failed", { status: 400 });
		}
		if (url.pathname.startsWith("/api/")) {
			try {
				if (req.method === "POST" || req.method === "DELETE") {
					const written = await handleApiWrite(url, req);
					if (written) return written;
				}
				const res = await handleApi(url, req.method);
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
			const { sessionId } = ws.data;
			if (!registry.attach(sessionId, ws)) {
				ws.send(JSON.stringify({ type: "notice", level: "error", message: `no such session: ${sessionId}` }));
				ws.close();
				return;
			}
			const meta = registry.meta(sessionId);
			ws.send(JSON.stringify({ type: "notice", level: "info", message: `connected; session=${sessionId} cwd=${meta?.cwd ?? "?"}` }));
			registry.ensureStarted(sessionId).catch(err =>
				ws.send(JSON.stringify({ type: "notice", level: "error", message: `session start failed: ${String(err)}` })),
			);
		},
		close(ws) {
			registry.detach(ws);
		},
		async message(ws, raw) {
			let msg: { type?: string; text?: string; id?: string; value?: unknown };
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			const { sessionId } = ws.data;
			const adapter = registry.adapter(sessionId);
			if (!adapter) {
				ws.send(JSON.stringify({ type: "notice", level: "error", message: `session ${sessionId} is gone` }));
				return;
			}
			if (msg?.type === "prompt" && typeof msg.text === "string") {
				try {
					await registry.ensureStarted(sessionId);
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

console.log(`[vr-console-server] http://localhost:${server.port}  (default cwd=${CWD})`);

async function shutdown(): Promise<void> {
	try {
		await registry.disposeAll();
	} finally {
		process.exit(0);
	}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
