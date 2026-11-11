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
import { join, normalize } from "node:path";
import type {
	CampaignDetail,
	CampaignSummary,
	EvidenceFile,
	FindingDetail,
	FindingState,
	FindingSummary,
	GateInfo,
	GateStatus,
	SurfaceSummary,
} from "./types";

const FINDING_DIRS: ReadonlyArray<{ dir: FindingSummary["dir"]; state: FindingState }> = [
	{ dir: "hallucinations", state: "hallucination" },
	{ dir: "findings", state: "validated" },
	{ dir: "rejected", state: "rejected" },
];

const GATE_STATUSES: readonly GateStatus[] = ["not_started", "in_progress", "passed", "failed", "blocked", "not_applicable"];
// Canonical display order (vr-lab/mcp/campaign-mcp/campaign_mcp/gates.py DEFAULT_GATES).
const GATE_ORDER = [
	"gate0_poc_compiles",
	"gate1a_canary_clean_repro",
	"gate1b_stable_repro",
	"gate2_security_impact",
	"gate2b_severity_bar",
	"gate2c_dependency_origin",
	"gate3_privilege_context",
	"gate4_report_package",
];

/** finding.yaml's `gates` dict → ordered GateInfo[] with real status (gates.py model). */
function parseGates(raw: Record<string, unknown>): GateInfo[] {
	const g = raw.gates;
	if (!g || typeof g !== "object" || Array.isArray(g)) return [];
	const out: GateInfo[] = Object.entries(g as Record<string, any>).map(([name, v]) => ({
		name,
		status: typeof v?.status === "string" && (GATE_STATUSES as readonly string[]).includes(v.status) ? (v.status as GateStatus) : "not_started",
		required: v?.required === true,
		evidence_count: Array.isArray(v?.evidence) ? v.evidence.length : 0,
	}));
	return out.sort((a, b) => {
		const ia = GATE_ORDER.indexOf(a.name), ib = GATE_ORDER.indexOf(b.name);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.name.localeCompare(b.name);
	});
}

/** security_invariant is {statement: "..."} in the record, sometimes a bare string. */
function parseInvariant(raw: Record<string, unknown>): string | undefined {
	const v = raw.security_invariant;
	if (typeof v === "string") return v;
	if (v && typeof v === "object" && typeof (v as { statement?: unknown }).statement === "string") {
		return (v as { statement: string }).statement;
	}
	return undefined;
}

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

function summarizeFinding(raw: Record<string, unknown>, name: string, dir: FindingSummary["dir"], state: FindingState): FindingSummary {
	return {
		id: name,
		state, // directory-derived, authoritative
		dir,
		surface_id: str(raw.surface_id),
		security_invariant: parseInvariant(raw),
		gates: parseGates(raw),
		raw,
	};
}

async function readFindings(campDir: string): Promise<FindingSummary[]> {
	const out: FindingSummary[] = [];
	for (const { dir, state } of FINDING_DIRS) {
		const base = join(campDir, dir);
		for (const name of (await listDirs(base)).filter(n => n.startsWith("finding-")).sort()) {
			out.push(summarizeFinding(await readYaml(join(base, name, "finding.yaml")), name, dir, state));
		}
	}
	return out;
}

/** List files under a finding's evidence/<gate>/ tree (one level of gate dirs). */
async function readEvidenceFiles(fdir: string): Promise<EvidenceFile[]> {
	const out: EvidenceFile[] = [];
	const evRoot = join(fdir, "evidence");
	for (const gate of (await listDirs(evRoot)).sort()) {
		const gdir = join(evRoot, gate);
		let ents: { name: string; isFile: () => boolean }[] = [];
		try {
			ents = (await readdir(gdir, { withFileTypes: true })) as unknown as typeof ents;
		} catch {
			/* skip */
		}
		for (const e of ents) {
			if (!e.isFile()) continue;
			let size = 0;
			try {
				size = (await stat(join(gdir, e.name))).size;
			} catch {
				/* ignore */
			}
			out.push({ gate, name: e.name, size, rel: `evidence/${gate}/${e.name}` });
		}
	}
	return out;
}

async function findFindingDir(labRoot: string, campaignId: string, findingId: string): Promise<{ fdir: string; dir: FindingSummary["dir"]; state: FindingState } | null> {
	for (const sc of ["active", "archived"] as const) {
		for (const { dir, state } of FINDING_DIRS) {
			const fdir = join(labRoot, "campaigns", sc, campaignId, dir, findingId);
			if (await pathExists(join(fdir, "finding.yaml"))) return { fdir, dir, state };
		}
	}
	return null;
}

export async function getFinding(labRoot: string, campaignId: string, findingId: string): Promise<FindingDetail | null> {
	const loc = await findFindingDir(labRoot, campaignId, findingId);
	if (!loc) return null;
	const raw = await readYaml(join(loc.fdir, "finding.yaml"));
	const base = summarizeFinding(raw, findingId, loc.dir, loc.state);
	return {
		...base,
		campaign_id: campaignId,
		source: str(raw.source),
		sink: str(raw.sink),
		evidence_files: await readEvidenceFiles(loc.fdir),
	};
}

/**
 * Resolve an evidence file path for serving. Path-guarded: `rel` must stay within the
 * finding's evidence/ dir (no traversal). Returns the absolute path, or null.
 */
export async function resolveEvidenceFile(labRoot: string, campaignId: string, findingId: string, rel: string): Promise<string | null> {
	const loc = await findFindingDir(labRoot, campaignId, findingId);
	if (!loc) return null;
	const evRoot = normalize(join(loc.fdir, "evidence")) + "/";
	const abs = normalize(join(loc.fdir, rel));
	if (!abs.startsWith(evRoot)) return null; // traversal guard
	if (!(await pathExists(abs))) return null;
	const s = await stat(abs);
	return s.isFile() ? abs : null;
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
