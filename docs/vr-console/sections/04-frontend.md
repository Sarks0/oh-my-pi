## 4. Frontend — `vr-console-web`

`packages/vr-console-web` is a Next.js app adapted from ARTEX `web/`. It keeps ARTEX's
stack verbatim and re-skins its view set from "web pentest over an asset graph" to
"binary VR over a campaign/surface/gate model". It talks only to `vr-console-server`
(§2/§3); omp stays unchanged (constraint 6).

Every file reference below is to the three on-disk repos: `artex/web/...`,
`oh-my-pi/packages/coding-agent/...`, `vr-lab/...`.

## 4.1 Stack (inherited from ARTEX, unchanged)

From `artex/web/package.json` (verified): Next `^16.2.9`, React `^19.2.7`, shadcn/ui on
`radix-ui ^1.6.0` + `@base-ui/react ^1.6.0` primitives, Tailwind `^4`, `@antv/g6 ^5.1.1`
+ `@antv/graphin ^3.0.5` + `@xyflow/react ^12.3` for graphs, `recharts ^3.8` for charts,
`zustand ^5` for client state, `react-markdown ^10.1` + `remark-gfm ^4` for agent/report
rendering, `sonner ^2` for toasts, `react-hook-form ^7.80` + `zod ^4` for config forms,
`react-resizable-panels ^4.12` for split panes (ARTEX wires it through
`components/ui/resizable.tsx` and `components/side-question-workspace.tsx`). No new
top-level deps are required.

> **Correction to the earlier draft.** `@tanstack/react-table ^8.21.3` is declared in
> `artex/web/package.json` but is **not imported anywhere under `artex/web/src`**
> (verified: zero hits for `@tanstack/react-table` / `useReactTable`). ARTEX's tables —
> including the findings table — are built on the shadcn `@/components/ui/table`
> primitive, not on `@tanstack/react-table`. §4.3 is corrected accordingly. Do not plan
> boards around a library ARTEX does not actually use.

App Router layout is reused directly: `app/(auth)/{login,setup}/page.tsx`,
`app/(main)/{dashboard,chat,function/*,system/*}/...`, `app/(external)/page.tsx` (all
present under `artex/web/src/app/`).

## 4.2 Information architecture (sidebar)

Remap `artex/web/src/navigation/sidebar/sidebar-items.ts`. ARTEX ships exactly two
`NavGroup`s — `{id:1, label:"Functions"}` and `{id:2, label:"System"}`
(`sidebar-items.ts:66-101`). Proposed VR-Console remap (ARTEX item → VR Console item):

```
Functions (group 1)                 System (group 2)
  Dashboard      (reuse)              LLM            (reuse system/llm)
  HITL Chat      (reuse chat)         Agent          (reuse system/agents)
  Campaigns      (<- tasks)           MCP            (reuse system/mcp)
  Findings+Gates (<- findings)        Skills (vr-*)  (reuse system/skills)
  Surface Graph  (<- assets)          Tools          (reuse system/tools)
  Evidence       (<- traffic)         Vault          (reuse system/vault)
  Tool Exec      (reuse commands)     Approval Recs  (reuse intercept/approvals)
  LLM Recording  (reuse llm-records)  Scope + Prog.  (<- out-of-scope + sync)
  Prior-art/kb   (NEW)                Logs/Settings  (reuse)
```

ARTEX already carries an `approvals` item (`"Approval Records"`,
`/system/intercept/approvals`, `sidebar-items.ts:97`) and an `out-of-scope` item
(`sidebar-items.ts:96`); both are reused directly. "Campaign" replaces ARTEX "task"
throughout — ARTEX's own route tree already treats a task as a campaign-shaped object
(the per-task detail shell carries the whole campaign workspace, §4.3).

## 4.3 Views (grounded in the ARTEX originals)

**Dashboard** (`app/(main)/dashboard/page.tsx`) — recharts tiles. ARTEX's dashboard
already renders a recharts `BarChart` of daily token data (`dashboard/page.tsx:17,803`);
re-aim the tiles at active campaigns, the LLM cost ledger (reuse `function/llm-records`
over `llm_usage`, §3 data model), and a live activity stream. The activity feed reuses
the live-subscribe model from the task-detail sessions tab
(`function/tasks/detail/_tabs/sessions-tab.tsx`), §4.5.

**Campaign workspace** — the ARTEX task-detail tab shell. The 11 real tab files are
`function/tasks/detail/_tabs/`: `overview-tab`, `sessions-tab`, `graph-tab`,
`coverage-graph-tab`, `findings-tab`, `intercept-tab`, `report-tab`, `retests-tab`,
`credentials-tab`, `assets-tab`, `broadcast-tab` (all verified on disk). Retabbed to:
**Overview** (campaign.yaml: platform profile, research contract, ROI/scope),
**Session** (live transcript, from `sessions-tab`), **Surface graph** (from
`coverage-graph-tab`), **Findings/Gates** (from `findings-tab`), **Approvals**,
**Evidence** (replaces `intercept`/traffic surfaces), **Report** (from `report-tab`).

A per-campaign **lease badge** signals constraint 4 (omp is single-writer per cwd). The
single-writer guarantee is the omp `SessionManager` ownership claim, not a UI invention:
`#sessionClaim` + `claimSession(sessionId, sessionFile)` hold this process's claim on the
session file and leave `release` unset while another live process holds it
(`packages/coding-agent/src/session/session-manager.ts:1060-1167`). The badge therefore
reflects **server-reported** lease ownership — the `vr-console-server` holds (or fails to
acquire) the lease for the campaign cwd and reports it over REST / a `notice` frame.
There is **no `session` event type** in the omp event union (`agent-session-events.ts`
has no `{type:"session"}` member), so the badge must not be wired to a non-existent frame;
the authority is the server's lease state. Where exactly it is surfaced is a §2/§3 seam.

**Findings board + gate tracker** — adapt `function/findings/_components/findings-table.tsx`.
It is built on the shadcn `@/components/ui/table` primitive
(`Table/TableBody/TableCell/TableHead/TableHeader/TableRow`, imported at
`findings-table.tsx:37`) with expandable rows keyed by `expandedKey`
(`findings-table.tsx:96-97,168`) and columns Severity · Vulnerability · Asset · Status ·
Task · Time · Actions (`findings-table.tsx:154-162`). **No `@tanstack/react-table`.**

Re-type the lifecycle: ARTEX's `FindingStatus` union
(`pending|in_progress|confirmed|resolved|fixed|false_positive|ignored|duplicate|risk_accepted`,
`lib/types.ts:473-482`) is replaced by the vr-lab lifecycle — a finding is **born** in
`hallucinations/` and leaves **only** via `finding_promote` (into `findings/`) or into
`rejected/` (`vr-lab/AGENTS.md:12-16` "Core rule": *All suspected vulnerabilities start
in `hallucinations/`. Never write directly to `findings/`. Never claim a finding is
validated unless `finding_promote` succeeds*).

Each row expands (reusing the existing expand mechanism) to a **gate tracker** — the six
Windows-profile required gates `gate0_poc_compiles`, `gate1a_canary_clean_repro`,
`gate2_security_impact`, `gate2b_severity_bar`, `gate3_privilege_context`,
`gate4_report_package` (`vr-lab/docs/validation-gates.md`; §§ at lines 31/41/124/162/370/445;
`gate2b` is **windows-only**, `validation-gates.md:164`). Each gate is a chip whose status
is drawn from the campaign-mcp vocabulary `ALLOWED_GATE_STATUSES = { not_started,
in_progress, passed, failed, blocked, not_applicable }`
(`vr-lab/mcp/campaign-mcp/campaign_mcp/gates.py:130-137`), seeded `not_started`
(`gates.py:166`), plus an evidence link.

**Constraint 1 is load-bearing here.** The tracker is strictly read-only over projected
host state. "Promote" and "Record gate" buttons do **not** write status — they compose an
agent instruction the server forwards as a `session.prompt` driving the host `campaign-mcp`
`finding_promote` / `gate_record` tool (`campaign-mcp/campaign_mcp/server.py:1150` /
`:1019`). Authority stays on the host FS: `gate_record` refuses a required gate that
passes with zero evidence, and `finding_promote` checks the evidence files are still on
disk (`vr-lab/AGENTS.md` "What the tools already refuse"). The UI can **display and
request** a promotion; it can never fake one. The platform profile
(`campaign.yaml platform: windows|chrome|linux|valve|vendor:<slug>`) selects which gate
set, labels and required-ness render (`validation-gates.md:5`), so the chip set is
profile-driven, not hardcoded to Windows.

**Surface/coverage graph** — reuse `coverage-graph-tab.tsx`. It builds an `@antv/g6`
`Graph` (`import type { Graph as G6Graph }`, dynamic `import("@antv/g6")` to dodge SSR,
`coverage-graph-tab.tsx:4,539`) over `CoverageGraphNode`/`CoverageGraphEdge`
(`lib/types.ts:289` — the `CoverageGraphNode` interface), with the `kindMeta` node
taxonomy `company|root_domain|subdomain|ip|service|app|endpoint`
(`coverage-graph-tab.tsx:39-47`; same union at `lib/types.ts:291`) and `FOLD_LIMIT = 20`
top-down cascading fold (`coverage-graph-tab.tsx:32,151`). Rebind the taxonomy to the
binary domain: **binary/module → function → sink/IOCTL/entry-point**, with **call-path
edges**. Reuse the `tested` / `in_scope` node flags **verbatim** (they already drive the
tested-highlight / grey-context rendering: `nodeFill`/`nodeStroke`,
`coverage-graph-tab.tsx:244-254`) as "analyzed" / "in Pass-0 census": the ARTEX coverage
idiom (tested-of-in-scope, overlaid on a force graph) maps exactly onto the vr-lab 4-pass
census denominator (`vr-lab/docs/binary-triage.md`). `@xyflow/react` (already in the
stack) stays available for a linear PoC→primitive→impact call-path view where the
force-directed g6 layout is the wrong idiom.

**HITL chat** (`app/(main)/chat/page.tsx`) + **Session transcript**
(`components/transcript.tsx`, driven from `sessions-tab.tsx`) — the live view, §4.5.

**Approval cards** — adapt `components/approval-execution-focus.tsx` +
`components/approval-records.tsx` (both present). **Note the adaptation:** ARTEX's
`ApprovalExecutionFocus` resolves a *persisted* intercept execution selected by an
`?approval=<id>` URL param via `api.interceptExecution(id)`
(`approval-execution-focus.tsx:19-44`) — it is a review surface over ARTEX's
rule-based interception model (`/intercept/rules`, `lib/api.ts:1299-1306`), not a live
grant/deny control. The VR Console needs **new wiring**: a card rendered inline in the
transcript when the server emits an approval-request frame on the omp tool-UI seam
(`setToolUIContext(uiContext, hasUI)`, the field on `CreateAgentSessionResult`,
`sdk.ts:1036` interface / `:1042` field; the same seam rpc-ui drives with
`extension_ui_request` frames). The card shows tool name + args; Approve/Deny sends a WS
frame that resolves the pending call. Phase 0 auto-approved instead
(`phase-0-spike.md §7`; `autoApprove` option `agent-session-types.ts:207`, consumed in
the yolo posture `agent-session.ts:5809`), so the exact approval-frame schema is still
open (§4.7, owned by §2/§3). Host-bound tools (WinRM, Ghidra, fuzz) surface here but
**execute on the Kali-host omp**, never in the console (constraint 3).

**Evidence viewer** (replaces ARTEX Traffic / `function/traffic`). Renders artifacts
brokered from the host evidence tier — Ghidra decompile text, WinDbg `!analyze -v`,
crash dumps/stack-hashes, PoC source + build log (`gate0`), per-gate `evidence/<gate>/`
files. `react-markdown` for text; read-only file fetch via a workspace read endpoint,
the analog of ARTEX `GET /api/workspace/read → s.wsRead` (`artex/server/server.go:769`).
The console never runs the tools (constraint 3) and never ships binaries or decompiles
off-host (constraint 2).

**MCP / Agent / LLM config, Scope + Programme, Prior-art/kb** — reuse `system/mcp`,
`system/agents`, `system/llm`, `system/out-of-scope`, and the sync surface (H1/Valve
programme sync, scope guard). **Prior-art/kb** is a new page: a search box over the host
`kb-mcp` RAG corpus (local Ollama + LanceDB). Queries go to the host MCP only — no
research content (binaries, decompiles) and no query traffic leave for a third-party API
(constraint 2).

## 4.4 State & data flow

Reuse the ARTEX client layer: the typed `lib/api.ts` (`http<T>` at `api.ts:130`, with
`get`/`post`/`put`/`patch`/`del` helpers at `api.ts:232-240`) and `lib/types.ts`. REST for
snapshots (`/api/campaigns`, `/api/campaigns/{id}/findings`,
`/api/campaigns/{id}/surface-graph`, `/api/campaigns/{id}/gates` — names are the §3
projection's to fix).

**Live state store.** ARTEX keeps per-session live state (transcript segments, pending
approvals, the `snapshotCursor`) in React `useState`/`useRef` *inside* `sessions-tab.tsx`
(e.g. `esRef`, `snapshotRef`, `sessions-tab.tsx:646,724,958`); its one `zustand` store is
the global **preferences** store (`stores/preferences/`). The VR Console should **add**
per-campaign `zustand` stores (zustand is already in the stack) so multiple open campaign
workspaces each keep their own transcript/approval/gate-map slice — this is an addition,
not a verbatim reuse of an existing ARTEX store.

**Reliability model (kept from ARTEX).** History is a paged REST snapshot carrying a
`snapshot_cursor` = the task-level max id at query time; the live stream joins at that
cursor so history (`id ≤ cursor`) and the live tail (`id > cursor`) meet gap-free, and
the overlap is deduped by id (`artex/server/server.go:2985-2987` comment;
`sessions-tab.tsx:93-95,874-876,958`). The VR Console keeps this exact
history-then-tail-at-cursor + dedup discipline over its WS transport.

## 4.5 How the live event stream renders

ARTEX streams one-way over **SSE**: `sseUrl()` builds the stream URL
(`artex/web/src/lib/api.ts:211`), the client opens an `EventSource`
(`sessions-tab.tsx:646,972`), and the server sets `Content-Type: text/event-stream` with
`Last-Event-ID` resume and a periodic ping (`server.go:3258`, `streamActivity` at
`server.go:3230`). Upstream actions (e.g. resolving an interception) go back over
separate REST POSTs — ARTEX's `web/src` contains **zero** `WebSocket` usage (verified).

The VR Console uses a **WebSocket** instead — the seam Phase 0 proved
(`phase-0-spike.md §5`). Rationale: approvals need a low-latency client→server channel,
and one bidirectional WS carries both the event stream *and* the approve/deny replies in
a single connection, rather than ARTEX's SSE-down + REST-up pair. Frames are omp
`AgentSessionEvent`s shaped by a copy of `printableEvent`
(`packages/coding-agent/src/modes/print-mode.ts:85`) — **not optional**: it drops
`message_update` snapshots (keeping only the incremental delta; the authoritative message
arrives in `message_end`) and strips `providerPayload`, avoiding the quadratic multi-GB
re-serialization the omp authors hit (`print-mode.ts:78-87` comment). `printableEvent`
may not be re-exported from the package index, so the server copies the logic
(`phase-0-spike.md §3`).

```
omp AgentSession.subscribe   ->  vr-console-server  ->  WS JSON frame  ->  zustand
  message_update(delta)  -> append streaming text into the open assistant bubble
  message_start / _end   -> open / seal a transcript message
  tool_execution_start   -> render a tool-call card (name + args), spinner
  tool_execution_update / tool_stream_update -> live tool output into that card
  approval request frame -> render the (new) approval card; await WS reply
  turn_end / agent_end   -> settle turn; refetch gate/finding/surface snapshots
  goal_updated / queue_update / notice -> overview/goal + status strip
  model_changed / advisor_cost_changed -> LLM badge + dashboard cost tile
```

Every event name above is a real member of the omp event union (base `AgentEvent` from
`@oh-my-pi/pi-agent-core`: `agent_start`, `turn_start`, `message_start/update/end`,
`tool_execution_start/update`, `tool_stream_update`, `turn_end`, `agent_end`; session
extensions in `agent-session-events.ts:14-109`: `model_changed` `:84`,
`advisor_cost_changed` `:86`, `notice` `:92`, `goal_updated` `:101`, `queue_update`
`:109`). The "approval request frame" is **not** one of these — it is the server-side
projection of the `setToolUIContext` / `extension_ui_request` seam (§4.3), not an
`AgentSessionEvent` the console reads directly.

`subscribe(listener) → () => void` (`agent-session.ts:6014`) is the fan-out source;
`session.prompt(text, { images? })` (used at `print-mode.ts:485`) is the awaitable the WS
`{type:"prompt"}` frame drives.

A `turn_end` triggers a **targeted REST re-fetch** of the gate map and surface graph, so
the host FS (the authority, constraint 1) stays the source of truth and the stream is
only a live hint — never the thing a gate status is read from.

## 4.6 Build / supply-chain

Static-export the Next app (`build:static` = `NEXT_EXPORT=1 next build`,
`artex/web/package.json`) and embed it in the Bun `vr-console-server`, the exact analog of
how ARTEX serves its export from the embedded webui handler inside the Go binary
(`artex/server/server.go:1032-1034`: "everything else is served by the embedded … webui
handler"; a `no-embed` build 404s and expects `next dev` separately). Build images
**locally** and pin deps — the ARTEX lineage shipped a supply-chain backdoor via a
trojanized Docker image (`tomicdd/artex`); the **source tree was never backdoored** and
this fork builds locally (`artex/artex-backdoor-report.md`; constraint 5).

## 4.7 Open questions

- Exact approval-frame schema on the `setToolUIContext` / rpc-ui `extension_ui_request`
  path — spike auto-approved, so it is not yet exercised (owned by §2/§3). The Approve/Deny
  WS reply shape depends on it.
- How the server surfaces the single-writer **lease** state to the badge (REST poll vs a
  synthesized `notice` frame) — there is no omp `session` event to carry it, so this is a
  §2/§3 server decision.
- Whether the surface graph is served as a projected snapshot or derived live from
  `campaign-mcp` surface records — depends on the §5 projection design.
- Whether per-campaign live state lives in one `zustand` store per open workspace or a
  keyed slice of a single store — a §3/§4 implementation call, not a constraint.
