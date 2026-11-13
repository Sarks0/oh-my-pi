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
	BinaryCoverage,
	CampaignDetail,
	CampaignSummary,
	CoverageGraph,
	EvidenceFile,
	FindingDetail,
	FindingState,
	FindingSummary,
	GateInfo,
	GateStatus,
	GraphEdge,
	GraphNode,
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

async function findCampaignDir(labRoot: string, id: string): Promise<string | null> {
	for (const sc of ["active", "archived"] as const) {
		const campDir = join(labRoot, "campaigns", sc, id);
		if (await pathExists(campDir)) return campDir;
	}
	return null;
}

export async function getCampaign(labRoot: string, id: string): Promise<CampaignDetail | null> {
	const campDir = await findCampaignDir(labRoot, id);
	if (!campDir) return null;
	const summary = await summarize(campDir, id, campDir.includes("/archived/"));
	return { ...summary, surfaces: await readSurfaces(campDir), findings: await readFindings(campDir) };
}

function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

/** Per-binary coverage records from the campaign's coverage/*.{yaml,json} (notes-mcp ledger shape). */
export async function readBinaryCoverage(labRoot: string, campaignId: string): Promise<BinaryCoverage[]> {
	const campDir = await findCampaignDir(labRoot, campaignId);
	if (!campDir) return [];
	const covDir = join(campDir, "coverage");
	let names: string[] = [];
	try {
		names = (await readdir(covDir)).filter(n => /\.(ya?ml|json)$/i.test(n));
	} catch {
		return [];
	}
	const out: BinaryCoverage[] = [];
	for (const n of names.sort()) {
		const raw = await readYaml(join(covDir, n)); // Bun.YAML parses JSON too
		out.push({
			sha: str(raw.binary_id) ?? str(raw.sha) ?? n.replace(/\.(ya?ml|json)$/i, ""),
			module_name: str(raw.module_name),
			total: num(raw.total),
			in_scope_total: num(raw.in_scope_total),
			reviewed: num(raw.reviewed),
			reviewed_in_scope: num(raw.reviewed_in_scope),
			status: str(raw.status),
		});
	}
	return out;
}

/**
 * Assemble the surface/coverage graph (DESIGN §4.3): binary ← surface ← finding.
 * Binary nodes carry coverage (reviewed/total). A surface links to a binary when its
 * surface.yaml names a module/binary matching a coverage record. Function/sink nodes
 * (the binary-mcp enrichment layer) are not populated from on-disk data yet.
 */
export async function buildCoverageGraph(labRoot: string, campaignId: string): Promise<CoverageGraph> {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const coverage = await readBinaryCoverage(labRoot, campaignId);
	const moduleToBin = new Map<string, string>();
	for (const b of coverage) {
		const id = `bin:${b.sha}`;
		nodes.push({
			id,
			kind: "binary",
			label: b.module_name ?? b.sha.slice(0, 12),
			sub: b.status,
			coverage: b.total != null ? { reviewed: b.reviewed ?? 0, total: b.total, in_scope: b.in_scope_total } : undefined,
		});
		if (b.module_name) moduleToBin.set(b.module_name.toLowerCase(), id);
	}

	const detail = await getCampaign(labRoot, campaignId);
	if (!detail) return { nodes, edges };

	const surfaceIds = new Set(detail.surfaces.map(s => s.id));
	for (const s of detail.surfaces) {
		nodes.push({ id: `surf:${s.id}`, kind: "surface", label: s.id, sub: str(s.raw.kind) });
		const mod = (str(s.raw.module) ?? str(s.raw.binary) ?? str(s.raw.image))?.toLowerCase();
		const binId = mod ? moduleToBin.get(mod) : undefined;
		if (binId) edges.push({ from: `surf:${s.id}`, to: binId, kind: "contains" });
	}
	for (const f of detail.findings) {
		nodes.push({ id: `find:${f.id}`, kind: "finding", label: f.id, status: f.state });
		if (f.surface_id && surfaceIds.has(f.surface_id)) edges.push({ from: `find:${f.id}`, to: `surf:${f.surface_id}`, kind: "cites" });
	}
	return { nodes, edges };
}
