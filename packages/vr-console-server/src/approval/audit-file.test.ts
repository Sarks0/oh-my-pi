import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { makeFileAuditor } from "./audit";

describe("makeFileAuditor — JSONL fallback trail (P1-3)", () => {
	const path = join(tmpdir(), `vrc-audit-${process.pid}.jsonl`);
	afterAll(() => rm(path, { force: true }));

	test("a raise then a resolve append two tagged JSON lines", async () => {
		const auditor = makeFileAuditor(path, { campaignId: "clfs-01", cwd: "/lab/x" });
		auditor.onRaise("abc_approval_1", { compact: "lab winrm", sessionOffered: false });
		auditor.onResolve("abc_approval_1", "deny");

		// appends are fire-and-forget; wait for both lines to land
		let lines: string[] = [];
		for (let i = 0; i < 50 && lines.length < 2; i++) {
			await Bun.sleep(10);
			const text = await Bun.file(path).text().catch(() => "");
			lines = text.split("\n").filter(Boolean);
		}
		expect(lines).toHaveLength(2);
		const raise = JSON.parse(lines[0]);
		const resolve = JSON.parse(lines[1]);
		expect(raise).toMatchObject({ event: "raise", id: "abc_approval_1", status: "pending", campaignId: "clfs-01" });
		expect(resolve).toMatchObject({ event: "resolve", id: "abc_approval_1", status: "denied", answer: "deny" });
		expect(typeof raise.ts).toBe("string"); // timestamped for provenance
	});
});
