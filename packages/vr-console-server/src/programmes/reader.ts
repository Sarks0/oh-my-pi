/**
 * Programme reader — read-only view over vr-lab's bounty programme reference data
 * (targets/bounty_programs.yaml), the console analog of ARTEX's HackerOne/Bugcrowd
 * programme sync. The file is target-mcp's ROI + programme_scope_check source; the
 * console only READS it (scope authority stays on the host — DESIGN §5.5, §8.4).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Programme {
	name: string;
	description?: string;
	url?: string;
	competition_level?: string;
	/** bug class → minimum published payout (USD). Key existence drives scope checks. */
	payouts_min: Record<string, number>;
	bug_classes: string[];
	min_payout?: number;
	max_payout?: number;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
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

export async function listProgrammes(labRoot: string): Promise<Programme[]> {
	const raw = await readYaml(join(labRoot, "targets", "bounty_programs.yaml"));
	const progs = raw.programmes;
	if (!progs || typeof progs !== "object" || Array.isArray(progs)) return [];
	return Object.entries(progs as Record<string, any>)
		.map(([name, v]) => {
			const payouts: Record<string, number> = {};
			if (v?.payouts_min && typeof v.payouts_min === "object") {
				for (const [k, n] of Object.entries(v.payouts_min as Record<string, unknown>)) {
					if (typeof n === "number") payouts[k] = n;
				}
			}
			const vals = Object.values(payouts);
			return {
				name,
				description: str(v?.description),
				url: str(v?.url),
				competition_level: str(v?.competition_level),
				payouts_min: payouts,
				bug_classes: Object.keys(payouts),
				min_payout: vals.length ? Math.min(...vals) : undefined,
				max_payout: vals.length ? Math.max(...vals) : undefined,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
