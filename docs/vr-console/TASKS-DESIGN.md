# vr-console Tasks: an autonomous orchestration layer on omp

Status: **built (T0–T3).** This spec defined, and the console now implements, an
**autonomous multi-agent "Tasks" layer** modelled on ARTEX's autonomous pentest
engine but running on the omp SDK instead of the `norma` harness, reusing the
console's session registry, approval gate, cost ledger, and MCP discovery. The
seam was de-risked by the T0 spike ([`tasks-t0-spike.md`](tasks-t0-spike.md));
§11 tracks what shipped. The autonomous loop drives real omp sessions, so running
a task end-to-end needs a model configured in omp on the host.

Companion docs: [`DESIGN.md`](DESIGN.md) (the console itself), [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## 1. Purpose and scope

The console today is **operator-driven**: a human prompts an omp session and
approves each tool call (HITL). Tasks adds an **autonomous** mode on top of the
same substrate: you give a goal, and a *planner* agent decomposes it and emits
exploration *intents*; *worker* agents claim intents, run tools, and write back
*facts*; the planner reacts to the growing graph and emits more intents until the
goal is met. A human can watch, steer, and still approves every mutating tool
call.

This is the omp port of the ARTEX **Tasks** feature (planner / workers /
exploration graph / findings), scoped down to the orchestration core because
vr-lab already provides the domain tooling over MCP.

In scope:

- The **task model** and the **exploration graph** (nodes, edges, frontier).
- The **three agent roles** (main / planner / worker) as omp sessions.
- The **orchestration engine** (planner rounds, frontier dispatch, bounded
  worker pool, pause / resume / steer / kill, heartbeat).
- The **host tool seam** that lets those agents mutate the graph (omp
  `customTools`).
- The **API** and **UI** (Tasks list, New-Task modal, Task detail tabs).

Out of scope for the first build (deferred, see §12): ARTEX's bespoke asset
store / traffic proxy / scope interception / credential vault / LLM pool / asset
sync. vr-lab's MCP servers and the console's existing approval, credential, and
cost surfaces cover most of that; add parity later only where a gap bites.

Non-negotiables (inherited from the console):

- **omp is unmodified.** Agents are omp sessions; host behaviour is injected
  through the SDK's public `customTools` and the existing adapter seam.
- **The approval gate still governs every worker tool call.** Autonomy changes
  *who issues* a tool call, never *whether it is gated*. Mutating tools stay
  fail-closed and, by default, hard-denied until the operator opts in
  (`VR_CONSOLE_ALLOW_MUTATIONS`, see [`DESIGN.md`] approval policy).
- **Findings and evidence stay filesystem-truth** (the vr-lab campaign dir).
  The exploration graph / frontier / task state is *operational* state and lives
  in Postgres (§5).

---

## 2. Background: ARTEX's engine, and the norma → omp mapping

ARTEX (Go) runs on `github.com/Autumn-27/norma`, an agent harness exposing
`llm.Provider`, `agentcore`, `tool`, `transcript`, `permission`. That is exactly
the role omp's SDK plays here. ARTEX's core, grounded in its source:

- **MainAgent** (`agent/mainagent.go`) — the thin human interface. Observes with
  read-only tools; steers by injecting hints (→planner) or direct intents
  (→frontier). Does not run the autonomous loop.
- **Planner** (`agent/planner.go`) — the sole intent generator. Event-driven:
  on a debounced graph/asset change or a heartbeat it judges goal-met and emits
  `0..N` intents into the frontier. Hard floor: goal unmet + frontier empty ⇒
  emit ≥1 intent or the task stalls.
- **Worker** (`agent/worker.go`) — claims one intent, runs real tools, writes
  the facts it found back into the graph, stops. Never invents directions. Many
  run concurrently.
- **Goals decomposer** (`agent/goals.go`) — turns the user goal into concrete
  end-results and extracts operation constraints.
- **Exploration graph** (`db/exploration.go`, `db/constants.go`) — nodes keyed
  by `kind` (`goal` / `intent` / `fact` / `finding` / `hint` / `digest`) and
  edges by `rel` (`spawns` / `yields` / `proves` / `derived_from` / `covers`).
  An origin `fact` is the root. The **frontier** is the open/running intent set.
- **Engine** (`server/engine.go`, `server/manager.go`) — per-task goroutines (a
  planner loop + N workers), context-cancellation pause/resume/stop, `SteerWork`
  / `KillWork` / `ControlWork`, planner-round counting, LLM accounting; a global
  manager for concurrency, the LLM pool, and assets.

The mapping this spec adopts:

| ARTEX (on norma) | vr-console (on omp) |
|---|---|
| norma agent (`llm.Provider` + tool loop) | omp session via `OmpSessionAdapter` |
| MainAgent / Planner / Worker | three omp sessions, role prompt + tool subset each |
| running them concurrently per task | the existing `SessionRegistry` |
| `actool.CoreTool` injected into agents | omp `customTools` (`createAgentSession({ customTools })`, sdk.ts:790) |
| worker tool calls gated by permission | the console's always-ask approval gate |
| asset store / traffic / scope infra | vr-lab's MCP servers (already discovered + gated) |
| LLM pool / config chain | the LLM panel + per-session model (extend to a failover chain) |
| per-session transcript / cost | the console's event stream + cost ledger |

The single load-bearing assumption — that omp accepts host-provided in-process
tools — is **verified**: `createAgentSession` takes
`customTools?: (CustomTool | ToolDefinition)[]` ("Custom tools to register in
addition to built-in tools", sdk.ts:790-791). That is the injection seam the
planner/worker tools (`add_intent`, `report_finding`, …) ride on.

---

## 3. Architecture

```
                         ┌──────────────── Task (one goal) ─────────────────┐
  human ── chat ──►  MainAgent (omp session, read + steer tools)            │
                         │  add_intent / add_hint / set_goals / steer_work  │
                         ▼                                                    │
   heartbeat  ─────►  Planner (omp session)  ── emits intents ──►  FRONTIER  │
   graph-change ──►   (sole intent generator)                      (open/    │
   trigger (debounced)                                              running)  │
                                                                      │       │
                                           bounded worker pool  ◄─────┘       │
                                                                      │       │
                         Worker #1 … #N (omp sessions, one intent each)       │
                         │  real tools via vr-lab MCP (approval-gated)        │
                         │  report_fact (yields) / report_finding (proves)    │
                         ▼                                                    │
                   EXPLORATION GRAPH  (Postgres: nodes + edges + frontier)   │
                         │  graph change ──► re-trigger planner (debounced)  │
                         └──────────────────────────────────────────────────┘
                   findings + evidence ──► vr-lab campaign dir (FS-truth)
```

### 3.1 The three roles (omp sessions)

Each role is an omp session created through a thin extension of the existing
`OmpSessionAdapter`, differing only in (a) its **system prompt** and (b) its
**tool set** (built-in omp tools ± role `customTools` ± which vr-lab MCP tools
are exposed). All three reuse the current approval gate, event shaping, cost tap,
and audit.

- **MainAgent** — built-in read tools + the graph read tools + `add_intent`,
  `add_hint`, `set_goals`, `steer_work`, `get_worker_output`. No autonomous loop:
  it only runs a turn when the human sends a message. It is the existing HITL
  chat, re-pointed at a task's graph.
- **Planner** — graph read tools (`graph_overview`, `query`) + `add_intent`,
  `set_goals`, a `TodoWrite`-style scratchpad, and the goal-met verdict. No Bash,
  no MCP side-effect tools. Runs one turn per *planner round* (§3.3).
- **Worker** — the full tool surface for doing work: omp's Bash + the vr-lab MCP
  tools (approval-gated), plus `report_fact` and `report_finding` to write
  results back. Given exactly one intent as its prompt; stops when done.

### 3.2 The exploration graph (the shared blackboard)

Ported 1:1 from ARTEX's model (`db/constants.go`):

- Node `kind`: `goal`, `intent`, `fact`, `finding`, `hint`, `digest`.
- Node `state`: `origin` (root fact), `confirmed` (worker fact), intent frontier
  states `open` / `running` / `done` / `exhausted` / `blocked` / `deleted`,
  digest `active` / `superseded`.
- Edge `rel`: `spawns` (parent→child), `yields` (intent→fact), `proves`
  (fact/intent→finding), `derived_from`, `covers` (digest→folded member).
- The **frontier** is the query "intents in state `open` or `running`". Workers
  claim `open` intents (atomic `open → running`); on pause/kill a `running`
  intent returns to `open` and re-runs from scratch.
- `digest` nodes are an optional later optimisation (ARTEX's "cold graph",
  `agent/coldgraph.go`): fold stale intent/fact branches into a lossless summary
  so the planner's context stays small. Defer to T2+.

### 3.3 The orchestration engine (TypeScript / Bun)

ARTEX's per-task goroutines become async loops + a work queue in the server,
one `TaskRuntime` per running task:

- **Planner loop.** A planner round fires on: a debounced graph/asset change, a
  heartbeat timer (configurable, min ~10 min — the deadlock backstop), or an
  explicit human nudge. A round = one planner session turn with the current graph
  overview + recent triggers; it calls `add_intent`/`set_goals`, then returns a
  goal-met verdict. Enforce the hard floor (goal unmet + frontier empty ⇒ require
  ≥1 intent). Rounds are serialized per task.
- **Frontier dispatcher + worker pool.** A bounded pool (global + per-task
  concurrency limits, as the Manager has today) claims `open` intents and starts
  one worker session each. A worker's facts/findings land in the graph; its
  completion and any graph delta re-arm the debounced planner trigger.
- **Control.** `pause` / `resume` cancel/restart the loops via `AbortController`s
  (running intents → `open`); `steer_work(intentId, msg)` injects a message into a
  live worker session without losing progress; `kill_work(intentId)` aborts one
  worker. These mirror ARTEX's `Engine.SteerWork` / `KillWork` / `ControlWork`.
- **Termination.** Goal-met ⇒ task `completed`. Task timeout ⇒ graceful
  wind-down (each running worker writes back, planner issues a final verdict),
  then `timed_out`. Hard error / operator stop ⇒ `stopped`.

### 3.4 The host tool seam

The planner/worker host tools are plain omp `customTools` the adapter passes to
`createAgentSession`. Each is a small typed function closing over the task's
graph store and the engine:

- `graph_overview()`, `query(...)` — read the graph / assets (read-only; may
  auto-run under the approval policy).
- `add_intent({text, priority, parentId})`, `set_goals([...])`,
  `set_constraints([...])`, `add_hint({text})` — planner/main writes; these
  mutate console state, not the host or an external service, so (like the model
  switch) they are **operator-domain writes**, not agent tool calls against a
  target — they do not need the fail-closed card, but they are audited.
- `report_fact({intentId, text, state})`, `report_finding({...})` — worker
  writes a fact (`yields`) or a finding (`proves`). `report_finding` composes the
  same vr-lab promote/gate instruction the console already uses, so authority
  stays with campaign-mcp and the on-disk evidence (the UI can't fabricate a
  finding).

Real side-effecting work (Bash, lab-mcp WinRM, fuzz, Proxmox) is **not** a host
tool — it is omp's Bash and the vr-lab MCP tools, which already flow through
`ExtensionToolWrapper → requestApproval → ui.approve` (the fail-closed gate). So
autonomy rides entirely on the existing safety seam.

---

## 4. Reuse map (what exists vs what is new)

Already in the console, reused as-is:

- `OmpSessionAdapter` — the omp seam (extended with a `customTools` + role-prompt
  option).
- `SessionRegistry` — now hosts a task's main/planner/worker sessions, each with
  its own event stream, approval cards, history, cost.
- The approval gate + policy (`always-ask`, safe-by-default deny) — governs every
  worker tool call unchanged.
- The cost ledger, approval audit (Postgres or JSONL), auth layer, WS transport.
- MCP discovery — a worker's cwd (the campaign dir) already yields the vr-lab
  tools.
- The `CoverageGraph` SVG — the seed of the exploration-graph renderer.

New:

- The task + exploration-graph + frontier store and schema (§5).
- The three role prompts + their `customTools`.
- The orchestration engine (planner loop, dispatcher, worker pool, control).
- The Tasks REST/WS API (§6) and the UI (§7).

---

## 5. Data model (Postgres)

The graph/frontier/assets are live mutable operational state, so **Tasks require
Postgres** (the console's existing optional `DATABASE_URL` becomes required when
Tasks are enabled). Findings/evidence remain vr-lab FS-truth; the `finding` node
is a pointer + projection, not the source.

Tables (sketch; final DDL lives beside `db/schema.sql`):

- `tasks` — `id`, `name`, `goal`, `description`, `category`, `cwd`, `status`
  (`draft`/`running`/`paused`/`completed`/`timed_out`/`stopped`), `config` (jsonb:
  concurrency, heartbeat_minutes, dispatch_first_intent, timeout_minutes,
  allow_mutations, model chain), `created_at`.
- `exploration_nodes` — `id`, `task_id`, `kind`, `state`, `text`, `priority`,
  `content_ver`, `cold_since`, `delete_reason`, `created_at`. Indexed on
  `(task_id, kind, state)` for the frontier query.
- `exploration_edges` — `id`, `task_id`, `from_id`, `to_id`, `rel`.
- `intents` view/columns on nodes for frontier state (`open`/`running`/…) +
  `claimed_by` (worker session id) for atomic claim.
- `task_activity` — the per-task event stream (planner rounds, dispatches,
  facts), feeding the UI timeline.
- `findings` — already projected; a `finding` node references a campaign-mcp
  finding id.

Atomic claim: `UPDATE exploration_nodes SET state='running', claimed_by=$w WHERE
id=$i AND state='open' RETURNING id` — the pool only starts a worker on a
non-empty return, so two workers never take the same intent.

---

## 6. Server API

REST (all behind the existing auth token):

- `GET /api/tasks`, `POST /api/tasks` (create from the modal), `GET
  /api/tasks/:id`, `POST /api/tasks/:id/control` (`start`/`pause`/`resume`/`stop`).
- `GET /api/tasks/:id/graph` — nodes + edges for the exploration-graph tab.
- `GET /api/tasks/:id/frontier`, `GET /api/tasks/:id/findings`, `GET
  /api/tasks/:id/activity`.
- `POST /api/tasks/:id/intents` (human add-intent), `POST
  /api/tasks/:id/work/:intentId/steer`, `.../kill`.
- The task's agent sessions are ordinary registry sessions, so the existing
  `/api/sessions/:id/*` + `/ws?session=` surface drives their chat/approvals with
  no new transport.

WS: task-level events (planner round started/finished, intent dispatched, fact
recorded, finding proved, status change) broadcast on a task channel; per-agent
token/tool streams stay on the per-session channel already built.

---

## 7. Frontend

- **Tasks** list page — status, goal, progress (findings / intents / coverage).
- **New Task** modal — goal, description, category, cwd, upload files, linked
  tasks, the LLM model chain, test accounts, and advanced settings (timeout,
  heartbeat, dispatch-first-intent, approval posture). Mirrors ARTEX's modal but
  trimmed to what the omp/vr-lab port needs.
- **Task detail** tabs:
  - *Sessions* — the main/planner/worker session list (reuses the Sessions +
    HITL chat already built; each worker is a registry session).
  - *Exploration graph* — the node/edge DAG (goal/intent/fact/finding/hint/
    digest, spawns/yields/proves), evolved from `CoverageGraph`.
  - *Findings* — the findings board (reuses the campaign findings view).
  - *Overview / Activity* — the task timeline + cost.
  - *Interception / Approvals* — the approval-records view, task-scoped.
  - *Report* — the report view (T3).

---

## 8. Lifecycle / state machine

```
draft ──start──► running ──goal met───► completed
  ▲   │            │  ▲                    │
  │   │       pause│  │resume              │ (human reopens a goal → running)
  │   │            ▼  │                    │
  └───┘          paused                    │
         timeout │                         │
                 ▼                         │
             timed_out ◄───────────────────┘ (stop) ──► stopped
```

- `draft → running`: decompose goals, seed the origin fact + goal nodes;
  optionally dispatch the first intent directly (CTF mode — ARTEX's
  "dispatch first intent"), else wait for the first planner round.
- `running`: planner loop + worker pool as in §3.3.
- `paused`: loops cancelled, running intents returned to `open`; resume restarts.
- `completed`: goal-met verdict with an empty/again-covered frontier. A human
  adding a new goal via MainAgent returns it to `running`.
- `timed_out` / `stopped`: terminal.

---

## 9. Findings quality

ARTEX gates findings with an adversarial gate + quality gate + retester before a
finding counts. vr-lab already owns that discipline (its gate/promote tooling is
evidence-gated, with a canary-clean repro and severity bar). **Preferred:** the
worker's `report_finding` composes the existing vr-lab promote/gate instruction,
so validation stays in campaign-mcp against on-disk evidence — no second gate to
maintain. A lightweight console-side dedup (stack/finding hash) avoids duplicate
`finding` nodes. Port ARTEX's standalone adversarial gate only if a gap appears.

---

## 10. Safety

- Every worker tool call that touches a target or the host is omp's Bash or a
  vr-lab MCP tool and is **approval-gated** exactly as in HITL mode. Autonomy does
  not widen the tool surface or bypass the card.
- Default posture stays **read-only-only**: mutating/unknown tools are
  hard-denied until the operator sets `VR_CONSOLE_ALLOW_MUTATIONS` + an allowlist.
  An autonomous task under the safe default therefore does reconnaissance only;
  the operator explicitly enables mutations for active work.
- A running autonomous task can generate many cards quickly. The HITL chat shows
  each worker's cards on its own session channel; a task-level **approvals** view
  aggregates them. An auto-deny-on-timeout per card keeps a parked card
  fail-closed (the pending registry already denies on dispose).
- Host writes (`add_intent`, `report_fact`, …) are console-domain and audited but
  not carded; they cannot act on a target.
- Scope: workers inherit the campaign cwd, so vr-lab's own scope tooling
  (programme scope, out-of-scope rules) governs them via MCP, not a separate
  interception layer in T1.

---

## 11. Phased implementation — what shipped

- **T0 — model + shell. [done]** Postgres schema (§5: `tasks`,
  `exploration_nodes`, `exploration_edges`, `task_activity`); the `GraphStore`
  async interface with `MemGraphStore` + `PgGraphStore` (atomic claim via
  `FOR UPDATE SKIP LOCKED`); task CRUD; `GET/POST /api/tasks` + `graph` + control;
  the Tasks list + create form + detail shell. Postgres is required for Tasks.
- **T1 — the loop. [done]** `TaskEngine` (`engine.ts`) with an injectable
  `TaskAgentRunner`: serialized planner round → bounded worker pool draining the
  frontier → re-trigger on change → heartbeat backstop → goal-met termination,
  with pause/resume/stop (running intents return to the frontier). The real runner
  (`runner-omp.ts`) is the planner/worker as omp sessions with the host tools;
  `TaskManager` (`manager.ts`) owns the per-task engine and mirrors state. The
  engine logic is unit-tested with a mock runner (no model); the omp-session path
  is proven live up to the model boundary.
- **T2 — graph UI + activity. [done]** The exploration-graph DAG renderer
  (`TaskGraphView`, depth-layered, coloured by kind/relation); the `task_activity`
  timeline (`GET /api/tasks/:id/activity`) with live polling while running.
  (Cold-graph digest folding and multi-goal decomposition remain optional
  follow-ups.)
- **T3 — findings. [done]** `report_finding` (worker host tool + `store.reportFinding`)
  → a `finding` node proved by its intent; the worker prompt uses it for an
  evidenced finding; the task header shows fact/finding counts. (vr-lab
  promote is the worker calling campaign-mcp separately — an approval-gated MCP
  mutation — and a dedicated report tab/dedup is a later polish.)
- **Deferred.** Steer/kill per-intent controls, WS task push (today the UI polls),
  cold-graph digests, multi-goal decomposition, and ARTEX's vault / traffic proxy
  / scope interception / LLM pool / asset sync — the vr-lab MCP + the console's
  existing surfaces cover most; add parity where a gap bites.

Each increment shipped with unit tests (graph store, frontier claim, engine
loop/termination/control, finding contract) and a live check, matching the
console's test discipline.

---

## 12. Open decisions

1. **Postgres required for Tasks.** Confirmed direction: the graph/frontier is
   operational state, not a research artifact, so it is Postgres-backed. The
   console's non-Tasks features stay DB-optional.
2. **Planner cadence.** Debounced-on-change + heartbeat (ARTEX's model) vs a
   fixed tick. Start with debounced + a long heartbeat; expose both knobs.
3. **Worker model vs planner model.** The LLM panel already switches per session;
   Tasks should let the planner and workers run different models (a cheap planner,
   stronger workers, or vice-versa) via the config chain.
4. **How much of ARTEX's finding gate to port** vs delegate to vr-lab (§9).
   Default: delegate.
5. **Host-write carding.** Confirm `add_intent`/`report_fact` stay un-carded
   (console-domain) — revisit if any host tool could reach a target.

---

## 13. Grounding references

ARTEX (reviewed at `sarks0/artex`): `agent/planner.go` (event-driven planner,
frontier, hard floor), `agent/worker.go` (one-intent worker), `agent/mainagent.go`
(human interface / steer), `agent/goals.go` (goal decomposition + constraints),
`agent/coldgraph.go` (cold-graph digest), `db/constants.go` + `db/exploration.go`
(node kinds / edge rels / states), `server/engine.go` + `server/manager.go`
(per-task runtime, control, concurrency), `server/orchestration.go` (cross-task
host tools).

omp SDK (fork `packages/coding-agent/src`): `createAgentSession({ customTools })`
for host in-process tools (sdk.ts:790-791); tool approval via
`ExtensionToolWrapper → requestApproval → ui.approve` (wrapper.ts:478,
approval.ts:844). Console seams reused: `OmpSessionAdapter`,
`SessionRegistry`, the approval policy, the cost ledger, the auth layer.
