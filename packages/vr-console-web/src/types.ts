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
export interface FindingSummary {
	id: string;
	state: FindingState;
	dir: string;
	surface_id?: string;
	security_invariant?: string;
	gates: string[];
	raw: Record<string, unknown>;
}
export interface CampaignDetail extends CampaignSummary {
	surfaces: SurfaceSummary[];
	findings: FindingSummary[];
}

export type WsFrame = { type: string; [k: string]: unknown };
