## 5. vr-lab Domain Integration

How the console surfaces and drives vr-lab. This section depends on the mirror/projection
architecture in [§3](03-data-model.md) (host FS is truth, Postgres is a read-only
projection) and the approval/gate seam in [§2.7](02-backend.md); it does not re-specify
those tables, and it uses their names exactly. The governing fact is the **host-bound vs
portable split** the lab already names (`AGENTS.md`): the portable tier
(campaign/notes/target/report/msrc — YAML+MD) can be read and written from anywhere; the
host-bound tier (lab-mcp/WinRM, binary-mcp/Ghidra, fuzz on torpedo, KDNET kernel-debug,
crash capture, kb-RAG GPU) is irreducible and is *brokered*, never relocated
(HARD CONSTRAINT 3).

## 5.1 The domain object model in UI and API

The lab's spine is `campaign → surface → hypothesis(finding) → gate → finding`, enforced by
`campaign-mcp`. The console mirrors it one-to-one rather than inventing a shape:

```
campaign_create ─► surface_create ─► finding_create ─► gate_record ─► finding_promote
  (server.py:69)     (:430)            (:271)            (:1019)        (:1150)
  scope+impact       surface-NNN,      born in           evidence/<gate>/  hallucinations/
  +prior-art gate    5-state reach     hallucinations/   evidence_add :1119  → findings/
```

(All line numbers are `mcp/campaign-mcp/campaign_mcp/server.py`, verified; each is the
`def` line, one past its `@mcp.tool()` decorator.)

Every object is a durable, referenceable record: a finding references `campaign_id` +
`surface_id` and "cannot cite a paragraph" (`AGENTS.md`, Boundary-first #1, line 34). The
console's read API is pure projection:

- `GET /api/campaigns`, `/api/campaigns/:id` → `campaigns` mirror (`campaign_summary`
  server.py:1323 is the render source).
- `GET /api/campaigns/:id/surfaces` → `surfaces` mirror, ranked exactly as `surface_list`
  (server.py:521) ranks: **high interest first, and at equal interest `state_changing=true`
  surfaces before read-primitives** — the server's own corrective for the lab's
  read-primitive selection bias, so the worklist does not quietly cap itself near
  info-disclosure (surface_list docstring, server.py:530-535).
- `GET /api/campaigns/:id/findings/:fid` → `findings` + `gate_records` + `hypotheses`,
  carrying the five reachability states (`unknown | static_candidate | runtime_verified |
  runtime_unreachable | blocked`, surface_create docstring server.py:462-463) as distinct UI
  badges, never collapsed to a boolean — the docstring's stated reason being that "we have
  not looked" and "we could not look" are honest answers a boolean destroys.

The UI (`vr-console-web`, adapted from ARTEX `web/`) renders this as a **campaign board**
(surfaces as a ranked worklist), a **finding detail** with a **gate ladder** (gate0 → 1A →
2 → 2B → 3 → 4, `campaign_mcp/gates.py`; 2B windows-only, 2c Valve-only per
`docs/validation-gates.md`), and an **exploration graph** reusing ARTEX's antv/g6 view. The
graph nodes are the console-owned `coverage_nodes`/`coverage_edges` of [§3.4], whose node
`kind ∈ surface | hypothesis | gate | finding | intent` and edge `rel ∈
covers | yields | proves | spawns` — the console's own planner bookkeeping that *references*
the authoritative surface/finding rows by host id, never an authoritative store.

## 5.2 Wiring omp to the 12 MCP servers

omp is an **MCP client only**. `discoverAndLoadMCPTools(cwd)` auto-discovers servers from
`.mcp.json` files rooted at the session `cwd`
(`packages/coding-agent/src/mcp/loader.ts:58,64`, reached via the SDK wrapper
`discoverMCPServers(cwd)` at `sdk.ts:1408`), exposing each tool as `mcp__<server>__<tool>`.
The console does **not** re-declare servers: it sets each omp session's `cwd` to the
Kali-host vr-lab checkout, where `scripts/setup/bootstrap.sh` has already generated
`.mcp.json` from `.mcp.json.template` (substituting the checkout path for `__VR_LAB_ROOT__`;
9 in-repo servers: campaign/notes/lab/crash/fuzz/target/report/msrc/kb-mcp). The 3 external
servers (`binary-mcp` at `/opt/binary-mcp`, `ProxmoxMCP` at `/opt/ProxmoxMCP`, `knife-mcp`)
live in the user's **global** Claude Code MCP config, not the repo file
(`.mcp.json.template` header comment), and are discovered by the same mechanism on the host.
Generation (not `${VAR}` expansion) is required because `.mcp.json` does not expand `${VAR}`
in `cwd`, which every entry needs (`.mcp.json.template` header).

Readiness is the load-bearing detail: before the first prompt the backend awaits
`mcpManager.waitForStartup(timeoutMs)` then `session.refreshMCPTools(mcpManager.getTools())`
(`modes/print-mode.ts:414-419`), surfacing per-server readiness to the UI as a status strip
(kb-mcp in particular returns a structured "index not built" / "ollama unreachable" error
until Ollama + the LanceDB table exist — `.mcp.json.template` header; `mcp/kb-mcp/README.md`).
Tool activity reaches the browser as the `AgentSessionEvent` union surfaced in
`modes/print-mode.ts` — `tool_execution_start`/`tool_execution_update`, `tool_stream_update`,
`message_*`, `turn_*`. `printableEvent` (`modes/print-mode.ts:88`) is the reference shaping:
it strips streamed `message_update` snapshots and `providerPayload`, explicitly reshapes
`tool_stream_update` to `{type,toolCallId,toolName}` (`:92`), and passes
`tool_execution_*` through the `default` arm. The console consumes the union directly via
`session.subscribe` and persists the shaped frames in its `engine_rounds`/`events` store
(§3.4). This path is already proven in Phase 0 (`docs/vr-console/phase-0-spike.md`).

## 5.3 Gate authority stays on the host FS

**HARD CONSTRAINT 1.** `campaign-mcp` is the sole promoter — "Only `campaign-mcp` promotes a
finding" (`AGENTS.md`, line 112). The console can **display** gate state and **request** gate
operations by having the agent call the tool; it can never fake a promotion. `finding_promote`
(server.py:1150) refuses on any required gate not `passed`, and re-checks at promote time that
each gate's evidence file is still on disk ("`finding_promote` checks the files are still on
disk", `AGENTS.md` line 101). Upstream of that, a required gate cannot itself pass on a
falsified ledger: a finding whose `verification.invariant_violation` is recorded `falsified`
"cannot pass Gate 1A" (`docs/validation-gates.md:75`), so the promote is refused because 1A is
not `passed`. The console cannot and must not bypass this — its projection worker (§3.5) reads
through the portable campaign-mcp tools and owns no write path into `campaigns/`.

The one console affordance is a **gate-request flow**: a "Request promotion" / "Record gate"
button composes a prompt (or, in rpc mode, an `extension_ui_request` approval frame —
`modes/rpc/rpc-types.ts:794`) that the agent turns into `gate_record` / `evidence_add` /
`finding_promote` calls. A refusal (missing gate, missing on-disk evidence, below-floor
severity) is rendered verbatim as the lab intends ("obey the refusal", `AGENTS.md` line 5).
Promotion is thus always an agent action under the host lock, surfaced — never a console
mutation. `finding_promote` writes nine documents under one `flock` and is still not
transactional (`AGENTS.md` line 176), so the UI treats a promote as pending until the
projection re-reads `findings/`, never optimistically.

## 5.4 Brokering host-bound evidence operations

Host-bound operations (WinRM repro, Ghidra decompile, fuzz, kernel-debug, crash capture) run
only where their dependencies live. The console **brokers**: it drives the *Kali-host* omp
session, whose MCP client reaches the host-bound servers. Example — a Gate 1A repro (an agent
orchestration, each tool verified to exist; ProxmoxMCP is external so its tool name is
illustrative):

```
console ─prompt─► Kali-host omp session
  └► ProxmoxMCP: revert canary to its *-clean-pre-repro snapshot   # VM lifecycle (lab-mcp README:5)
  └► lab-mcp.capture_build_info            # CurrentBuild+UBR → captures/, ready for evidence_add (lab-mcp README:15)
  └► lab-mcp.run_repro_lowpriv            # PoC under the host lowpriv (standard_user) via scheduled-task over WinRM (README:20)
  └► lab-mcp.windbg_analyze_dump ─► crash-mcp.crash_parse_windbg_log  # filesystem handoff, no cross-MCP call (README:22)
  └► campaign-mcp.evidence_add(gate1a…) ─► gate_record(gate1a_canary_clean_repro, passed)
```

There is deliberately **no `revert_and_run`** tool (lab-mcp README:28-30): the chain is an
agent orchestration across ProxmoxMCP + lab-mcp (`docs/orchestration.md` Recipe 3), so each
failure is attributable to a step the console can show. "Servers do not call each other"
(`AGENTS.md` line 112) — the windbg→crash handoff is a filesystem read, not a cross-MCP call.
The console adds no new transport — it schedules these as omp sessions with `cwd` on the host,
honoring the **single-writer lease** (HARD CONSTRAINT 4): fuzz on torpedo, repro on canary,
each a distinct session/cwd, mapped to the §3.4 `console_sessions` row
(`role planner|worker`, `adapter in_process|rpc`, `UNIQUE(cwd) WHERE status='active'`).
`winrm_run` independently refuses a fuzz workload routed at a verification host
(`AGENTS.md` line 131-133), so the console never has to enforce VM role itself.
binary-mcp stays the decompile of record and "the only coverage mark that counts"; knife-mcp
output is a lead only (`AGENTS.md`, Host CLI Toolchain, line 154-158). No research content
(binaries, decompiles) ever leaves for a third-party API — the console streams events, it
does not ship artifacts (HARD CONSTRAINT 2).

## 5.5 Programme / scope sync — the ARTEX H1/BC analog

ARTEX syncs programme scope from HackerOne/Bugcrowd/ScopeSentry into `company_scope` via a
background batch path that calls MCP tools directly without the approval popup
(`server/sync_scopesentry.go`, `db/scope_sync.go`, `integrations/h1/client.go`,
`integrations/bc/client.go` — all present in the ARTEX tree). vr-lab's scope authority is
different in kind: it is **dated, pinned reference snapshots on the host FS**, not a live API —
`docs/references/<platform>/` (microsoft `*.pdf`+`*.txt`, plus valve, chrome, hackerone,
linux, bench). `campaign_create` enforces a verbatim `clause_citation` (≥40 chars, ≥6 distinct
words, server.py:108-109) checked against the dated snapshot, plus a `boundary_category` from
the MSRC Servicing Criteria PDF (campaign_create docstring, server.py:73-77).

So the console's "programme sync" is a **snapshot reader + ingest surface**, not a scope
writer: a Programmes view lists the dated snapshots and flags staleness; a target panel
projects `target-mcp` ROI (`target_recommend` server.py:161 / `target_score` :137 /
`target_get` :128) and offers an ingest action driving `msrc-mcp`
(`msrc_fetch_month` / `msrc_diff_revisions` / `msrc_ingest` → `knowledge/msrc/<cve>.json` +
`knowledge/bug-class-lineage/<tag-slug>/<cve>.md`, msrc-mcp README:17-31) to back-fill
lineage. Re-revision signals (`msrc_diff_revisions` — a re-published CVE usually means an
incomplete patch, msrc-mcp README:19,44) surface as variant-hunt leads. The console never
widens scope — "an inventory delta is a note, never a wider allowlist" (`AGENTS.md` line 145).

## 5.6 Local-only kb-RAG prior-art recall

`kb-mcp` is a **recall-only** librarian over the lab's own records; it runs the heavy models
on the local RTX 3070 Ti via Ollama and reads a LanceDB index, and the MCP subprocess "never
loads a model into VRAM" and sends no content off-box (`mcp/kb-mcp/README.md:6-8`;
HARD CONSTRAINT 2). The console surfaces it two ways.

1. A **prior-art panel** on campaign-open: `kb-mcp` queries log to
   `.kb-index/query-log.jsonl`, and `campaign_create` verifies the `prior_art` stamp's
   `query_log_id` against that log, recording a `verified` flag
   (campaign_create docstring server.py:142-143; campaign-mcp README:53-59) — the console
   shows the consultation and its `verified` flag, making the query-before-hunt gate auditable
   in the UI. (A `kb_search` stamp is the only kind carrying a `query_log_id`; `target_history`
   leaves no trace — README:59.)
2. A **"have we touched this?"** recall affordance beside surfaces/findings, rendering kb hits
   as leads clearly badged **recall, not evidence**. `finding_verification_record` refuses any
   record naming `kb_ask`/`kb_search` as its provenance — "kb_ask/kb_search is RECALL ONLY"
   (`campaign-mcp` Recall-only guard, README:115-118; `campaign_mcp/storage.py:3372,3409`).
   The console mirrors that boundary in its own UI so a recall hit can never be dragged onto a
   gate.

---

**Constraint check:**

- **Gate authority on host FS** (§5.3): `campaign-mcp` sole promoter; console displays and
  requests, never mutates `campaigns/`.
- **Local-only kb-RAG / no content egress** (§5.6, §5.4): kb models stay on the local GPU;
  the console streams shaped events, never binaries or decompiles (HARD CONSTRAINT 2).
- **Host-bound tier brokered, not relocated** (§5.4): host-bound ops run on the Kali-host omp
  session; the console adds no transport and runs no WinRM/Ghidra/fuzz itself.
- **Single-writer lease** (§5.4, §3.4): one `console_sessions` row per cwd,
  `UNIQUE(cwd) WHERE status='active'`; concurrency is many sessions each with its own cwd.
- **omp unchanged** (HARD CONSTRAINT 6): all wiring is additive console behavior over omp's
  existing MCP client and `AgentSessionEvent` stream — no omp source is touched.
