# Tasks T0 spike: prove the host-tool graph-mutation seam

Status: plan. The spike that de-risks [`TASKS-DESIGN.md`](TASKS-DESIGN.md) before
any engine is built, in the same spirit as [`phase-0-spike.md`](phase-0-spike.md)
de-risked the console itself.

## The one question it answers

Can an omp session be given **host `customTools`** that read and mutate a shared
**exploration-graph store**, such that:

1. a *planner* session calls `add_intent` and the intent lands in the store;
2. a *worker* session calls `claim_intent` + `report_fact` and the fact (with its
   `yields` edge) lands in the store;
3. these **graph-bookkeeping tools do NOT raise an approval card** (so autonomy
   does not drown the operator), while real work tools would still card.

Everything in the Tasks engine rests on this seam. If it works, the engine is
"just" orchestration over it. If it doesn't, the design changes.

## What the static review already settled (so the spike only confirms runtime)

- omp accepts host tools: `createAgentSession({ customTools })` — "Custom tools to
  register in addition to built-in tools" (sdk.ts:790-791).
- A custom tool can declare its gate behaviour: `CustomTool.approval?: ToolApproval`
  — "Capability tier declaration used by approval gates" (agent/src/types.ts:223).
- `ToolTier = "read" | "write" | "exec"` (types.ts:1085), and the gate auto-allows
  a read-tier tool even under always-ask: `if (decision.tier === "read") return
  { ...base, policy: "allow" }` (tools/approval.ts:206).

So the mechanism for uncarded host tools exists. The spike proves the **runtime**:
the tools register, the handler is invoked, the result returns, and the read-tier
declaration actually suppresses the card for our tools.

## What it builds (minimal, grows into T0 — not throwaway)

Under `packages/vr-console-server/src/tasks/` so the pieces become T0 proper:

- **`store.ts` — an in-memory `GraphStore`** (no Postgres yet; that is T0-proper).
  Nodes `{id, kind, state, text, intentId?}`, edges `{from, to, rel}`. Methods:
  `seed(goal)` (origin fact + goal node), `addIntent(text)`, `claimIntent()`
  (atomic `open → running`, returns one or null), `reportFact(intentId, text)`
  (fact node + `yields` edge), `overview()`.
- **`host-tools.ts` — four omp `customTools`** over a `GraphStore`, each declaring
  the approval tier that makes it auto-run:
  - `graph_overview` (read), `add_intent` (write-but-declared-read → no card),
    `claim_intent`, `report_fact`. The spike pins the exact `approval` value that
    resolves to `policy: "allow"` (tier `read`, or the function form returning it)
    and documents it for the design.
- **`spike-run.ts` — the end-to-end script**:
  1. `store.seed("demo goal")`.
  2. Planner session (`createAgentSession` + the tools + a one-paragraph planner
     prompt). Prompt: "emit two intents toward the goal via `add_intent`." Assert
     2 intent nodes.
  3. Worker session (same tools + a worker prompt). Prompt: "`claim_intent`, then
     `report_fact` with a one-line result." Assert a fact node + a `yields` edge.
  4. Print the graph; confirm no approval card fired for the bookkeeping tools.
- **`store.test.ts`** — unit tests for the store + the tool handlers (seed/add/
  claim-atomicity/report + edge creation) and that the tools' declared approval
  resolves to allow.

## Acceptance (two tiers — honest about the model blocker)

The cloud container has no working model (Bedrock 403), so split acceptance:

- **Tier 1 — cloud, no model (CI-able here):**
  - `createAgentSession` accepts the four `customTools` without error (wiring).
  - the unit test drives each tool handler directly: seed → add_intent ×2 →
    claim_intent → report_fact produces a coherent graph (origin fact → goal, 2
    intents, 1 fact + `yields` edge); claim is atomic (second claim returns null
    when one open intent).
  - the tools' `approval` resolves to `policy: "allow"` (asserted against omp's
    resolver, or by the gate not enqueuing a pending request).
  - build/`bun check` clean; existing 66 tests stay green.
- **Tier 2 — Kali host, live model (one command the operator runs):**
  - run `spike-run.ts`; observe the planner session actually **call** `add_intent`
    twice and the worker **call** `claim_intent` + `report_fact`.
  - the printed graph shows the full origin → goal → 2 intents → fact(+yields)
    shape, produced by the agents, with **no approval card** for the bookkeeping
    tools. (A real work tool, e.g. Bash, would still card — optionally shown.)

## Explicitly out of scope (deferred to T0-proper → T3)

The planner loop and heartbeat; the frontier dispatcher + bounded worker pool;
pause/resume/steer/kill; Postgres persistence; the Tasks UI; goal decomposition;
the findings gate/retester/report; concurrency; and real MCP work tools (the
worker's "result" is simulated text in the spike). The spike proves only the
seam: host tools ↔ session ↔ graph, uncarded.

## Risk it retires, and the fallback if it fails

Retires: "the engine can drive a shared graph through omp cheaply." If the
read-tier declaration does NOT suppress the card (the runtime disagrees with
approval.ts:206), the fallback is to expose the host tools through a tiny local
MCP server the adapter registers and allowlist those exact names in the approval
policy — more plumbing, same outcome. Either way the spike tells us which path
T1 takes before we build the engine.

## Effort

Small: one store, four thin tools, one script, one test file. A day-scale spike,
mostly the store + confirming the approval-tier runtime. It ends as the first
real files of T0 (the store and host-tools carry forward; only the in-memory
backing and the throwaway script are replaced by Postgres and the engine).
