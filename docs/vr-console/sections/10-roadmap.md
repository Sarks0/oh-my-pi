## 10. Roadmap, Milestones & Risks

The build is sequenced so **each phase ends on a running, demoable console** and
every phase depends only on seams the previous one proved. The transport line
(§1) is the pivot: Phase 0 exercised the in-process embed below it, so Phases
1–3 build the console *above* it without touching omp (HARD CONSTRAINT 6 — omp
stays an unmodified workspace dependency; the console is additive packages
`vr-console-server` + `vr-console-web`). Effort is in engineer-days for one
engineer; ranges compress with front/back parallelism once the WS frame contract
is frozen (the Phase 0 artifact).

```
P0 embed+WS ──► P1 console MVP ──► P2 domain depth ──► P3 scale/hardening
 (seam built)    single campaign     coverage/gates       concurrency+remote
 live-exercised  end-to-end from      graph + gate         N campaigns,
 embed/MCP/WS    the browser, real    tracker + evidence   remote transport,
 (model turn →   approval cards       viewer, programme    RSI lessons,
  first host run) (no auto-approve)    scope sync           bench calibration
```

### 10.1 Phase 0 — SDK embed + WS transport (seam built, structurally validated)

**Deliverable (on disk).** `packages/vr-console-spike` — one Bun process embeds
the omp SDK in-process (`createAgentSession`, `sdk.ts:1945`;
`omp-bridge.ts:39`), subscribes to the session event stream
(`session.subscribe`, `agent-session.ts:6014`; `omp-bridge.ts:53`), waits for MCP
readiness before the first prompt (`mcpManager.waitForStartup(timeoutMs)` then
`session.refreshMCPTools(mcpManager.getTools())`, mirrored from
`print-mode.ts:415-419`; `omp-bridge.ts:62-64`), shapes each event to kill
payload bloat (adapted `printableEvent`, `print-mode.ts:88`; `event-shape.ts`),
and fans the frames to a browser over `Bun.serve` WebSocket (`server.ts`,
`public/index.html`). It runs ephemerally with `SessionManager.inMemory(cwd)`
(`session-manager.ts:4703`) so the spike writes no on-disk session (and never
contends for the per-cwd writer lease).

**What was validated live, and what was not.** In a cloud session the
*structural seam* was exercised end-to-end: the Bun process boots, serves the
page, accepts the WS, `createAgentSession` resolves in-process, `subscribe` is
wired, the MCP manager starts, and `dispose()` tears down cleanly. **The
model-driven turn — prompt → streamed deltas → an MCP tool call →
`turn_end`/`agent_end` — was *not* completed there, because that cloud session
had no model credentials.** That path is proven *by construction* (the bridge is
`runPrintMode`'s subscribe→prompt→drain→dispose lifecycle with output
redirected to a WS, `print-mode.ts:479-487`), but it remains **the first Phase 1
smoke test**, run on the Kali host where omp's `discoverAuthStorage`/model
config exist. The spike's own success checklist (`phase-0-spike.md §1`) is
therefore partially open on exactly those model-turn boxes — this roadmap does
not claim them ticked.

**Decision locked.** The in-process embed is viable (no native-addon conflict,
the event bus is externally observable via `subscribe`, the MCP lifecycle is
drivable from outside). The `omp --mode rpc` subprocess seam
(`modes/rpc/rpc-mode.ts`) stays the Phase 3 isolation/scale fallback; because the
WS JSON frame schema (`phase-0-spike.md §8`) is the contract `vr-console-web`
renders against, **nothing above the transport line changes if we later switch
from in-process to rpc.**

### 10.2 Phase 1 — Console MVP (single campaign, end-to-end) — ~12–16 d

Promote the spike to `packages/vr-console-server` (§2) + `vr-console-web` (§4)
and run one real vr-lab campaign from the browser.

**Deliverables.**
- Server skeleton: config, Postgres pool, the `OmpSessionAdapter` promoted from
  the spike bridge, http+ws server (§2).
- **Campaign CRUD over the portable tier**: mirror `campaign.yaml` and the
  `surface/records/`, `hallucinations/`, `findings/` trees from the host FS into
  Postgres mirror tables (§3.3), driving the vr-lab verbs `campaign_create →
  surface_create → finding_create` (§5.1) through the brokered omp session.
- **Live chat transcript**: the spike's shaped event stream re-rendered in the
  ARTEX-style chat view (§4.2).
- **Approval cards (replaces auto-approve)**: remove `autoApprove: true`
  (`omp-bridge.ts:48`; option defined `CreateAgentSessionOptions.autoApprove`,
  `sdk.ts:1024`, consumed `agent-session-types.ts:207`) and wire the real gate —
  `setToolUIContext` (`sdk.ts:1042`) presenting `requestApproval`
  (`tools/approval.ts:844`) as an approve/deny card over the WS; **anything but
  an explicit approval resolves to `deny` — fail-closed** (`approval.ts:879,:882`;
  §7.1). This is the same seam omp's rpc UI drives via `extension_ui_request`
  frames (`rpc-types.ts:794`).
- **Projection sync**: a one-way host-FS → Postgres mirror loop (`src/db/projection/`,
  §3.5); divergence is healed by **re-reading the host FS, never by SQL
  writeback** (§3.1) — this makes HARD CONSTRAINT 1 a structural property.
- **Basic findings board + dashboard**: list findings/hallucinations and show
  cost from the ledger (`advisor_cost_changed` events + llm-usage mirror, §3).
- **Single-operator auth**: a single bearer/JWT, key file managed like the vault
  key (§8.3 `116`).

**Exit criteria.** From a browser, open a real vr-lab campaign on the Kali host,
send a prompt, watch streamed deltas and a **brokered** MCP tool call, **approve
a state-touching tool via a card** (not auto-approve), and see the resulting
finding/hallucination appear via projection sync. `autoApprove` is removed from
the default path; the only state-mutating tools that run do so after a human
card. (This exit criterion also closes the Phase 0 model-turn boxes left open in
§10.1, now with host credentials.)

**Dependencies.** §2, §3, §4, §7 drafts. Needs omp model/auth configured on the
host. Front/back parallelize once the WS frame contract is frozen.

### 10.3 Phase 2 — Domain depth — ~14–18 d

Make the console *better than a terminal* for VR by surfacing the domain model.

**Deliverables.**
- **Coverage graph**: surface census → reachability-state graph (antv/g6
  `G6Graph`, `@xyflow/react` available as fallback, §4.1) over the `surface-NNN`
  records (§5.1), rendering each surface's reachability state
  (`reachable | runtime_unreachable | blocked`, §5.1) as distinct badges.
- **Gate tracker**: a live per-finding view of the Windows gate ladder —
  `gate0_poc_compiles`, `gate1a_canary_clean_repro`, `gate1b_stable_repro`,
  `gate2_security_impact`, `gate2b_severity_bar`, `gate2c_dependency_origin`
  (Valve-only), `gate3_privilege_context`, `gate4_report_package`
  (`validation-gates.md:31-472`) — with a **request-promotion** button that asks
  the host omp session to invoke `campaign-mcp`'s `finding_promote` (§5.1). The
  console **displays gate state and requests promotion; it never computes or
  fakes one** (HARD CONSTRAINT 1 — `campaign-mcp` is the sole promoter and
  refuses on any missing required gate or missing on-disk evidence,
  `validation-gates.md` preamble). A promotion **refusal is surfaced verbatim**.
- **Evidence viewer**: render `evidence/<gate>/` artifacts (crash-dump
  summaries, repro logs, decompiles) read-only, streamed from the host through
  the broker to the **authenticated operator** only. The bright line is HARD
  CONSTRAINT 2: this research content travels over the console's own
  authenticated channel to a trusted human, and **never into a third-party model
  or API call** (kb-RAG stays local on Ollama+LanceDB; no binary/decompile ever
  enters model context routed off-host). *(Note: the viewer by design shows
  research content to the remote operator in Phase 3; the constraint it honours
  is "no third-party API egress", not "nothing leaves the host" — see §10.4 and
  R5.)*
- **Programme scope sync**: import the dated MSRC servicing PDF boundary,
  Valve/HackerOne and Chrome VRP scope + severity bars (the ARTEX H1/Bugcrowd
  sync re-pointed, §5), shown on target selection.

**Exit criteria.** Open a campaign and *see* its coverage graph, drive a finding
to Gate 4 through the gate tracker, view its evidence bundle in-browser, and have
a promotion **requested by the console and resolved on the host** (a
missing-gate/missing-evidence refusal rendered verbatim). Programme scope state
visible at target selection.

**Dependencies.** Phase 1 projection sync + approval seam. The omp MCP-tool
broker (§2 adapter / §5 tool surface) for `finding_promote`, gated by the
approval seam (§2.7 / §7).

### 10.4 Phase 3 — Scale & hardening — ~16–22 d

**Deliverables.**
- **Multi-session concurrency**: N campaigns, each its own `AgentSession` with
  its own `cwd`, **respecting the single-writer lease** — omp holds one per-cwd
  ownership lease, so concurrency is *one session per campaign cwd*, never two
  writers on one cwd (HARD CONSTRAINT 4; §6 `51-53`). The orchestrator (§6)
  supervises; where in-process memory pressure demands isolation, a session
  falls back to an `omp --mode rpc` subprocess (`modes/rpc/rpc-mode.ts`) with its
  own cwd — **no change above the transport line** (R1).
- **Remote operation over a mutually-authenticated transport (mTLS)**: let a
  remote `vr-console-web`/server drive the Kali-host broker. This **extends §8's
  trust model** — §8 as drafted specifies single-operator bearer/JWT auth and
  the host-bound-vs-portable boundary (§8 `80-116`) but does **not yet** specify
  the remote leg; Phase 3 adds a §8 remote-transport subsection requiring mutual
  TLS between the remote console and the host broker. The host-bound evidence
  tier is **irreducible**: the console orchestrates and *brokers* to the
  Kali-host omp; it does not itself run WinRM/Ghidra/fuzz (HARD CONSTRAINT 3).
  Vault (AES-256-GCM, agent-excluded, §8.2) holds programme tokens / VM creds.
- **RSI lessons**: capture ARTEX-style post-campaign learning (the `rsi_lessons`
  table, `artex/db/schema.sql:1464`) into console-owned tables, fed back to
  planner policy (§6).
- **Bench calibration**: wire the webtarget (VM 113) A/B harness so a
  scanner/tool's output is calibrated against **planted-detectable controls**
  before any programme target trusts a "clean" result — and a bench finding is
  **never** promoted as a finding (vr-lab bench discipline).

**Exit criteria.** Two+ campaigns run concurrently without lease contention; a
remote operator drives a campaign over mTLS; a promotion-refusal and a
scope-kill both **originate on the host and only display** in the console; a
bench run calibrates a tool before a programme target trusts it.

**Dependencies.** All prior phases; §6 orchestration, §8 security (incl. the new
remote-transport subsection).

### 10.5 Top risks & mitigations

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| R1 | **In-process embed degrades at N sessions** — one Bun process holding N agents + MCP clients + the native addon, under memory pressure | Med / High | P0 proved the seam; P3 falls back per-session to `omp --mode rpc` subprocesses (`modes/rpc/rpc-mode.ts`) **with no change above the transport line** (the WS frame contract is renderer-facing, `phase-0-spike.md §8`). Measure memory-per-session on the first host run. |
| R2 | **Auto-approve on a live lab** — a tool mutates canary/torpedo/Proxmox before the human gate exists | Med / **Critical** | Removing `autoApprove` is a hard Phase 1 exit criterion; the replacement `requestApproval` is **fail-closed** (non-approval → `deny`, `approval.ts:879,:882`; §7.1). Until the card ships, the spike/host runs are **read-only tasks only** (`phase-0-spike.md §7`). |
| R3 | **Projection drift** — the Postgres mirror diverges from host-FS truth | High / Med | One-way host-FS → SQL only; heal by **re-read, never writeback** (§3.1, §3.5). Gate/promotion authority never leaves `campaign-mcp` (HARD CONSTRAINT 1). |
| R4 | **Supply-chain compromise** — the ARTEX lineage's trojanized `tomicdd/artex` Docker image (`artex-backdoor-report.md`; source tree was never backdoored) | Low / Critical | **Build images locally, pin all deps, no third-party prebuilt image** (HARD CONSTRAINT 5). Vault key file + creds agent-excluded (§8.2). |
| R5 | **Research-content egress** — a binary/decompile reaches a third-party model/API | Low / Critical | kb-RAG stays local (Ollama+LanceDB); the evidence viewer streams host→**authenticated operator** over the console's own channel, never into model/API context (HARD CONSTRAINT 2). The constraint is *no third-party API egress*, which the remote viewer (§10.4) preserves. |
| R6 | **Single-writer lease contention** at concurrency | Med / Med | One `AgentSession` per campaign cwd; the orchestrator enforces one lease per cwd (HARD CONSTRAINT 4; §6). `SessionManager.inMemory(cwd)` (`session-manager.ts:4703`) for ephemerals that must not take a disk lease. |
| R7 | **omp SDK surface shifts under the fork** | Low / Med | Keep omp **unchanged** (HARD CONSTRAINT 6); the `OmpSessionAdapter` (§2) is the *single* integration seam, so a surface change is a one-file fix. Pin the omp workspace version. |
| R8 | **Scope-guard bypass** — an out-of-scope target is reached | Low / High | The egress kill stays **on the host** (`scripts/linux/mitm_scope_guard.py`); the console displays scope state and **cannot override it** (§8 `80-85`). |
| R9 | **Cross-section drift** — §7 (HITL) and §9 (observability) finals not yet cut; this roadmap cites their drafts | Med / Low | Freeze the WS frame + approval-decision contracts as the inter-section interface; reconcile §7/§9 finals against the cites here before Phase 1 code lands. |

**Critical path.** R2 gates Phase 1 shipping (no mutating tool runs before the
card); R1 gates the Phase 3 architecture choice (in-process vs rpc) and is
decided by the per-session memory measurement taken on the first host run.
Everything else parallelizes. The sequencing guarantees that at the end of every
phase there is a **running, demoable console** — and never an intermediate state
where host authority (`campaign-mcp` promotion), the approval gate, or the
scope-guard egress kill is bypassed.
