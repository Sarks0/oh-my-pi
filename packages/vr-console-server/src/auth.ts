/**
 * Auth guard for the console's HTTP + WebSocket surface.
 *
 * The console drives a live agent on the research host: a tool call can run
 * lab-mcp, Proxmox, fuzzers, or promote a finding, and an approval reply resolves
 * the human gate. None of that may be reachable by another local process or, worse,
 * by a web page the operator happens to visit. Two defenses, both required:
 *
 *  1. A per-launch bearer token (printed once at startup, carried in the launch URL).
 *     Required on every /api/* request, the /ws upgrade, and /debug. A cross-site
 *     page cannot read it, so it cannot drive the agent or approve a card (CSWSH).
 *  2. An Origin/Host loopback check. A browser always sends Origin on a cross-site
 *     WebSocket or fetch; a foreign Origin is rejected outright, and a non-loopback
 *     Host is rejected to blunt DNS-rebinding. Non-browser clients (curl) send no
 *     Origin and are gated by the token alone.
 *
 * The static SPA shell is served without the token (it is app code, no data); it
 * reads the token from the launch URL and presents it on every call.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** The host portion of an Origin URL or a Host header, or null if absent/unparseable. */
export function hostname(value: string | null | undefined): string | null {
	if (!value) return null;
	const v = value.trim();
	if (!v || v === "null") return null;
	if (v.includes("://")) {
		try {
			return new URL(v).hostname.replace(/^\[|\]$/g, "");
		} catch {
			return null;
		}
	}
	const ipv6 = v.match(/^\[([^\]]+)\]/);
	if (ipv6) return ipv6[1];
	return v.replace(/:\d+$/, "");
}

export function isLoopbackHost(host: string | null): boolean {
	return host !== null && LOOPBACK_HOSTS.has(host);
}

/** A fresh, unguessable per-launch token. */
export function makeToken(): string {
	return randomBytes(24).toString("base64url");
}

/** Constant-time string compare (length mismatch short-circuits, as it must). */
export function tokenEquals(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/** The token on a request: `Authorization: Bearer <t>` or a `?token=` query param. */
export function tokenFromRequest(req: Request, url: URL): string | null {
	const auth = req.headers.get("authorization");
	if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
	return url.searchParams.get("token");
}

export interface AuthDenial {
	status: number;
	message: string;
}

/**
 * Guard a request. Returns null when it may proceed, else a denial:
 *   403 for a foreign Origin or non-loopback Host, 401 for a missing/invalid token.
 * Order matters: a cross-site caller is refused on Origin before the token is even
 * inspected, so a wrong guess never reveals timing about the token's length.
 */
export function checkAuth(req: Request, url: URL, token: string): AuthDenial | null {
	const origin = req.headers.get("origin");
	if (origin !== null && !isLoopbackHost(hostname(origin))) return { status: 403, message: "forbidden origin" };
	const host = hostname(req.headers.get("host"));
	if (host !== null && !isLoopbackHost(host)) return { status: 403, message: "forbidden host" };
	const provided = tokenFromRequest(req, url);
	if (!provided || !tokenEquals(provided, token)) return { status: 401, message: "missing or invalid token" };
	return null;
}
