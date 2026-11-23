import { describe, expect, test } from "bun:test";
import { checkAuth, hostname, isLoopbackHost, makeToken, tokenEquals } from "./auth";

const TOKEN = "s3cr3t-launch-token";
const req = (headers: Record<string, string>, pathWithQuery = "/api/health") =>
	({ req: new Request(`http://127.0.0.1:8800${pathWithQuery}`, { headers }), url: new URL(`http://127.0.0.1:8800${pathWithQuery}`) });

describe("hostname / loopback", () => {
	test("parses Origin URLs and Host headers, including a port and IPv6", () => {
		expect(hostname("http://localhost:8800")).toBe("localhost");
		expect(hostname("127.0.0.1:8800")).toBe("127.0.0.1");
		expect(hostname("http://[::1]:8800")).toBe("::1");
		expect(hostname("[::1]:8800")).toBe("::1");
		expect(hostname("null")).toBeNull();
		expect(hostname(null)).toBeNull();
	});
	test("only loopback hosts pass", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("evil.com")).toBe(false);
		expect(isLoopbackHost("192.168.1.5")).toBe(false);
	});
});

describe("tokenEquals (constant-time)", () => {
	test("equal strings match; different length or content do not", () => {
		expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
		expect(tokenEquals(TOKEN, TOKEN + "x")).toBe(false); // length mismatch short-circuits
		expect(tokenEquals("aaaaaa", "bbbbbb")).toBe(false);
	});
	test("makeToken yields distinct, non-empty tokens", () => {
		const a = makeToken();
		const b = makeToken();
		expect(a.length).toBeGreaterThan(20);
		expect(a).not.toBe(b);
	});
});

describe("checkAuth — the gate that protects live agent control", () => {
	test("valid token via Authorization header, same-origin, passes", () => {
		const { req: r, url } = req({ authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:8800", host: "127.0.0.1:8800" });
		expect(checkAuth(r, url, TOKEN)).toBeNull();
	});

	test("valid token via ?token= query passes (for WS and asset URLs)", () => {
		const { req: r, url } = req({ host: "127.0.0.1:8800" }, `/ws?session=default&token=${TOKEN}`);
		expect(checkAuth(r, url, TOKEN)).toBeNull();
	});

	test("a curl client with no Origin still passes on a valid token", () => {
		const { req: r, url } = req({ authorization: `Bearer ${TOKEN}`, host: "127.0.0.1:8800" });
		expect(checkAuth(r, url, TOKEN)).toBeNull();
	});

	test("a cross-site Origin is rejected 403 (CSWSH defense)", () => {
		const { req: r, url } = req({ authorization: `Bearer ${TOKEN}`, origin: "http://evil.com", host: "127.0.0.1:8800" });
		expect(checkAuth(r, url, TOKEN)).toEqual({ status: 403, message: "forbidden origin" });
	});

	test("a non-loopback Host is rejected 403 (DNS-rebinding defense)", () => {
		const { req: r, url } = req({ authorization: `Bearer ${TOKEN}`, host: "attacker.example.com" });
		expect(checkAuth(r, url, TOKEN)).toEqual({ status: 403, message: "forbidden host" });
	});

	test("a missing token is rejected 401", () => {
		const { req: r, url } = req({ host: "127.0.0.1:8800" });
		expect(checkAuth(r, url, TOKEN)).toEqual({ status: 401, message: "missing or invalid token" });
	});

	test("a wrong token is rejected 401", () => {
		const { req: r, url } = req({ authorization: "Bearer not-the-token", host: "127.0.0.1:8800" });
		expect(checkAuth(r, url, TOKEN)).toEqual({ status: 401, message: "missing or invalid token" });
	});
});
