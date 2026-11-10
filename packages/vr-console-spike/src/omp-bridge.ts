/**
 * omp-bridge: embed the omp SDK in-process and expose a tiny prompt/event API.
 *
 * This is the Phase 0 analog of how ARTEX consumes the `norma` harness: we call
 * omp's own `createAgentSession()` and relay its event stream outward, rather
 * than reimplementing an agent loop. omp itself is untouched.
 *
 * Grounded in real omp source (this checkout):
 *   - createAgentSession        packages/coding-agent/src/sdk.ts:1945
 *   - session.subscribe         packages/coding-agent/src/session/agent-session.ts:6014
 *   - session.prompt            used at packages/coding-agent/src/modes/print-mode.ts:485
 *   - MCP readiness wait        packages/coding-agent/src/modes/print-mode.ts:405-419
 *     (mcpManager.waitForStartup(timeoutMs) + session.refreshMCPTools(mcpManager.getTools()))
 *   - SessionManager.inMemory   packages/coding-agent/src/thread/worker-warm-up.ts:47
 */
import { createAgentSession, SessionManager, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { shapeEvent } from "./event-shape";

export type Broadcast = (frame: unknown) => void;

/** How long to wait for MCP servers to connect before the first prompt. */
const MCP_STARTUP_TIMEOUT_MS = 30_000;

export interface Bridge {
	/** Send a user turn; resolves when the turn settles. */
	prompt(text: string): Promise<unknown>;
	/** Tear the session down cleanly. */
	dispose(): Promise<void>;
}

export async function startBridge(cwd: string, broadcast: Broadcast): Promise<Bridge> {
	broadcast({ type: "notice", level: "info", message: `creating agent session (cwd=${cwd})` });

	// NOTE: authStorage / modelRegistry / settings / model default from omp's
	// own on-host config (discoverAuthStorage + discoverModels). If session
	// creation fails resolving a model or settings, pass them explicitly — see
	// the pattern in packages/coding-agent/src/commit/agentic/agent.ts.
	const { session, mcpManager } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd), // no on-disk session writes for the spike
		enableMCP: true,
		enableLsp: false,
		hasUI: false,
		cacheWarming: false,
		// SPIKE ONLY. Auto-approves every tool call. See README safety note —
		// never point this at a task that mutates lab/VM state. Phase 1 replaces
		// this with the real approval seam (setToolUIContext / request_permission).
		autoApprove: true,
	});

	// Relay every session event to the browser, shaped to avoid payload bloat.
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		broadcast(shapeEvent(event));
	});

	// Do NOT prompt before MCP servers are ready, or tool calls will fail.
	if (mcpManager) {
		broadcast({ type: "notice", level: "info", message: "waiting for MCP servers…" });
		try {
			await mcpManager.waitForStartup(MCP_STARTUP_TIMEOUT_MS);
			await session.refreshMCPTools(mcpManager.getTools());
			broadcast({ type: "notice", level: "info", message: "MCP servers ready" });
		} catch (err) {
			broadcast({ type: "notice", level: "warn", message: `MCP startup issue: ${String(err)}` });
		}
	}

	return {
		prompt(text: string) {
			return session.prompt(text);
		},
		async dispose() {
			unsubscribe();
			await session.dispose();
		},
	};
}
