## 2. Backend Service — `vr-console-server`

A Bun/TS workspace package that embeds the omp Node SDK **in-process** and adds the
HTTP + WebSocket transport omp does not ship. It is the TS/Bun analog of the ARTEX
Go `server/` built on `norma`: it *consumes* omp's agent primitives (`createAgentSession`
/ `session.subscribe` / `session.prompt` / `session.dispose` / `mcpManager`) rather than
reimplementing an agent loop, and drives an ARTEX-style planner→worker engine over vr-lab
campaigns. omp stays unchanged (HARD CONSTRAINT 6); this is additive, and consumed as a
**pinned** workspace dependency — the root catalog pins `@oh-my-pi/pi-coding-agent` to
`18.18.6` (`oh-my-pi/package.json:23`), satisfying the build-local/pin discipline of
HARD CONSTRAINT 5 (ARTEX backdoor lesson).

### 2.1 Module layout

```
packages/vr-console-server/
  src/
    index.ts              bootstrap: config, DB pool, engine, http+ws server
    adapter/
      omp-adapter.ts      OmpSessionAdapter — the norma-equivalent in-process wrapper
      event-shape.ts      promoted from vr-console-spike/src/event-shape.ts
      rpc-adapter.ts      subprocess fallback (omp --mode rpc-ui) — same interface
    engine/
      engine.ts           planner→worker orchestration (analog of artex engine.go)
      campaign.ts         per-campaign runtime: session, cwd lease, state machine
      broadcast.ts        per-campaign pub/sub (analog of artex broadcast.go)
      lifecycle.ts        launch/pause/resume/abort transitions
    http/
      routes.ts           REST surface (Bun.serve fetch router)
      ws.ts               WebSocket upgrade + frame protocol
    approval/
      gate-broker.ts      maps omp approval requests ↔ WS approve frames
    db/                   projection store (campaigns, sessions, event cursor)
  package.json            workspace dep "@oh-my-pi/pi-coding-agent": "catalog:"
```

The spike (`packages/vr-console-spike`) is the seed: `server.ts` and `omp-bridge.ts`
grow into `http/` and `adapter/`; `event-shape.ts` is promoted verbatim. The spike's
`package.json` already wires the dependency as `"@oh-my-pi/pi-coding-agent": "catalog:"`
(`vr-console-spike/package.json:14`); `vr-console-server` copies that line.

### 2.2 The omp adapter layer (`OmpSessionAdapter`)

Wraps exactly the verified SDK surface. `createAgentSession(options)`
(`sdk.ts:1945`; options iface `CreateAgentSessionOptions` `sdk.ts:581`) returns
`CreateAgentSessionResult` (`sdk.ts:1036`) — `{ session, extensionsResult, setToolUIContext,
mcpManager?, eventBus, ... }`. `subscribe` / `prompt` / `dispose` are methods on the returned
`session` (`AgentSession`), **not** top-level fields of the result.

```ts
interface SessionAdapter {
  readonly id: string;
  subscribe(fn: (e: ShapedEvent) => void): () => void;         // session.subscribe  agent-session.ts:6014
  prompt(text: string, opts?: PromptOptions): Promise<boolean>; // session.prompt     agent-session.ts:8633 (PromptOptions agent-session-types.ts:443)
  abort(opts?: AbortOptions): Promise<void>;                    // session.abort      agent-session.ts:12100
  dispose(opts?: AgentSessionDisposeOptions): Promise<void>;    // session.dispose    agent-session.ts:6656
  setUIContext(ctx: ExtensionUIContext, hasUI: boolean): void;  // setToolUIContext   sdk.ts:1042 (ExtensionUIContext extensibility/extensions/types.ts:332)
}
```

`OmpSessionAdapter.create(cwd, opts)` mirrors the proven lifecycle of `runPrintMode`
(`modes/print-mode.ts`) and the Phase-0 bridge (`omp-bridge.ts`): create session →
`session.subscribe` (`omp-bridge.ts:52`) → **await MCP readiness before the first prompt**.
Readiness is `await mcpManager.waitForStartup(timeoutMs)` (`mcp/manager.ts:1398`) then
`session.refreshMCPTools(mcpManager.getTools())` (`print-mode.ts:413-419`;
`omp-bridge.ts:60-61`). Prompting before servers connect makes tool calls fail (spike
`omp-bridge.ts:56` comment; README safety note). `waitForStartup` resolves an
`MCPStartupStatus` = `{ connected: string[]; pending: string[]; failed: Array<{ name; error }> }`
(`mcp/manager.ts:251`): `connected` seeds a ready notice, `pending`/`failed` become `notice`
frames naming each unavailable server (the print-mode pattern at `print-mode.ts:420-431`).

Each event passes through `shapeEvent()` (`adapter/event-shape.ts`, copied from the
non-exported `printableEvent()` at `print-mode.ts:88`). It drops the `message_update`
snapshot — keeping only the incremental delta by stripping `assistantMessageEvent.partial`
(`event-shape.ts:34-44`); the authoritative message arrives in `message_end` — and strips
`providerPayload` from message/turn/agent frames (`event-shape.ts:20-23,45-55`). This is
**not optional**: raw forwarding re-serializes the whole in-progress message per delta and
produced multi-GB transcripts upstream (`print-mode.ts:80-86`; `event-shape.ts:6-15`).

`rpc-adapter.ts` implements the *same* `SessionAdapter` interface over a subprocess. omp's
`--mode` accepts `text | json | rpc | acp | rpc-ui` (`commands/launch-help.ts:53-54`), a
JSON-stdin/stdout protocol (`modes/rpc/rpc-mode.ts:1-13`). The fallback adapter drives
**`--mode rpc-ui`**, not plain `rpc`: rpc-ui is the variant whose tool UI stays enabled
(`launch-help.ts:130`), i.e. the one that emits `extension_ui_request` approval frames the
broker needs. `prompt` writes a `{ type:"prompt"; message; images? }` frame
(`rpc-types.ts:53`); events arrive as `AgentSessionEvent` on stdout; abort rides an
`{ type:"abort" }` / `{ type:"abort_and_restore_queue" }` frame (`rpc-types.ts:58,60`);
approvals ride `extension_ui_request` / `extension_ui_response` (`rpc-types.ts:792`
`RpcExtensionUIRequest`; `:975` `RpcExtensionUIResponse`; guard at `rpc-mode.ts:391`). This
is the fallback (HARD CONSTRAINT 3/4: isolation and scale) and the cross-host broker: the
engine is adapter-agnostic.

### 2.3 Orchestration engine (`engine.ts`)

Analog of ARTEX `server/engine.go`: an event-driven planner→worker loop, but driving omp
sessions instead of `norma` planner/worker pairs. Per campaign the engine runs **one
planner loop + N worker loops**, like `engine.go`'s `plannerLoop` + N `workerLoop`
goroutines started in `Run` (`engine.go:767-770`). Because an omp session is
**single-writer per cwd** — the `SessionManager` holds a per-cwd writer lease; the spike
sidesteps it with `SessionManager.inMemory(cwd)` for an ephemeral, non-persisting session
(`omp-bridge.ts:40`) — each worker slot gets its **own `SessionAdapter` with its own cwd**
(a distinct campaign sub-directory or a VM-scoped work dir); concurrency is multiple
adapters, never two writers on one cwd (HARD CONSTRAINT 4).

The planner is itself an omp session prompted with a planning template that reads campaign
state (surfaces, hallucinations, open gates) via the **portable** MCP tools and emits
*intents*. The engine, not the model, owns scheduling: a debounced wake (ARTEX coalesces a
burst into one round via an 800 ms debounce — field `engine.go:95`, default `engine.go:394`)
fires on campaign-FS change or worker completion; a heartbeat timer bounds idle
(`plannerLoop` arms it at `engine.go:825`). Worker course-correction uses a steer queue
drained before the next tool call, exactly ARTEX's `steerBox` + `PreToolUse` pattern
(`engine.go:135`, `582`).

```
 FS/MCP change ─┐           ┌─ worker slot 1 (adapter, cwd=campaign/work-1)
 worker done  ──┼─► planner ┼─ worker slot 2 (adapter, cwd=campaign/work-2)
 heartbeat    ──┘  (round)  └─ worker slot N
       │                         │  shaped events
       └──────── broadcast ◄──────┘  ─► WS clients
```

### 2.4 Session / campaign lifecycle (`lifecycle.ts`, `campaign.ts`)

A `CampaignRuntime` holds its adapters, cwd leases, broadcaster, and a status
(`idle|planning|working|paused|aborting|done`). Transitions mirror ARTEX
`applyTaskControl` (`task_control.go:92`):

- **launch** — resolve campaign cwd, acquire cwd lease, build planner adapter, await MCP,
  start the planner + worker loops; skip the first planner round when a seed intent already
  exists so the worker runs it directly (ARTEX `Run` + skip-first-round guard,
  `engine.go:752`, `772-776`).
- **pause** — stop scheduling and cancel in-flight worker prompts. **In-process** that is
  `session.abort({ reason, deliverQueuedMessages })` (`agent-session.ts:12100`), which
  interrupts the active turn while the loop stays alive; the `abort`/`abort_and_restore_queue`
  *frames* (`rpc-types.ts:58,60`) are the **subprocess** analog. Matches ARTEX `Pause`
  (`engine.go:182`, `task_control.go:102`).
- **resume** — re-admit and re-arm the scheduler (ARTEX `Resume` `engine.go:310`,
  `task_control.go:138`).
- **abort** — cancel all workers, `adapter.dispose()` each, release leases, persist final
  state (ARTEX `AbortDelete` `engine.go:203`).

`dispose()` drains and tears down cleanly (`agent-session.ts:6656`); the spike validated a
clean `unsubscribe()` + `session.dispose()` on shutdown (`omp-bridge.ts:72-75`,
`server.ts:89-95`).

### 2.5 HTTP REST surface

Served by `Bun.serve` (`http/routes.ts`), ARTEX's `/api` naming adapted to campaigns
(ARTEX `tasks` = campaigns; route table `server.go:713-836`). **Portable tier only** — the
console never runs host-bound tools (HARD CONSTRAINT 3).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | build + LLM-readiness (ARTEX `server.go:718`) |
| GET/POST | `/api/campaigns` | list / launch a campaign runtime (ARTEX `server.go:724-725`) |
| GET | `/api/campaigns/{id}` | status, adapters, cwd, cost |
| POST | `/api/campaigns/{id}/control` | `{action: pause\|resume\|abort}` (`task_control.go:92`) |
| POST | `/api/campaigns/{id}/prompt` | inject a user turn to planner/worker |
| GET | `/api/campaigns/{id}/surfaces` | surface census (read campaign-mcp records) |
| GET | `/api/campaigns/{id}/findings` | findings + hallucinations (DISPLAY only) |
| GET | `/api/campaigns/{id}/gates` | gate status per finding (read-only) |
| POST | `/api/campaigns/{id}/gates/request` | **request** a `finding_promote` on the host; never fakes it |
| GET | `/api/campaigns/{id}/activity` | paginated event history (cursor) |
| POST | `/api/approvals/{id}` | resolve a pending tool approval |

**Gate authority stays on the host FS (campaign-mcp)** — HARD CONSTRAINT 1. The console's
only write into gate state is to prompt the Kali-host omp session to *attempt*
`finding_promote`; the endpoint returns the host's refusal verbatim when a required gate or
on-disk evidence is missing. No endpoint mutates `findings/`, `hallucinations/`, or
`evidence/` directly — the promotion machinery and its gate checks live entirely in
campaign-mcp on the host, reached only through an omp tool call.

### 2.6 WebSocket event protocol (`http/ws.ts`)

Builds on the shaped `AgentSessionEvent` frames validated in Phase 0 (`event-shape.ts`).
One WS per client; subscription is per-campaign (ARTEX `Broadcaster.Subscribe(task)` —
`broadcast.go:24`).

**Server→client frames** (envelope adds routing + ordering the spike's flat frames lacked):

```jsonc
{ "v":1, "campaignId":"c-123", "seq": 4217, "frame": <ShapedEvent> }
```

`frame` is the shaped `AgentSessionEvent` union (authoritative definition at
`session/agent-session-events.ts:14`; the `message_*` / `turn_*` / `tool_execution_*` /
`tool_stream_update` / `agent_*` members come from the underlying `AgentEvent`, the
session-level members — `notice`, `queue_update`, `goal_updated`, `model_changed`,
`advisor_cost_changed` — are added here). Each frame is shaped by `shapeEvent()`
(`event-shape.ts:30`, copied from `printableEvent` `print-mode.ts:88`) so deltas stay small.
Console-synthesized frames reuse the envelope: `approval_request` (from an omp
`extension_ui_request` — the relevant methods are `confirm` / `select` / `input` / `editor`
/ `ask` in `RpcExtensionUIRequest`, `rpc-types.ts:792`), `campaign_status`, `engine_round`.

**Client→server frames**: `{type:"prompt",campaignId,text}` (the console's own WS protocol;
spike uses `text` at `server.ts:73`), `{type:"approve",id,decision}` (spike's reserved
Phase-1 slot, `server.ts:81`), `{type:"subscribe",campaignId}`,
`{type:"control",campaignId,action}`.

`seq` is a monotonic per-campaign cursor so a reconnecting client replays the gap from the
activity store. This is ARTEX's drop-and-catch-up exactly: `Broadcaster.Publish` is
non-blocking — a full subscriber buffer (256-deep channel, `broadcast.go:25`) drops the
event rather than stalling the engine, and the client reconnects with its last `seq` cursor
and catches the gap up from the DB (`broadcast.go:49-65`).

### 2.7 Approval seam (`approval/gate-broker.ts`)

Phase 0 ran `autoApprove` (`agent-session-types.ts:207`, also on `CreateAgentSessionOptions`
`sdk.ts:1024`; set at `omp-bridge.ts:48`) — **spike-only**, explicitly unsafe on a live lab
(spike README "Safety"): an auto-approving vr-lab agent can execute WinRM, Ghidra, Proxmox
and fuzzing against real infrastructure. Production replaces it with `setToolUIContext`
(`sdk.ts:1042`), which installs an `ExtensionUIContext` (`extensibility/extensions/types.ts:332`).
The real approval method on that context is **`approve(prompt, dialogOptions?)`**, returning
an `ExtensionApprovalAnswer` — approve / deny / session-scoped grant (`types.ts:363-375`); it
is the dedicated tool-approval seam, richer than the generic `confirm`/`select` the adapter
also supplies. Each `approve` request surfaces as an `approval_request` WS frame; the
browser's `approve` frame resolves the awaiting promise. In the **subprocess** adapter the
same flow rides `extension_ui_request` / `extension_ui_response` under `--mode rpc-ui`
(`rpc-types.ts:792`, `:975`; mode at `launch-help.ts:54,130`). This is the human gate for
anything touching the host-bound tier (WinRM, Ghidra, fuzz, Proxmox).

### 2.8 Constraint enforcement summary

1. **Gate authority on host FS** — console only DISPLAYs/REQUESTs; promotion and gate checks
   stay in campaign-mcp, reached through an omp tool call (§2.5).
2. **Local-only kb-RAG; no research content leaves** — the console sends only prompts and
   portable-tier metadata, never binaries/decompiles, over WS or to any API.
3. **Host-bound tier brokered** via the Kali-host omp adapter (in-process on the host, or
   `--mode rpc-ui` subprocess) — the server never execs WinRM/Ghidra/fuzz itself (§2.2).
4. **Single-writer leases** — one adapter per cwd; concurrency = N adapters (§2.3).
5. **Build-local + pinned deps** — `@oh-my-pi/pi-coding-agent` pinned at `18.18.6` via
   `catalog:`; no third-party images (ARTEX backdoor lesson).
6. **omp unchanged** — additive package only.
7. **Phase 0 proven** — this design extends the validated in-process embed + WS seam
   (`vr-console-spike`).

**Open questions:** whether cross-host brokering uses one rpc-ui adapter per remote host or
a thin relay multiplexing several; the projection-store schema (deferred to the DB section);
exact back-pressure/replay bound on the activity store (ARTEX re-reads from Postgres —
the console's store choice is deferred to the DB section). The `ExtensionUIContext` shape is
now resolved against the source (`extensibility/extensions/types.ts:332`, `approve()` at
`:363`), so the broker can be coded directly against `ExtensionApprovalPrompt` /
`ExtensionApprovalAnswer`.
