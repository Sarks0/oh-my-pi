# Phase 0 Spike — VR Console on the omp SDK

**Status:** plan (uncommitted). **Branch:** `raven/gracious-bohr-z8xqrx`.
**Repo:** `sarks0/oh-my-pi` (this fork).

> Goal of Phase 0: prove the one load-bearing assumption behind the whole VR
> Console idea — that an external TypeScript process can **embed the omp SDK
> in-process**, run a real agent session headlessly, **stream its events to a
> browser over WebSocket**, take a prompt back, and watch a tool call execute
> (including a vr-lab MCP tool). Everything else — DB, auth, graphs, approval
> UX, multi-campaign — is deliberately out of scope until this seam is proven.

This is the TS/Bun analog of how ARTEX embeds `norma` in Go: the console
*consumes* omp's agent primitives rather than reimplementing them. omp itself is
**not modified** — the spike is a new workspace package beside it.

---

## 1. Success criteria (the falsifiable bar)

Phase 0 is done when every box is ticked:

- [ ] A new Bun process starts, serves a static page, and accepts a WS connection.
- [ ] It creates **one** `AgentSession` via `createAgentSession()` with `cwd` set
      to a working directory.
- [ ] MCP servers discovered from that `cwd` **finish connecting before the first
      prompt** (logged).
- [ ] A prompt typed in the browser reaches the agent via `session.prompt()`.
- [ ] Assistant message **deltas stream live** to the browser (not just the final
      answer).
- [ ] At least one **tool call** (ideally a vr-lab MCP read, e.g. `notes-mcp`
      `target_history` or a `campaign-mcp` surface read) appears in the browser log.
- [ ] `turn_end` / `agent_end` are observed; `session.dispose()` on shutdown is clean.
- [ ] **Stretch:** one tool approval is surfaced to the browser as a card and
      answered from the browser, instead of being auto-approved.

If the in-process embed turns out to be impractical (native-addon conflicts,
event bus not externally observable, MCP lifecycle unmanageable from outside),
Phase 0 has done its job: we fall back to the `omp --mode rpc` subprocess seam
(ships Go + Python SDKs) and the rest of the roadmap is unchanged above the
transport line.

## 2. Explicitly NOT in Phase 0

No Postgres, no projection sync, no auth/login, no multi-session orchestration,
no planner/worker engine, no coverage graph, no findings board, no real
approval policy, no scope-guard UI. Approvals are **auto-approved** (see §7) and
the UI is a single debug page. These are Phase 1+.

## 3. Where it lives

```
packages/vr-console-spike/          <- new workspace package in the omp fork
  package.json
  src/
    server.ts                       <- Bun.serve: static page + /ws WebSocket
    omp-bridge.ts                   <- embeds the omp SDK; one session; event fan-out
    event-shape.ts                  <- adapted copy of print-mode's printableEvent()
  public/
    index.html                      <- prompt box + live event log + (stretch) approve button
  README.md
```

Why a workspace package (not a separate repo): it imports
`@oh-my-pi/pi-coding-agent` directly as a **workspace dependency** (no publish
step), reuses omp's Bun toolchain and native addon, and literally "enhances omp"
rather than wrapping it from outside. This is the same package that later grows
into `packages/vr-console-server`.

## 4. The grounded SDK surface (verified against source)

All references are to this checkout (`packages/coding-agent/src/...`):

| Call | Where | Notes |
|---|---|---|
| `createAgentSession(options)` | `sdk.ts:1945` | returns `{ session, mcpManager, eventBus, setToolUIContext, ... }` (`sdk.ts:1036`) |
| `CreateAgentSessionOptions` | `sdk.ts:581` | `cwd`, `agentDir`, `model`, `authStorage`, `modelRegistry`, … |
| `session.subscribe(listener)` | `agent-session.ts:6014` | returns an unsubscribe `() => void` |
| `session.prompt(text, { images? })` | used at `print-mode.ts:485` | awaitable; resolves when the turn settles |
| `session.dispose({ reason })` | used at `print-mode.ts` shutdown | drains + tears down cleanly |
| `AgentSessionEvent` union | shaped in `printableEvent` `print-mode.ts:85` | `message_start/update/end`, `turn_end`, `agent_end`, `tool_execution_start/update`, `tool_stream_update`, `notice`, `queue_update`, … |
| `autoApprove` posture | `agent-session-types.ts:207`, consumed `agent-session.ts:2661` | set a permissive posture for the spike (verify exact wiring — see §7) |
| `setToolUIContext(uiContext, hasUI)` | `sdk.ts:1036` (result field) | **Phase 1** approval/tool-card seam; the same one rpc-ui uses |
| MCP readiness wait | `print-mode.ts` (`mcpManager` + `resolveMCPTimeoutMs`) | "only print mode waits for its servers" — copy that wait before the first prompt |

**Reference driver to read first:** `packages/coding-agent/src/modes/print-mode.ts`
is the smallest existing headless driver (`omp -p`). `runPrintMode(session, …)`
shows the exact subscribe → prompt → drain → dispose lifecycle. The spike is
essentially `runPrintMode` with the output redirected to a WebSocket instead of
stdout.

## 5. Architecture of the spike

```
Browser (1 static page)
   |  WebSocket (JSON frames)
   v
vr-console-spike server (Bun)
   |  in-process import
   v
omp AgentSession  (createAgentSession, cwd = a vr-lab campaign dir)
   |  MCP client (auto-discovered from cwd/.mcp.json/.claude)
   v
vr-lab MCP servers (campaign-mcp, notes-mcp, ...)  — on the Kali host
```

One browser, one WS, one session, one cwd. The server is a thin bridge: browser
frames → `session.prompt()`; `session.subscribe` events → shaped JSON → browser.

## 6. Build steps

### Step 1 — scaffold the package
- Add `packages/vr-console-spike/package.json` with a workspace dep on
  `@oh-my-pi/pi-coding-agent` and a `bin`/script entry `omp-vr-spike`.
- Confirm it resolves in the Bun workspace (`bun install` at repo root).

### Step 2 — `src/omp-bridge.ts` (the harness embed)
Grounded sketch (names are real; types to confirm against source):

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { shapeEvent } from "./event-shape";

export type Broadcast = (frame: unknown) => void;

export async function startBridge(cwd: string, broadcast: Broadcast) {
  const { session, mcpManager } = await createAgentSession({
    cwd,
    // autoApprove: true,  // see §7 — confirm exact wiring (settings vs option vs context)
  });

  // Stream every session event to the browser, shaped to avoid payload bloat.
  const unsubscribe = session.subscribe(event => broadcast(shapeEvent(event)));

  // Do NOT prompt before MCP servers are ready. Mirror runPrintMode's wait:
  // see print-mode.ts use of `mcpManager` + resolveMCPTimeoutMs.
  if (mcpManager) {
    broadcast({ type: "notice", message: "waiting for MCP servers…" });
    // await <mcpManager readiness, as print-mode does>;
    broadcast({ type: "notice", message: "MCP servers ready" });
  }

  return {
    prompt: (text: string) => session.prompt(text),           // awaitable
    dispose: () => { unsubscribe(); return session.dispose({ reason: "shutdown" }); },
  };
}
```

### Step 3 — `src/event-shape.ts`
Copy and trim `printableEvent()` from `print-mode.ts:85`. It drops
`message_update` snapshots (keep only the incremental delta) and strips
`providerPayload`. **This is not optional** — without it a single long turn
re-serializes its whole in-progress message on every delta (the omp authors hit
multi-GB transcripts; see the comment at `print-mode.ts:78`). `printableEvent`
may not be re-exported from the package index, so copy the logic rather than
import it.

### Step 4 — `src/server.ts` (Bun transport)
Grounded sketch:

```ts
import { startBridge } from "./omp-bridge";

const CAMPAIGN_CWD = process.env.VR_SPIKE_CWD ?? process.cwd();
const sockets = new Set<WebSocket>();
const broadcast = (frame: unknown) => {
  const s = JSON.stringify(frame);
  for (const ws of sockets) ws.send(s);
};

const bridge = await startBridge(CAMPAIGN_CWD, broadcast);

Bun.serve({
  port: Number(process.env.PORT ?? 8799),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && server.upgrade(req)) return;
    if (url.pathname === "/") return new Response(Bun.file("packages/vr-console-spike/public/index.html"));
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { sockets.add(ws); },
    close(ws) { sockets.delete(ws); },
    async message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.type === "prompt") await bridge.prompt(msg.text);
      // Phase 1: if (msg.type === "approve") -> resolve a pending approval
    },
  },
});

process.on("SIGINT", async () => { await bridge.dispose(); process.exit(0); });
```

### Step 5 — `public/index.html`
Minimal: a WS connection to `/ws`, an append-only `<pre>` event log (render
`message_update` deltas, `tool_execution_start` names, `notice` lines), a prompt
`<input>` that sends `{type:"prompt",text}`, and a disabled "Approve" button
placeholder for the stretch goal.

### Step 6 — run it against a real (but SAFE) task
1. First smoke test with `VR_SPIKE_CWD` = a throwaway empty dir (no vr-lab MCP) and
   a trivial prompt ("say hi") to prove the loop in isolation.
2. Then point `VR_SPIKE_CWD` at a real vr-lab campaign dir **on the Kali host** and
   drive a **read-only** task — e.g. "summarise the surfaces recorded in this
   campaign" (hits `campaign-mcp`) or a `notes-mcp` `target_history` query. Watch
   the MCP tool call appear in the browser log.

## 7. Permission posture & SAFETY (read before running on the host)

For Phase 0, run with an auto-approving ("yolo") posture so you don't have to
build the approval UX yet (`resolveApproval(tool, args, "yolo", …)` at
`agent-session.ts:5809`; `autoApprove` at `agent-session-types.ts:207`). **Confirm
the exact wiring** — `autoApprove` is read from the session config/context, so it
may be passed through settings or the session context rather than as a direct
`createAgentSession` option.

**Safety:** a vr-lab agent with auto-approve can execute real tools against real
infrastructure — WinRM to canary/torpedo, fuzzing, Ghidra, Proxmox. Do **not**
point the spike at a task that mutates VM state while auto-approving. Phase 0's
real-MCP test must be a **read-only** campaign/notes query. The whole reason the
real product needs the approval seam (`setToolUIContext` + `extension_ui_request`
frames, Phase 1) is so a human gates anything that touches the lab.

## 8. What Phase 0 decides / produces

- **Decision:** in-process SDK embed is viable → Option B path; if not → fall back
  to `omp --mode rpc` subprocess (no roadmap change above the transport line).
- **Measurements:** MCP connect time, memory of one Bun process holding one agent
  + MCP servers, event throughput over WS.
- **Artifact:** the WS JSON frame schema (shaped events + `prompt`/`approve`
  client messages) becomes the **contract** the real `vr-console-web` renders
  against.
- **Surfaces the approval seam shape** for Phase 1 (how `setToolUIContext` /
  permission requests present).

## 9. Risks & gotchas (grounded)

- **Prompt-before-MCP-ready** → tool calls fail; always await `mcpManager`
  readiness first (print-mode does).
- **Event payload bloat** → must shape events (`event-shape.ts`); do not forward
  raw `AgentSessionEvent`.
- **Auto-approve on a live VR host** → read-only task only (see §7).
- **Single-writer session lease** → fine for one session; becomes a real
  constraint at Phase 3 concurrency.
- **Bun-only** for in-process embed → the spike server must run on Bun/Node (same
  runtime as omp). Fine; it's where we want the console-server anyway.
- **Model/auth must already be configured in omp** → the spike reuses omp's
  `discoverAuthStorage()` / existing login; pick a cheap model for the smoke test.

## 10. Rough effort

~1–2 days for the core loop (steps 1–5) + ~0.5 day to wire a real campaign cwd
and confirm an MCP tool call end-to-end (step 6). Stretch approval card: +0.5 day.

---

*Appendix — key files to read in the omp source before starting:*
`packages/coding-agent/src/modes/print-mode.ts` (the reference driver),
`packages/coding-agent/src/sdk.ts` (`createAgentSession`, options/result),
`packages/coding-agent/src/session/agent-session.ts` (`subscribe`, lifecycle),
`packages/coding-agent/src/session/agent-session-types.ts` (`autoApprove`).
