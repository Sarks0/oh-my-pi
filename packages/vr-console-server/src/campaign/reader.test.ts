import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCampaign, listCampaigns } from "./reader";

let LAB: string;

/** Build a synthetic campaign tree matching campaign-mcp's on-disk layout. */
beforeAll(async () => {
	LAB = await mkdtemp(join(tmpdir(), "vrlab-"));
	const camp = join(LAB, "campaigns", "active", "camp-001_clfs");
	await mkdir(join(camp, "surface", "records", "surface-001_ioctl"), { recursive: true });
	await writeFile(join(camp, "campaign.yaml"), "platform: windows\nscope: CLFS driver\ntarget: clfs.sys\n");
	await writeFile(join(camp, "surface", "records", "surface-001_ioctl", "surface.yaml"), "kind: ioctl\ndevice: \\\\.\\CLFS\n");

	// hallucination (born), with a gate0 evidence dir
	await mkdir(join(camp, "hallucinations", "finding-001_oob", "evidence", "gate0_poc_compiles"), { recursive: true });
	await writeFile(
		join(camp, "hallucinations", "finding-001_oob", "finding.yaml"),
		"surface_id: surface-001_ioctl\nsecurity_invariant: bounded copy\nstate: hallucination\n",
	);
	// promoted finding — dir says validated even if the field lagged
	await mkdir(join(camp, "findings", "finding-002_uaf", "evidence", "gate4_report_package"), { recursive: true });
	await writeFile(join(camp, "findings", "finding-002_uaf", "finding.yaml"), "surface_id: surface-001_ioctl\nstate: validated\n");
	// rejected
	await mkdir(join(camp, "rejected", "finding-003_nullderef"), { recursive: true });
	await writeFile(join(camp, "rejected", "finding-003_nullderef", "finding.yaml"), "surface_id: surface-001_ioctl\n");

	// a second, archived campaign
	const camp2 = join(LAB, "campaigns", "archived", "camp-000_old");
	await mkdir(camp2, { recursive: true });
	await writeFile(join(camp2, "campaign.yaml"), "platform: windows\nscope: old\n");
});

afterAll(async () => {
	await rm(LAB, { recursive: true, force: true });
});

describe("listCampaigns", () => {
	test("active scope lists active campaigns with finding/surface counts", async () => {
		const camps = await listCampaigns(LAB, "active");
		expect(camps.length).toBe(1);
		const c = camps[0];
		expect(c.id).toBe("camp-001_clfs");
		expect(c.platform).toBe("windows");
		expect(c.title).toBe("clfs.sys");
		expect(c.counts).toEqual({ hallucinations: 1, findings: 1, rejected: 1, surfaces: 1 });
		expect(c.archived).toBe(false);
	});
	test("all scope includes archived", async () => {
		const camps = await listCampaigns(LAB, "all");
		expect(camps.map(c => c.id)).toEqual(["camp-000_old", "camp-001_clfs"]);
		expect(camps.find(c => c.id === "camp-000_old")!.archived).toBe(true);
	});
});

describe("getCampaign", () => {
	test("returns surfaces and findings with directory-derived state", async () => {
		const c = await getCampaign(LAB, "camp-001_clfs");
		expect(c).not.toBeNull();
		expect(c!.surfaces.map(s => s.id)).toEqual(["surface-001_ioctl"]);

		const byId = Object.fromEntries(c!.findings.map(f => [f.id, f]));
		expect(byId["finding-001_oob"].state).toBe("hallucination");
		expect(byId["finding-001_oob"].gates).toEqual(["gate0_poc_compiles"]);
		expect(byId["finding-001_oob"].surface_id).toBe("surface-001_ioctl");
		// directory is authoritative — findings/ ⇒ "validated"
		expect(byId["finding-002_uaf"].state).toBe("validated");
		expect(byId["finding-002_uaf"].gates).toEqual(["gate4_report_package"]);
		expect(byId["finding-003_nullderef"].state).toBe("rejected");
	});
	test("unknown id returns null", async () => {
		expect(await getCampaign(LAB, "nope")).toBeNull();
	});
});
