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
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
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

	constructor(private broadcast: Broadcast) {
		this.pending = new PendingRegistry(broadcast);
	}

	async start(cwd: string): Promise<void> {
		this.broadcast({ type: "notice", level: "info", message: `creating agent session (cwd=${cwd})` });

		// Fail-safe approval posture. NOTE: no `autoApprove` option — that is the yolo
		// posture the spike used and that this adapter exists to remove.
		const base = await Settings.init({ cwd });
		const settings = base.overlay(
			{ "tools.approvalMode": "always-ask", "autolearn.enabled": false, "memory.backend": "off" },
			{ derived: true },
		);

		const res = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			enableMCP: true,
			enableLsp: false,
			hasUI: false, // headless session…
		});
		this.#session = res.session;
		this.#mcpManager = res.mcpManager;

		// …but DO supply a tool-approval UI: the `true` enables tool dialogs
		// (sdk.ts:959 "hasUI only enables tool dialogs"), so approve() fires.
		res.setToolUIContext(createConsoleUIContext(this.broadcast, this.pending), true);

		this.#unsub = this.#session.subscribe((ev: any) => this.broadcast(shapeEvent(ev)));

		if (this.#mcpManager) {
			this.broadcast({ type: "notice", level: "info", message: "waiting for MCP servers…" });
			try {
				await this.#mcpManager.waitForStartup(MCP_STARTUP_TIMEOUT_MS);
				await this.#session.refreshMCPTools(this.#mcpManager.getTools());
				const names = this.#mcpManager.getTools().map((t: any) => t.name as string);
				const policy = compileApprovalPolicy(names);
				const s = summarizePolicy(policy);
				this.broadcast({
					type: "notice",
					level: "info",
					message: `MCP ready: ${names.length} tools; ruleset → allow ${s.allow} / prompt ${s.prompt} (every MCP tool still cards under always-ask until narrowing lands in Increment 2)`,
				});
				// Increment 2: apply `policy` to the live settings so read-only queries auto-run.
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
