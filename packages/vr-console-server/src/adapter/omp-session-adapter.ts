/**
 * OmpSessionAdapter — THE single integration seam between the console and omp
 * (DESIGN §2.2, the "norma-equivalent"). Everything above it is transport-agnostic;
 * an omp SDK change is a one-file fix here (Constraint 6: omp is never forked).
 *
 * Replaces the Phase-0 spike's `autoApprove: true` with a real human gate built
 * only from omp levers (DESIGN §7):
 *   - Settings `tools.approvalMode = "always-ask"` — the fail-safe default. omp
 *     tiers every MCP tool as `write` (tool-bridge.ts:735), so under always-ask
 *     EVERY MCP tool reaches the approval gate and raises a card.
 *   - `setToolUIContext(ConsoleUIContext, true)` — supplies a real `approve()`.
 *
 * Grounded SDK calls:
 *   createAgentSession  sdk.ts:1945   | session.subscribe   agent-session.ts:6014
 *   session.prompt      :8633 (→bool) | session.dispose     :6656
 *   setToolUIContext    sdk.ts:4725   | mcpManager.waitForStartup / getTools  mcp/manager.ts
 *   session.refreshMCPTools + getTools  print-mode.ts:414-419
 */
import { createAgentSession, discoverMCPServers, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { createConsoleUIContext } from "../approval/ui-context";
import { compileApprovalPolicy, summarizePolicy } from "../approval/policy";
import { PendingRegistry } from "../approval/pending";
import type { Broadcast } from "../approval/pending";
import { shapeEvent } from "../event-shape";

const MCP_STARTUP_TIMEOUT_MS = 30_000;

export class OmpSessionAdapter {
	readonly pending: PendingRegistry;
	#session: any;
	#mcpManager: any;
	#unsub: (() => void) | undefined;

	/** opts.onRawEvent taps the UNSHAPED event stream (e.g. for the cost ledger). */
	constructor(
		private broadcast: Broadcast,
		private opts: { onRawEvent?: (ev: unknown) => void } = {},
	) {
		this.pending = new PendingRegistry(broadcast);
	}

	async start(cwd: string): Promise<void> {
		this.broadcast({ type: "notice", level: "info", message: `creating agent session (cwd=${cwd})` });

		// Pre-discover MCP so the per-tool policy can be keyed by the LIVE minted names
		// (omp has no glob matching — DESIGN §7.3). Minting is deterministic, and we
		// reuse this same manager for the session, so there is no double-connect.
		let seededPolicy: Record<string, "allow" | "deny" | "prompt"> = {};
		let discoveredManager: any;
		try {
			const disc = await discoverMCPServers(cwd);
			discoveredManager = disc.manager;
			const names = disc.tools.map((t: any) => t.name as string);
			seededPolicy = compileApprovalPolicy(names);
			const s = summarizePolicy(seededPolicy);
			this.broadcast({
				type: "notice",
				level: "info",
				message: `discovered ${names.length} MCP tools (${disc.connectedServers.length} servers); policy → allow ${s.allow} / prompt ${s.prompt}`,
			});
		} catch (err) {
			this.broadcast({ type: "notice", level: "warn", message: `MCP discovery failed: ${String(err)}; defaulting to always-ask only` });
		}

		// Approval posture: always-ask (the fail-safe default — omp tiers every MCP
		// tool as write) + the narrowing policy (auto-allow read-only queries). NO
		// `autoApprove` option — that is the yolo posture this adapter exists to remove.
		const base = await Settings.init({ cwd });
		const settings = base.overlay(
			{
				"tools.approvalMode": "always-ask",
				"tools.approval": seededPolicy,
				"autolearn.enabled": false,
				"memory.backend": "off",
			},
			{ derived: true },
		);

		const res = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			mcpManager: discoveredManager, // reuse the discovered manager (no re-connect)
			enableMCP: true,
			enableLsp: false,
			hasUI: false, // headless session…
		});
		this.#session = res.session;
		this.#mcpManager = res.mcpManager ?? discoveredManager;

		// …but DO supply a tool-approval UI: the `true` enables tool dialogs
		// (sdk.ts:959 "hasUI only enables tool dialogs"), so approve() fires.
		res.setToolUIContext(createConsoleUIContext(this.broadcast, this.pending), true);

		this.#unsub = this.#session.subscribe((ev: any) => {
			this.broadcast(shapeEvent(ev));
			try {
				this.opts.onRawEvent?.(ev);
			} catch {
				/* a ledger write must never break the event stream */
			}
		});

		if (this.#mcpManager) {
			this.broadcast({ type: "notice", level: "info", message: "waiting for MCP servers…" });
			try {
				await this.#mcpManager.waitForStartup(MCP_STARTUP_TIMEOUT_MS);
				await this.#session.refreshMCPTools(this.#mcpManager.getTools());
				this.broadcast({ type: "notice", level: "info", message: "MCP servers ready" });
			} catch (err) {
				this.broadcast({ type: "notice", level: "warn", message: `MCP startup issue: ${String(err)}` });
			}
		}
	}

	/** Send a user turn; resolves (boolean) when the turn settles. */
	prompt(text: string): Promise<boolean> {
		return this.#session.prompt(text);
	}

	/** Route a browser reply to the matching pending UI request. */
	resolveReply(id: string, value: unknown): boolean {
		return this.pending.resolve(id, value);
	}

	async dispose(): Promise<void> {
		this.#unsub?.();
		this.pending.rejectAll("deny"); // fail-closed: any parked approval → deny
		await this.#session?.dispose();
	}
}
