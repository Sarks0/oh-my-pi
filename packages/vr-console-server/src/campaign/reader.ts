/**
 * Campaign reader — read-only projection source over campaign-mcp's on-disk tree.
 * Pure filesystem reads; no writes, ever (DESIGN §3.6, Constraint 1 — the console
 * can display/request but never mutates campaign/finding/gate state; that stays
 * with campaign-mcp on the host).
 *
 * Uses Bun.YAML (built-in) to parse the YAML the Python server wrote. Defensive by
 * design: missing/malformed files degrade to {} rather than throwing, so a
 * half-written campaign dir never takes the API down.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CampaignDetail, CampaignSummary, FindingState, FindingSummary, SurfaceSummary } from "./types";

const FINDING_DIRS: ReadonlyArray<{ dir: FindingSummary["dir"]; state: FindingState }> = [
	{ dir: "hallucinations", state: "hallucination" },
	{ dir: "findings", state: "validated" },
	{ dir: "rejected", state: "rejected" },
];

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function readYaml(p: string): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(p, "utf8");
		const v = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function listDirs(p: string): Promise<string[]> {
	try {
		const ents = await readdir(p, { withFileTypes: true });
		return ents.filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		return [];
	}
}

/** The vr-lab checkout root (campaigns/ lives under it). Mirrors paths.py lab_root(). */
export function labRootFromEnv(): string {
	const v = (process.env.VR_LAB_ROOT ?? "").trim();
	if (!v) throw new Error("VR_LAB_ROOT not set — point it at the vr-lab checkout (campaigns/ lives under it)");
	return v;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

async function summarize(campDir: string, id: string, archived: boolean): Promise<CampaignSummary> {
	const raw = await readYaml(join(campDir, "campaign.yaml"));
	const count = async (dir: string) => (await listDirs(join(campDir, dir))).filter(n => n.startsWith("finding-")).length;
	const counts = {
		hallucinations: await count("hallucinations"),
		findings: await count("findings"),
		rejected: await count("rejected"),
		surfaces: (await listDirs(join(campDir, "surface", "records"))).filter(n => n.startsWith("surface-")).length,
	};
	return {
		id,
		archived,
		platform: str(raw.platform) ?? "windows",
		scope: str(raw.scope),
		title: str(raw.title) ?? str(raw.target) ?? str(raw.component),
		counts,
		raw,
	};
}

export async function listCampaigns(labRoot: string, scope: "active" | "archived" | "all" = "active"): Promise<CampaignSummary[]> {
	const scopes = scope === "all" ? (["active", "archived"] as const) : ([scope] as const);
	const out: CampaignSummary[] = [];
	for (const sc of scopes) {
		const base = join(labRoot, "campaigns", sc);
		for (const id of await listDirs(base)) out.push(await summarize(join(base, id), id, sc === "archived"));
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function readSurfaces(campDir: string): Promise<SurfaceSummary[]> {
	const base = join(campDir, "surface", "records");
	const out: SurfaceSummary[] = [];
	for (const name of (await listDirs(base)).filter(n => n.startsWith("surface-")).sort()) {
		out.push({ id: name, raw: await readYaml(join(base, name, "surface.yaml")) });
	}
	return out;
}

async function readFindings(campDir: string): Promise<FindingSummary[]> {
	const out: FindingSummary[] = [];
	for (const { dir, state } of FINDING_DIRS) {
		const base = join(campDir, dir);
		for (const name of (await listDirs(base)).filter(n => n.startsWith("finding-")).sort()) {
			const fdir = join(base, name);
			const raw = await readYaml(join(fdir, "finding.yaml"));
			const gates = (await listDirs(join(fdir, "evidence"))).sort();
			out.push({
				id: name,
				state, // directory-derived, authoritative
				dir,
				surface_id: str(raw.surface_id),
				security_invariant: str(raw.security_invariant),
				gates,
				raw,
			});
		}
	}
	return out;
}

export async function getCampaign(labRoot: string, id: string): Promise<CampaignDetail | null> {
	for (const sc of ["active", "archived"] as const) {
		const campDir = join(labRoot, "campaigns", sc, id);
		if (!(await pathExists(campDir))) continue;
		const summary = await summarize(campDir, id, sc === "archived");
		return { ...summary, surfaces: await readSurfaces(campDir), findings: await readFindings(campDir) };
	}
	return null;
}
