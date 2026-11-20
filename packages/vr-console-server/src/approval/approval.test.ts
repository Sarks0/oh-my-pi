import { describe, expect, test } from "bun:test";
import { PendingRegistry } from "./pending";
import { createConsoleUIContext, normalizeApprovalAnswer } from "./ui-context";
import { classifyAnswer, type ApprovalAuditor } from "./audit";

const PROMPT_PLAIN = { full: "run lab-mcp WinRM", compact: "lab winrm" };
const PROMPT_SESSION = { ...PROMPT_PLAIN, session: "Approve for this session" };
const PROMPT_GRANT = { ...PROMPT_PLAIN, grants: [{ scope: "folder" as const, label: "Approve Dir", alwaysLabel: "Always Approve Dir" }] };

describe("normalizeApprovalAnswer — fail-closed", () => {
	test("explicit answers pass through", () => {
		expect(normalizeApprovalAnswer("once", PROMPT_PLAIN)).toBe("once");
		expect(normalizeApprovalAnswer("deny", PROMPT_PLAIN)).toBe("deny");
	});
	test("session only when the prompt offered it", () => {
		expect(normalizeApprovalAnswer("session", PROMPT_SESSION)).toBe("session");
		expect(normalizeApprovalAnswer("session", PROMPT_PLAIN)).toBe("deny");
	});
	test("grant only when the prompt listed that scope", () => {
		expect(normalizeApprovalAnswer({ grant: "folder", always: true }, PROMPT_GRANT)).toEqual({ grant: "folder", always: true });
		expect(normalizeApprovalAnswer({ grant: "target", always: false }, PROMPT_GRANT)).toBe("deny"); // target not offered
		expect(normalizeApprovalAnswer({ grant: "folder", always: false }, PROMPT_PLAIN)).toBe("deny"); // no grants at all
	});
	test("anything else is deny", () => {
		for (const bad of ["allow", "yes", "approve", "", null, undefined, 1, {}, { grant: "root" }, [], true]) {
			expect(normalizeApprovalAnswer(bad as unknown, PROMPT_PLAIN)).toBe("deny");
		}
	});
});

describe("PendingRegistry ids — session-unique prefix (P2-3)", () => {
	test("two registries mint differently-prefixed ids, so a stale reply can't cross over", () => {
		const a = new PendingRegistry(() => {});
		const b = new PendingRegistry(() => {});
		const ida = a.requestWithId("approval", { type: "approval_request" }).id;
		const idb = b.requestWithId("approval", { type: "approval_request" }).id;
		expect(ida).not.toBe(idb); // different prefixes despite same kind + seq=1
		expect(a.resolve(idb, "once")).toBe(false); // b's id is unknown to a
		expect(a.resolve(ida, "once")).toBe(true);
	});
});

describe("ConsoleUIContext.approve — pushes a card and resolves on reply", () => {
	test("approve once", async () => {
		const frames: any[] = [];
		const pending = new PendingRegistry(f => frames.push(f));
		const ctx = createConsoleUIContext(f => frames.push(f), pending);
		const p = ctx.approve!(PROMPT_PLAIN as any);
		const card = frames.find(f => f.type === "approval_request");
		expect(card).toBeTruthy();
		expect(pending.resolve(card.id, "once")).toBe(true);
		expect(await p).toBe("once");
	});
	test("garbage reply fails closed to deny", async () => {
		const frames: any[] = [];
		const pending = new PendingRegistry(f => frames.push(f));
		const ctx = createConsoleUIContext(f => frames.push(f), pending);
		const p = ctx.approve!(PROMPT_PLAIN as any);
		const card = frames.find(f => f.type === "approval_request");
		pending.resolve(card.id, "allow"); // attacker/buggy client tries to force allow
		expect(await p).toBe("deny");
	});
	test("rejectAll denies a parked approval", async () => {
		const frames: any[] = [];
		const pending = new PendingRegistry(f => frames.push(f));
		const ctx = createConsoleUIContext(f => frames.push(f), pending);
		const p = ctx.approve!(PROMPT_PLAIN as any);
		pending.rejectAll("deny");
		expect(await p).toBe("deny");
	});
});

describe("approval audit wiring", () => {
	test("classifyAnswer maps answers to audit status", () => {
		expect(classifyAnswer("deny")).toEqual({ status: "denied", answer: "deny" });
		expect(classifyAnswer("once")).toEqual({ status: "allowed", answer: "once" });
		expect(classifyAnswer("session")).toEqual({ status: "allowed", answer: "session" });
		expect(classifyAnswer({ grant: "folder", always: true })).toEqual({ status: "allowed", answer: "grant:folder:always" });
	});
	test("approve() calls onRaise then onResolve with the normalized answer", async () => {
		const frames: any[] = [];
		const pending = new PendingRegistry(f => frames.push(f));
		const calls: Array<[string, string, unknown]> = [];
		const auditor: ApprovalAuditor = {
			onRaise: (id, info) => calls.push(["raise", id, info]),
			onResolve: (id, answer) => calls.push(["resolve", id, answer]),
		};
		const ctx = createConsoleUIContext(f => frames.push(f), pending, auditor);
		const p = ctx.approve!(PROMPT_PLAIN as any);
		const card = frames.find(f => f.type === "approval_request");
		expect(calls[0][0]).toBe("raise"); // raised before resolve
		expect(calls[0][1]).toBe(card.id);
		pending.resolve(card.id, "allow"); // garbage → fail-closed deny
		await p;
		expect(calls[1]).toEqual(["resolve", card.id, "deny"]);
	});
});
