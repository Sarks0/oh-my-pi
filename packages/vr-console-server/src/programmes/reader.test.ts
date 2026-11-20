import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProgrammes } from "./reader";

let LAB: string;

beforeAll(async () => {
	LAB = await mkdtemp(join(tmpdir(), "vrlab-prog-"));
	await mkdir(join(LAB, "targets"), { recursive: true });
	await writeFile(
		join(LAB, "targets", "bounty_programs.yaml"),
		[
			"programmes:",
			'  "Microsoft Windows Insider Preview":',
			'    description: "pre-release Windows bounty"',
			'    url: "https://example/msrc"',
			"    competition_level: high",
			"    payouts_min:",
			"      rce: 5000",
			"      lpe: 8000",
			"      dos: 500",
			'  "Valve (HackerOne)":',
			"    payouts_min:",
			"      rce: 2000",
			"",
		].join("\n"),
	);
});

afterAll(async () => { await rm(LAB, { recursive: true, force: true }); });

describe("listProgrammes", () => {
	test("parses programmes with payouts + min/max", async () => {
		const progs = await listProgrammes(LAB);
		expect(progs.map(p => p.name)).toEqual(["Microsoft Windows Insider Preview", "Valve (HackerOne)"]);
		const msrc = progs[0];
		expect(msrc.competition_level).toBe("high");
		expect(msrc.url).toBe("https://example/msrc");
		expect(msrc.bug_classes.sort()).toEqual(["dos", "lpe", "rce"]);
		expect(msrc.min_payout).toBe(500);
		expect(msrc.max_payout).toBe(8000);
		expect(msrc.payouts_min.lpe).toBe(8000);
	});
	test("missing file → empty list (no throw)", async () => {
		expect(await listProgrammes("/nonexistent")).toEqual([]);
	});
});
