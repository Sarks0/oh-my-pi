/**
 * Campaign read model — a typed view over campaign-mcp's on-disk layout
 * (the host FS is the source of truth; the console only READS it; DESIGN §3.1).
 *
 * Layout (vr-lab/mcp/campaign-mcp/campaign_mcp/{paths,storage}.py):
 *   <labRoot>/campaigns/{active,archived}/<id>/
 *     campaign.yaml
 *     surface/records/<surface-NNN_slug>/surface.yaml
 *     hallucinations/<finding-NNN_slug>/finding.yaml   -> state "hallucination"
 *     findings/<finding-NNN_slug>/finding.yaml          -> state "validated"   (NOT "finding")
 *     rejected/<finding-NNN_slug>/finding.yaml          -> state "rejected"
 *     <finding>/evidence/<gate_name>/                    -> recorded gate evidence
 *
 * The directory is the authoritative state (DESIGN §3: findings/ ↔ state "validated");
 * we derive `state` from the directory, never from a possibly-stale finding.yaml field.
 */
export type FindingState = "hallucination" | "validated" | "rejected";

export interface CampaignSummary {
	id: string;
	archived: boolean;
	platform: string;
	scope?: string;
	title?: string;
	counts: { hallucinations: number; findings: number; rejected: number; surfaces: number };
	/** Full parsed campaign.yaml, for fields the typed view does not surface. */
	raw: Record<string, unknown>;
}

export interface SurfaceSummary {
	id: string;
	raw: Record<string, unknown>;
}

/** A gate from finding.yaml's `gates` dict (campaign-mcp gates.py model). */
export type GateStatus = "not_started" | "in_progress" | "passed" | "failed" | "blocked" | "not_applicable";
export interface GateInfo {
	name: string;
	status: GateStatus;
	required: boolean;
	evidence_count: number;
}

export interface FindingSummary {
	id: string;
	/** Derived from the directory (authoritative), not finding.yaml. */
	state: FindingState;
	dir: "hallucinations" | "findings" | "rejected";
	surface_id?: string;
	security_invariant?: string;
	/** Real gate status from finding.yaml's `gates` dict (empty if none recorded yet). */
	gates: GateInfo[];
	raw: Record<string, unknown>;
}

/** One file under a finding's evidence/<gate>/ tree. */
export interface EvidenceFile {
	gate: string;
	name: string;
	size: number;
	/** Relative to the finding dir, e.g. "evidence/gate0_poc_compiles/poc.c". */
	rel: string;
}

export interface FindingDetail extends FindingSummary {
	campaign_id: string;
	source?: string;
	sink?: string;
	evidence_files: EvidenceFile[];
}

export interface CampaignDetail extends CampaignSummary {
	surfaces: SurfaceSummary[];
	findings: FindingSummary[];
}

/** Per-binary coverage ledger record (notes-mcp coverage schema; see coverage.py). */
export interface BinaryCoverage {
	sha: string;
	module_name?: string;
	total?: number;
	in_scope_total?: number;
	reviewed?: number;
	reviewed_in_scope?: number;
	status?: string; // "ready" | "not_indexed" | …
}

/**
 * Surface/coverage graph (DESIGN §4.3). Shell model: binary ← surface ← finding.
 * The binary-mcp enrichment layer adds `function`/`sink` nodes between binary and
 * surface (call-path edges) once live Ghidra data is available on the host.
 */
export type GraphNodeKind = "binary" | "surface" | "finding" | "function" | "sink";
export interface GraphNode {
	id: string;
	kind: GraphNodeKind;
	label: string;
	sub?: string;
	status?: string; // finding state, or binary index status
	coverage?: { reviewed: number; total: number; in_scope?: number };
}
export interface GraphEdge {
	from: string;
	to: string;
	kind: "cites" | "contains" | "calls";
}
export interface CoverageGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}
