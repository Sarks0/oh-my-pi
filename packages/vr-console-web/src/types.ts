// Mirrors @oh-my-pi/vr-console-server's campaign read model + WS frames.
export type FindingState = "hallucination" | "validated" | "rejected";

export interface CampaignSummary {
	id: string;
	archived: boolean;
	platform: string;
	scope?: string;
	title?: string;
	counts: { hallucinations: number; findings: number; rejected: number; surfaces: number };
	raw: Record<string, unknown>;
}
export interface SurfaceSummary {
	id: string;
	raw: Record<string, unknown>;
}
export type GateStatus = "not_started" | "in_progress" | "passed" | "failed" | "blocked" | "not_applicable";
export interface GateInfo {
	name: string;
	status: GateStatus;
	required: boolean;
	evidence_count: number;
}
export interface FindingSummary {
	id: string;
	state: FindingState;
	dir: string;
	surface_id?: string;
	security_invariant?: string;
	gates: GateInfo[];
	raw: Record<string, unknown>;
}
export interface EvidenceFile {
	gate: string;
	name: string;
	size: number;
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

export interface Programme {
	name: string;
	description?: string;
	url?: string;
	competition_level?: string;
	payouts_min: Record<string, number>;
	bug_classes: string[];
	min_payout?: number;
	max_payout?: number;
}

export type WsFrame = { type: string; [k: string]: unknown };
