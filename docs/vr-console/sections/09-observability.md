## 9. Observability, Cost & Operations

How the VR Console *sees itself*: the token/cost ledger across omp providers,
session transcripts and the live-event archive, metrics/health, the existing
`omp stats` surface and OTLP export, and an operational runbook for standing up
and diagnosing console + omp + vr-lab MCP + VMs. Everything in this section
lives in `packages/vr-console-server`; omp stays unchanged (HARD CONSTRAINT 6).
The one real divergence from ARTEX: the cost tier reuses omp's
**provider-computed** numbers rather than re-pricing from a local rate card.

A structural fact drives the whole section. The console runs omp in two tiers
(§1, §5): **portable** work is an in-process omp Node SDK session on the console
host; **host-bound** work is brokered to an omp running on the Kali host
(HARD CONSTRAINT 3), reached as a subprocess over `--mode rpc`. The console's
own event tap (`session.subscribe`, below) sees both — in-process directly, and
the brokered one as JSON-RPC frames over the wire — so the console-owned ledger
is the single cross-tier record. omp-stats' JSONL rollups, by contrast, only
cover sessions whose transcript files are local to the machine omp-stats runs
on. That split is why the cost ledger (§9.1) and the stats surface (§9.3) are
two different things with two different scopes, not one.

## 9.1 The cost & token ledger

ARTEX keeps an always-on `llm_usage` table — one row per completion call,
carrying a `status` of `ok | error` so accounting survives interrupted runs,
holding only slicing dimensions (task/worker/model/profile, tokens, latency,
status), never prompt content (`artex/db/llm_usage.go:15-48`). Cost is derived
*later* from per-profile prices, charging `input − cacheRead` (clamped at zero)
so the cached subset is not billed at full input price twice (`applyCostEur`,
`artex/db/llm_usage.go:346-388`). Full request/response bodies are a *separate,
gated* debug feature (`llm_records`, `artex/db/llm_usage.go:9-13`).

The console ports the table **but not the pricing math**, because omp already
computes it. Every `AssistantMessage` carries a `Usage` object
(`packages/catalog/src/types.ts:211-290`) with token buckets (`input`, `output`,
`cacheRead`, `cacheWrite`, `totalTokens`, and optional `orchestration`,
`reasoningTokens`, `cttl`, `server`, `premiumRequests`, `credits`) **and a
required `cost` sub-object** (`input / output / cacheRead / cacheWrite / total`
— `types.ts:276-282`). The message is attached to the turn at
`packages/ai/src/types.ts:1355` (`usage: Usage`), alongside `stopReason`
(`:1362`), `duration` ms (`:1395`) and `ttft` ms (`:1396`). So the console's
`llm_usage` row copies `usage.cost.total` directly and stores the buckets for
slicing — no per-profile price table, no `applyCostEur`, no `llm_profiles`.

**Ingest = one tap, `session.subscribe` → `message_end`.** The orchestrator
subscribes to every session (`session.subscribe`, `agent-session.ts:6014`; §6)
and writes one row per `message_end` event — the authoritative, final message
(`modes/print-mode.ts:84,104`). There is no second "`onUsage`" tap to add: the
`onUsage` callback at `agent-session-types.ts:675` belongs to
`EphemeralTurnOptions` (the `/btw` side-turn path), not to `createAgentSession`,
and would not see main-loop completions. Writes are **best-effort**
(log-and-continue, like ARTEX) so a lost metering row never breaks a turn.

**Error and aborted turns are covered by the same tap** — this closes the first
of the draft's open questions. `message_end` fires even on an aborted turn,
carrying `stopReason: "aborted"` (`agent-session.ts:1324`), and failed-turn
messages carry `stopReason` (`ai/src/types.ts:1362`), `errorMessage` (`:1364`)
and `errorStatus` (`:1372`) on the same `AssistantMessage`. The console derives
ARTEX's `status='error'` from `stopReason`/`errorStatus` on the message_end
row; it does **not** need a separate `agent_end`/abort tap.

**Served model, not requested role** — this closes the second open question.
The row records `AssistantMessage.provider` (`ai/src/types.ts:1323`) and
`.model` (`:1324`), which are what the provider served. When a gateway routed
elsewhere, `upstreamProvider` / `upstreamModel` hold the concrete served
identity; the ledger stores `model`/`provider` and, when present, `upstreamModel`
so a gateway swap is auditable. This matches how omp-stats' own parser keys on
`msg.provider` / `msg.model`.

Dimensions map to the console data model (§3): `campaign_id`, `run_id`,
`agent_lane` (planner / worker / scout — the analog of ARTEX's `worker`),
`model`, `provider`, and a `host_bound` flag so spend on brokered Kali-host
sessions is distinguishable from in-process portable work.

```
 llm_usage (console)
 ─────────────────────────────────────────────────────────
 id, ts, campaign_id, run_id, agent_lane, model, provider,
 input, output, cache_read, cache_write, reasoning_tokens,
 cost_total,        -- omp usage.cost.total (provider-computed)
 cost_unpriced,     -- 1 ONLY when the console knows the model is
                    --   local/self-hosted (no public rate card); see below
 latency_ms, ttft_ms, stop_reason, host_bound, status
```

**`cost_unpriced` is a console-side flag, keyed on provider — it does not mirror
omp-stats' marker** (correcting the draft). omp-stats' `unpricedRequestSql`
marks a row unpriced only when `total_tokens > 0 AND cost_total = 0 AND
(provider = 'xai-oauth' OR cost_unpriced = 1)`, and `cost_unpriced = 1` is set
only for a *scheduled (time-based) rate card* whose entry lost its request
timestamp (`packages/stats/src/db.ts:41-73`). Critically, a model with **no
catalog card at all keeps `cost_unpriced = 0`** — omp-stats treats its zero as a
real (free) price, not unknown spend (`db.ts:64-67`). So the console cannot lean
on omp-stats to flag local inference: it must set its own `cost_unpriced` when
the provider is a self-hosted / local endpoint whose `usage.cost.total` is zero
for lack of a rate card, keeping real tokens with a zero marked *unknown*, not
*free*.

Note also that **local kb-RAG inference never appears in this ledger at all**:
`kb_ask` runs the embedder/synthesis models *inside* kb-mcp (an MCP tool call),
not as an omp session model, so no `AssistantMessage` / `Usage` is produced for
it. The "unpriced local inference" case that *does* reach the ledger is the
omp **agent itself** running on a card-less self-hosted model. Either way, no
research content leaves the host (HARD CONSTRAINT 2); the ledger stores tokens
and cost, never prompts or decompiles.

Aggregations port ARTEX's four: by-model, by-profile→by-policy, daily buckets,
and a per-lane roll-up for the cost-cap judge. omp's **cost gate** is surfaced
as a per-campaign budget. The gate is configured through the `costGate`
create-time option (`CostGateApi`, `sdk.ts:733`) or, absent one, the session's
own `session.warnCost` / `session.maxCost` (`agent-session-types.ts:202`,
`sdk.ts:732`); when the cap is crossed the session raises a notice tagged
`COST_GATE_NOTICE_SOURCE` and exposes `session.costCapRefusal`
(`modes/print-mode.ts:16,307,388-397,580`). The orchestrator reads
`costCapRefusal` on each turn boundary and renders the notice as a run-stopped
card.

## 9.2 Transcripts & the WS event archive

Two durable records, two owners:

1. **omp JSONL sessions** (`~/.omp/agent/sessions/`, per cwd) are the agent's own
   transcript of record, written by omp unchanged. Because every campaign gets
   its own cwd (single-writer lease, HARD CONSTRAINT 4), these are already
   partitioned per campaign. For host-bound work these files live on the **Kali
   host**, not the console host — a fact the stats scoping in §9.3 must respect.
2. **The WS event archive** is the console's own. The shaped JSON frames
   broadcast to the browser (the Phase-0 contract — `shapeEvent`, an adapted
   copy of omp's `printableEvent`, `phase-0-spike.md §3,§6`) are appended to a
   per-run `events.jsonl` under the campaign dir. This is the analog of ARTEX's
   activity table, which the `Broadcaster` both stores and streams from one emit
   point so the live stream and stored history never diverge
   (`artex/server/broadcast.go:9-12`).

The fan-out copies ARTEX's backpressure rule exactly: a bounded per-subscriber
buffer (ARTEX uses 256, `broadcast.go:25`), **non-blocking send, drop-on-full**,
and the browser reconnects with a last-seq cursor to replay the gap from
`events.jsonl` — liveness never stalls the agent loop (`broadcast.go:49-61`).
Frames are shaped **before archival** (drop the `message_update` snapshot and
keep only the incremental delta; strip `providerPayload`) or a single long turn
balloons the archive to multi-GB — the exact bloat `printableEvent` was written
to prevent (`modes/print-mode.ts:78-110`; `phase-0-spike.md §3`). Backend
operational logs reuse ARTEX's `server_logs` shape (`InsertLog` / `RecentLogs` /
`ListLogsBefore`, `artex/db/logs.go:18,28,54`) as a `console_logs` table with a
`GET /api/logs` tail.

## 9.3 Metrics, health & the `omp stats` surface

`omp stats` already *is* a local observability dashboard over the JSONL
sessions: SQLite hourly rollups (`message_rollup` / `tool_rollup` /
`session_rollup`, `packages/stats/src/rollup.ts:223,255,272`), incremental sync,
a web UI, and an SSE live channel (`liveEventStream`,
`packages/stats/src/server.ts:459,501`). Its documented metrics — tokens/s,
cache rate, cache savings, error rate, avg latency, TTFT, API-equivalent cost
(`packages/stats/README.md`, "Metrics Tracked") — are exactly what the console
needs per campaign. Relevant endpoints: `/api/stats`, `/api/stats/models`,
`/api/stats/costs`, `/api/stats/timeseries`, `/api/stats/providers`,
`/api/stats/tools`, `/api/stats/errors`, `/api/stats/folders`,
`/api/session/trace`, `/api/events`
(`packages/stats/src/server.ts:222-459`).

The console **does not reimplement** this. It embeds the stats library
in-process (`getDashboardStats`, `syncAllSessions` — `packages/stats/README.md`,
"Programmatic") and exposes a `GET /api/observability/*` passthrough so
`vr-console-web` renders the same numbers scoped by cwd→campaign. Per-campaign
scoping is sound *because* each campaign has its own cwd (HARD CONSTRAINT 4), so
omp-stats' folder dimension (`/api/stats/folders`) is a clean per-campaign key —
provided the console also tags each session with `campaign_id` at create for a
deterministic join rather than relying on path parsing. omp-stats runs its sync
as a **background worker** re-entering the single CLI entrypoint
(`__omp_worker_stats_sync`, `AGENTS.md` "Worker scripts"); under SDK embedding
`workerHostEntry()` returns `null` and the direct-module fallback spawns the
worker instead (same `AGENTS.md` contract), so the console gets the sync worker
without a CLI host and without spawning its own.

**Scope caveat (host-bound tier).** omp-stats reads JSONL from the local
`~/.omp/agent/sessions/`. In-process portable sessions write there on the
console host and are covered directly. **Brokered host-bound sessions write
their JSONL on the Kali host**, so their rollups are invisible to a console-host
omp-stats instance. The authoritative cross-tier cost/latency record is
therefore the console-owned `llm_usage` ledger (§9.1), which is fed from the
`session.subscribe` tap regardless of where the session physically runs; the
embedded omp-stats surface is a rich *portable-tier* drill-down, and host-bound
transcript stats, if wanted, require an omp-stats sync run **on the Kali host**.

Health is a composite `GET /api/health` that joins: console self (WS
subscribers, archive-write backlog), each omp session (alive / disposed /
cost-capped via `costCapRefusal`), and the vr-lab MCP health probes
(`lab_mcp_health` — Gate 7; `kb_mcp_health` — Gates 4-5; binary-mcp health —
Gate 6; `vr-lab/docs/setup-guide.md`) tagged host-bound vs portable, so the UI
shows *where* a run is blocked (§6).

## 9.4 Telemetry export (OTLP)

omp's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry **GenAI spans**
through the global `@opentelemetry/api` tracer and exposes run-level
metric/log hooks (`packages/coding-agent/src/telemetry-export.ts:1-17`). The
console opts in per deployment:

- `initTelemetryExport(telemetry.otlpExportEnabled)` registers trace/log/metric
  providers only when the opt-in is set **and** an `OTEL_*` endpoint is
  configured, lazy-loading the OTel SDK graph so it stays out of default startup
  (`telemetry-export.ts:79-94`).
- `createTelemetryExportConfig(config, modelPricingResolver)` merges the host
  metric/log hooks; the pricing resolver makes chat telemetry report each
  request's **provider-computed cost**, and the caller keeps ownership of
  content-capture policy (`telemetry-export.ts:55-69`).
- `flushTelemetryExport()` is called at a natural boundary (the console calls it
  on `turn_end`) so spans surface promptly rather than on the batch interval
  (`telemetry-export.ts:96-103`).
- Only `http/protobuf` is supported; a `grpc` or `http/json`
  `OTEL_EXPORTER_OTLP*_PROTOCOL` **declines rather than misroutes**
  (`telemetry-export.ts:148-155`).

**Supply-chain / data-egress guard (HARD CONSTRAINTS 2 & 5).** OTLP export is
**off by default**, and the console keeps content capture disabled so spans
carry only tool names, model ids and token counts — never prompts, binary bytes
or decompiles (content capture is caller-controlled at
`telemetry-export.ts:55-62`, and the console never enables it). When export is
on, the console additionally **refuses an off-host OTLP collector endpoint for
any host-bound (binary/decompile) session** — the same bright line as local-only
kb-RAG. This refusal is console policy; the omp module itself does not enforce
host locality.

## 9.5 Operational runbook

**Bring-up order** (each step gates the next; vr-lab gates per
`vr-lab/docs/setup-guide.md`):

```
1. vr-lab host ready  → test_all.sh 11/11 (Gate 3); .env/.mcp.json present
2. GPU tier           → Ollama :11434 (embed+synth), kb-rerank :8011 (Gates 4-5)
3. VMs                → tagged `vulnerabiltiy-research` (that spelling, Gate 7),
                        WinRM :5985
4. omp auth/model     → discoverAuthStorage reused from CLI login (spike §9)
5. console-server     → Bun process; stats sync worker; WS transport up
6. per-campaign omp   → createAgentSession(cwd); await mcpManager.waitForStartup
                        then session.refreshMCPTools (print-mode.ts:415-419)
                        BEFORE the first prompt
7. console-web        → connects WS; /api/health all-green
```

The VM tag is the repo's deliberate typo `vulnerabiltiy-research`
(`vr-lab/docs/setup-guide.md:196`, `vr-lab/AGENTS.md:126`) — a VM without it is
not a lab VM. The step-6 readiness binding (`mcpManager.waitForStartup` then
`session.refreshMCPTools(mcpManager.getTools())` *before* prompting) is the
exact sequence `print-mode.ts:415-419` uses; prompting first means the first
turn runs with no MCP tools registered.

**Failure modes & operator response:**

| Symptom | Cause | Response |
|---|---|---|
| Tool calls fail at run start | prompted before MCP ready | gate first turn on `waitForStartup` + `refreshMCPTools` (`print-mode.ts:415-419`); health shows server not-ready |
| `lab_mcp_health` down / VM gone | VM off or untagged | run stays queued; brokered host-bound work blocked — console never runs WinRM itself (HARD CONSTRAINT 3) |
| cold `kb_ask` ≈100 s, then fast | embedder idle-unloaded from VRAM | expected, not a hang (`setup-guide.md:224-225`) |
| silent degraded RAG recall | rerank service down / batch flags | one warning, fail-soft (`setup-guide.md:100,163,229`); restart `kb-rerank` |
| model fallback / cost spike | `retry.fallbackChains` walked / cap crossed | `model_changed` / `advisor_cost_changed` events logged; cost-cap card when `session.costCapRefusal` changes |
| 403 / auth refusal | provider token expired | console holds no VM or provider creds; omp reuses CLI auth (`discoverAuthStorage`); re-login in omp, not the console |

**Gate authority and backups stay on the host (HARD CONSTRAINT 1).** Research
output (campaigns / findings / evidence) is backed up by vr-lab's own restic
tiers (`vr-lab/docs/lab-runbook.md:59-89`); the console adds nothing to that
path. It reads the portable tier and *displays* gate state; promotion authority
stays with campaign-mcp on the host FS. The console can request a promotion, and
render its refusal, but can never fake one.

## Open questions

- **Live cost during a turn.** `usage.cost` is settled at `message_end`
  (turn granularity). If the UI needs intra-turn running cost, it must
  accumulate from `message_update` deltas without the authoritative `cost`
  object, or accept per-message granularity. Confirm the product need before
  building delta accounting.
- **`agent_lane` provenance.** The ledger's planner/worker/scout lane is a
  console concept (§6); confirm the orchestrator stamps it at session-create
  rather than inferring it from the subagent spawn tree, so lane roll-ups stay
  stable across model fallbacks.
- **Host-bound stats parity.** Whether to stand up a second omp-stats sync on
  the Kali host for host-bound transcript metrics, or treat the console
  `llm_usage` ledger (§9.1) as sufficient and leave the Kali-host JSONL for
  forensic drill-down only.
