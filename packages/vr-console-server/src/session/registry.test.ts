import { describe, expect, test } from "bun:test";
import { SessionRegistry } from "./registry";

/** A minimal stand-in for a Bun WebSocket: the registry only calls .send() and
 *  uses the object for Set membership, so a recorder suffices. */
function fakeSocket() {
	const sent: string[] = [];
	const ws = { send: (s: string) => sent.push(s) } as unknown as Bun.ServerWebSocket<unknown>;
	return { ws, sent };
}

describe("SessionRegistry", () => {
	test("create derives a title from a campaign cwd, and ids are distinct", () => {
		const r = new SessionRegistry();
		const a = r.create({ cwd: "/lab/campaigns/active/clfs-01" });
		const b = r.create({ cwd: "/home/user/proj" });
		expect(a.title).toBe("clfs-01"); // campaign id wins
		expect(b.title).toBe("proj"); // else cwd basename
		expect(a.id).not.toBe(b.id);
	});

	test("an explicit title and id are honored", () => {
		const r = new SessionRegistry();
		const m = r.create({ id: "default", cwd: "/x", title: "primary" });
		expect(m.id).toBe("default");
		expect(m.title).toBe("primary");
		expect(r.has("default")).toBe(true);
	});

	test("duplicate id is rejected", () => {
		const r = new SessionRegistry();
		r.create({ id: "dup", cwd: "/x" });
		expect(() => r.create({ id: "dup", cwd: "/y" })).toThrow(/already exists/);
	});

	test("list reports cold sessions as idle with no model and zero clients", () => {
		const r = new SessionRegistry();
		r.create({ id: "s1", cwd: "/a" });
		const row = r.list().find(s => s.id === "s1")!;
		expect(row.started).toBe(false);
		expect(row.model).toBeNull();
		expect(row.sockets).toBe(0);
	});

	test("ensureStarted rejects for an unknown session", async () => {
		const r = new SessionRegistry();
		await expect(r.ensureStarted("ghost")).rejects.toThrow(/no such session/);
	});

	test("attach/detach move the client count a session reports", () => {
		const r = new SessionRegistry();
		r.create({ id: "s1", cwd: "/a" });
		const { ws } = fakeSocket();
		expect(r.attach("s1", ws)).toBe(true);
		expect(r.list().find(s => s.id === "s1")!.sockets).toBe(1);
		r.detach(ws);
		expect(r.list().find(s => s.id === "s1")!.sockets).toBe(0);
	});

	test("attach to an unknown session fails", () => {
		const r = new SessionRegistry();
		const { ws } = fakeSocket();
		expect(r.attach("ghost", ws)).toBe(false);
	});

	test("dispose removes a session; disposing an unknown one is a no-op", async () => {
		const r = new SessionRegistry();
		r.create({ id: "s1", cwd: "/a" });
		expect(await r.dispose("s1")).toBe(true);
		expect(r.has("s1")).toBe(false);
		expect(r.list().some(s => s.id === "s1")).toBe(false);
		expect(await r.dispose("s1")).toBe(false);
	});
});
