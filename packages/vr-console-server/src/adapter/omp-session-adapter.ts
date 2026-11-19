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

/** Flat, transport-safe view of an omp Model for the LLM panel. */
export interface ModelDTO {
	id: string;
	name: string;
	provider: string;
	api: string | null;
	contextWindow: number | null;
}

export class OmpSessionAdapter {
	readonly pending: PendingRegistry;
	#session: any;
	#mcpManager: any;
	#unsub: (() => void) | undefined;
	#cwd: string | undefined;
	#lastModel: string | undefined;
	#lastProvider: string | undefined;
	#lastApi: string | undefined;

	/** opts.onRawEvent taps the UNSHAPED event stream (e.g. for the cost ledger);
	 *  opts.approvalAuditor records approve/deny decisions. */
	constructor(
		private broadcast: Broadcast,
		private opts: { onRawEvent?: (ev: unknown) => void; approvalAuditor?: import("../approval/audit").ApprovalAuditor } = {},
	) {
		this.pending = new PendingRegistry(broadcast);
	}

	async start(cwd: string): Promise<void> {
		this.#cwd = cwd;
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
		res.setToolUIContext(createConsoleUIContext(this.broadcast, this.pending, this.opts.approvalAuditor), true);

		this.#unsub = this.#session.subscribe((ev: any) => {
			this.broadcast(shapeEvent(ev));
			// Capture the live model/provider off assistant turns — omp has no simple
			// public model getter on AgentSession (#modelRegistry/#models are private),
			// so the event stream is the grounded source for the Agent panel.
			try {
				if (ev?.type === "message_end" && ev.message?.role === "assistant") {
					if (ev.message.model) this.#lastModel = String(ev.message.model);
					if (ev.message.provider) this.#lastProvider = String(ev.message.provider);
					if (ev.message.api) this.#lastApi = String(ev.message.api);
				}
			} catch {
				/* model capture is best-effort */
			}
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

	/** True once start() has created the in-process session. */
	get started(): boolean {
		return !!this.#session;
	}

	/** Live MCP view for the operational panel: connected servers + minted tools.
	 *  `connectedServers` is the manager property (manager.ts:245); if absent we
	 *  derive it from the unique serverNames on the tools. */
	mcpInfo(): { started: boolean; connectedServers: string[]; tools: Array<{ name: string; server: string | undefined }> } {
		const mgr = this.#mcpManager;
		const rawTools: any[] = mgr?.getTools ? mgr.getTools() : [];
		const tools = rawTools.map((t: any) => ({ name: t.name as string, server: t?.details?.serverName as string | undefined }));
		let connectedServers: string[] = Array.isArray(mgr?.connectedServers) ? mgr.connectedServers : [];
		if (connectedServers.length === 0) {
			connectedServers = [...new Set(tools.map((t) => t.server).filter((s): s is string => !!s))];
		}
		return { started: this.started, connectedServers, tools };
	}

	/** The session's current model as a flat DTO. Reads the live `session.model`
	 *  getter first (populated at session init / after a switch), falling back to
	 *  what the event stream captured if the getter is not yet populated. */
	#currentModel(): ModelDTO | null {
		const m = this.#session?.model;
		if (m) return { id: m.id, name: m.name ?? m.id, provider: m.provider, api: m.api ?? null, contextWindow: m.contextWindow ?? null };
		if (this.#lastModel) return { id: this.#lastModel, name: this.#lastModel, provider: this.#lastProvider ?? "", api: this.#lastApi ?? null, contextWindow: null };
		return null;
	}

	/** Session summary for the Agent panel. approvalMode is the pinned posture
	 *  (always-ask); model/provider come from the live session, else the stream. */
	sessionInfo(): {
		started: boolean;
		cwd: string | undefined;
		approvalMode: string;
		model: string | null;
		provider: string | null;
		api: string | null;
		mcp: { servers: number; tools: number };
	} {
		const mgr = this.#mcpManager;
		const toolCount = mgr?.getTools ? mgr.getTools().length : 0;
		const serverCount = Array.isArray(mgr?.connectedServers) ? mgr.connectedServers.length : this.mcpInfo().connectedServers.length;
		const cur = this.#currentModel();
		return {
			started: this.started,
			cwd: this.#cwd,
			approvalMode: "always-ask",
			model: cur?.id ?? null,
			provider: cur?.provider ?? null,
			api: cur?.api ?? null,
			mcp: { servers: serverCount, tools: toolCount },
		};
	}

	/** The model picker: the current model + every auth-configured chat model omp
	 *  can switch to (modelRegistry.getAvailable — only providers with credentials). */
	listModels(): { started: boolean; current: ModelDTO | null; models: Array<ModelDTO & { current: boolean }> } {
		const cur = this.#session?.model;
		const avail: any[] = this.#session?.modelRegistry?.getAvailable ? this.#session.modelRegistry.getAvailable() : [];
		const models = avail.map((m: any) => ({
			id: m.id,
			name: m.name ?? m.id,
			provider: m.provider,
			api: m.api ?? null,
			contextWindow: m.contextWindow ?? null,
			current: !!cur && cur.provider === m.provider && cur.id === m.id,
		}));
		return { started: this.started, current: this.#currentModel(), models };
	}

	/** Switch the session's model. Resolves against the live available set by exact
	 *  provider+id (the DTOs the picker handed the browser), then calls the public
	 *  session.setModel. An operator control on their own session — not an agent
	 *  tool call — so it does not pass through the approval gate; it logs a notice. */
	async setModelByRef(provider: string, id: string): Promise<{ switched: boolean; current: ModelDTO | null; error?: string }> {
		if (!this.#session) return { switched: false, current: null, error: "session not started" };
		const avail: any[] = this.#session.modelRegistry?.getAvailable ? this.#session.modelRegistry.getAvailable() : [];
		const found = avail.find((m: any) => m.provider === provider && m.id === id);
		if (!found) return { switched: false, current: this.#currentModel(), error: `model ${provider}/${id} is not available` };
		const res = await this.#session.setModel(found);
		this.#lastModel = found.id;
		this.#lastProvider = found.provider;
		this.#lastApi = found.api ?? undefined;
		this.broadcast({ type: "notice", level: "info", message: `model → ${found.provider}/${found.id}` });
		return { switched: !!res?.switched, current: this.#currentModel() };
	}

	async dispose(): Promise<void> {
		this.#unsub?.();
		this.pending.rejectAll("deny"); // fail-closed: any parked approval → deny
		await this.#session?.dispose();
	}
}
