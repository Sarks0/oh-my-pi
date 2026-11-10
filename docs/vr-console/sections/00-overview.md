# VR Console — System Design

> A web UI for agentic vulnerability research, built as **additive workspace
> packages inside the oh-my-pi (omp) fork**, in ARTEX's architectural style,
> driving the vr-lab domain. omp stays **unchanged**; the console is new packages
> around it.

This is the master front matter for a ten-section design. Each section is a
sibling file (`01-architecture.md` … `10-roadmap.md`); consolidated registers are
in `99-registers.md`. Every claim in these documents is grounded in three repos on
disk — omp (`/home/user/review/oh-my-pi`), ARTEX (`/home/user/review/artex`),
vr-lab (`/home/user/review/vr-lab`) — and cited by `file:line`.

## Executive summary

VR Console is an operator cockpit that turns oh-my-pi — a headless coding-agent
CLI — into a browser-driven console for running vulnerability-research campaigns
against the vr-lab (Windows binary VR on a Kali host). It is modeled on **ARTEX**,
a Go+Next.js console that embeds the `norma` agent harness in-process and drives an
event-driven planner/worker engine over an asset-exploration graph. VR Console
reproduces that shape in TypeScript/Bun, substituting omp for norma and the vr-lab
campaign/surface/gate model for ARTEX's web-pentest asset graph.

Three load-bearing decisions define the system:

1. **omp is embedded, not forked.** `vr-console-server` imports
   `@oh-my-pi/pi-coding-agent` as a pinned workspace dependency and consumes its
   SDK (`createAgentSession` `sdk.ts:1945` → `session.subscribe`
   `agent-session.ts:6014` / `session.prompt` `print-mode.ts:485` / `dispose` /
   `mcpManager` / `setToolUIContext` `sdk.ts:1042`). The **primary** integration is
   the in-process Node SDK embed — the true analog of how ARTEX embeds norma. The
   **fallback** drives `omp --mode rpc`/`rpc-ui` as a subprocess for isolation,
   scale, and cross-host brokering. Both seams emit the same `AgentSessionEvent`
   union, so everything above a thin adapter is transport-agnostic. omp source is
   never touched (HARD CONSTRAINT 6).

2. **The host filesystem is the authority; Postgres is a one-way projection.**
   vr-lab's `campaign-mcp` owns campaign/finding/gate state as YAML+MD on the Kali
   host FS, and is the **sole promoter**: a finding is born in `hallucinations/` and
   leaves only via `finding_promote` into `findings/` (re-checking every required
   gate's `passed` status, on-disk evidence, severity bar, and dependency origin at
   promote time — `storage.py:4601-4744`) or into `rejected/`. The console
   **displays and requests**; it has no SQL write path into finding/gate state and
   therefore structurally cannot fake a promotion (HARD CONSTRAINT 1).

3. **The host-bound evidence tier is irreducible; the console brokers to it.**
   vr-lab splits into a **portable** record tier (campaign/notes/target/report/msrc
   — YAML+MD, drivable from anywhere) and a **host-bound** evidence tier
   (lab-mcp/WinRM, binary-mcp/Ghidra, fuzz on torpedo, crash capture, local kb-RAG
   on a GPU) that cannot move. The console orchestrates and brokers host-bound work
   to a Kali-host omp session; it never runs WinRM/Ghidra/fuzz itself, and no
   research content (binaries, decompiles) ever reaches a third-party API — kb-RAG
   is local Ollama+LanceDB (HARD CONSTRAINTS 2, 3).

**Phase 0 is built.** `packages/vr-console-spike` proves the one load-bearing seam
end-to-end — an external Bun process embedding the omp SDK in-process, awaiting MCP
readiness, shaping the event stream, and fanning frames to a browser over
WebSocket. The structural seam was exercised live in a cloud session; the
model-driven turn (prompt → deltas → MCP tool call → `turn_end`) was deferred only
for lack of model credentials there and is the first Phase 1 smoke test (see
`docs/vr-console/phase-0-spike.md` and §10.1 for the precise "validated vs
deferred" reconciliation).

## Unified system overview

VR Console is three planes plus an authoritative host filesystem. The **console
plane** (new packages) is a Next.js UI over a Bun server. The server embeds the
**omp harness** in-process (primary) or drives it as a subprocess (fallback). omp,
an MCP client only, reaches the **vr-lab MCP/host plane** across the host line —
the stdio boundary at which WinRM/Ghidra/fuzz stay put. Postgres holds projections
and the cost ledger only; campaign-mcp on the host FS holds the truth.

```
┌──────────────────────── CONSOLE PLANE (new packages) ───────────────────────┐
│  packages/vr-console-web   (Next.js 16 / React 19, adapted from artex/web)   │
│    campaign workspace · findings+gate tracker · surface/coverage graph ·     │
│    approval cards · evidence viewer · cost dashboard · prior-art/kb search   │
│        │  HTTP + WebSocket  (shaped AgentSessionEvent frames; Phase-0 contract)│
│        ▼                                                                      │
│  packages/vr-console-server  (Bun/TS)                                         │
│    engine (planner→N workers, analog of artex engine.go) · campaign runtime  │
│    · approval gate-broker · vault (AES-256-GCM, agent-excluded) · projection │
│    ───────────────────────────────┬──────────────────────────────┐          │
│      PRIMARY: in-process omp SDK   │   FALLBACK: omp --mode rpc/   │          │
│      embed (createAgentSession)    │   rpc-ui subprocess (JSON/stdio)│        │
│    ───────────────────────────────┴──────────────────────────────┘          │
│        │                                   Postgres (55-table schema):        │
│        │                                   MIRROR (read-only projection) +    │
│        │                                   CONSOLE-OWNED (sessions, llm_usage │
│        │  one AgentSession per campaign cwd  cost ledger, coverage graph,     │
│        │  (single-writer OS file lock)       approvals, mcp cache, vault)     │
└────────┼──────────────────────────────────────────────────────────────────────┘
         ▼
┌──────────────── omp HARNESS  @oh-my-pi/pi-coding-agent ──────────────────────┐
│  MCP CLIENT only (never a server) · per-session single-writer lease ·        │
│  AgentSessionEvent stream · ExtensionToolWrapper approval gate on every tool │
└────────┬──────────────────────────────────────────────────────────────────────┘
         │ MCP (stdio), auto-discovered from <cwd>/.mcp.json (generated) + host global config
╔════════▼═══════════════ vr-lab MCP / HOST PLANE ═══════════ THE HOST LINE ═══╗
║  PORTABLE record tier (YAML+MD; drivable from anywhere, projected to SQL):   ║
║    campaign-mcp (SPINE · SOLE PROMOTER · gate authority) · notes · target     ║
║    · report · msrc                                                            ║
║  HOST-BOUND evidence tier (IRREDUCIBLE — never leaves the Kali host):        ║
║    lab-mcp (WinRM→canary/stable/torpedo) · binary-mcp (Ghidra, /opt) ·       ║
║    fuzz-mcp (torpedo) · crash-mcp · kb-mcp (local Ollama+LanceDB RAG)         ║
║  + external: ProxmoxMCP, knife-mcp (host global config)   VM fleet over WinRM/RDP║
╚═══════════════════════════════════════════════════════════════════════════════╝
         ▲
         │ HOST FS = AUTHORITY: campaigns/active/<id>/ {campaign.yaml, surface/,
         │ hallucinations/, findings/, rejected/, evidence/<gate>/} — projected
         └ one-way into Postgres; promotion/gates/scope-egress never leave the host.
```

**Request/decision flow in one line.** The operator (or the console's planner
loop) prompts a per-campaign omp session; shaped events stream back over WebSocket;
a write-tier or host-bound tool call parks the turn on the approval seam
(`setToolUIContext` → `ExtensionUIContext.approve`, `extensibility/extensions/types.ts:372`)
and surfaces an approve/deny card; on approval the worker calls the brokered MCP
tool on the Kali host; `campaign-mcp` (not the console) decides any gate/promotion
outcome and the projection re-reads the result from the host FS.

**Deployment.** v1 is co-located on the Kali host, UI bound to `127.0.0.1` (ARTEX's
pattern). Later phases move the web/server tier off-host over mTLS or an SSH tunnel,
driving omp on the Kali host via `--mode rpc` — only shaped events and approval
frames cross the host line. All images build **locally** with pinned/digest-verified
deps (the ARTEX trojanized-image backdoor lesson — HARD CONSTRAINT 5).

## The seven hard constraints (how they land)

| # | Constraint | Enforced by |
|---|---|---|
| 1 | Gate authority on host FS; console may DISPLAY/REQUEST, never fake a promotion | `finding_promote` is a brokered MCP call; campaign-mcp re-checks gates + on-disk evidence + severity + origin at promote time; no SQL write path into finding/gate state (§1.3, §2.5, §3.6, §5.3) |
| 2 | Local-only kb-RAG; no research content to third-party APIs | kb-mcp is local Ollama+LanceDB; research-sensitive payloads blocked from cloud model providers; arg previews redacted to names/hashes (§3.3, §8.3, §7.4) |
| 3 | Host-bound evidence tier is irreducible; console brokers, never runs it | Console issues tool calls only; lab/binary/fuzz/crash/kb run on the Kali host omp (§1.1, §5.4, §6.1) |
| 4 | omp sessions single-writer; concurrency = multiple sessions, each own cwd | Per-session OS file lock (`session-storage.ts:1331`); one session per campaign cwd; `UNIQUE(cwd) WHERE status='active'`; in-memory sessions for read-only queries (§1.4, §2.3, §3.4) |
| 5 | Supply-chain: build images locally, pin deps | Build-local `artex:local` pattern; digest-pinned Postgres; omp dep pinned at `18.18.6` via `catalog:`; no pulled console image (§1.6, §2.1, §8.7) |
| 6 | Keep omp unchanged; the console is additive packages | `vr-console-server`/`vr-console-web` import omp; no edits to `packages/coding-agent` (all sections) |
| 0 | Phase 0 done: in-process embed + WS transport proven | `packages/vr-console-spike`; `docs/vr-console/phase-0-spike.md` (§1.1, §10.1) |

## Reading guide / table of contents

Read §1 first for the whole-system frame; §2–§3 for the server and its data; §4
for the UI; §5 for how the vr-lab domain binds in; §6–§8 for the agent, approval,
and security seams (the most safety-critical surfaces); §9–§10 for operations and
sequencing. Consolidated registers are in `99-registers.md`.

| # | Section | What it covers | Verdict |
|---|---|---|---|
| [01](01-architecture.md) | System Architecture & Deployment Topology | Three planes, in-process-primary / rpc-fallback, approval/gate seam, single-writer model, MCP wiring, deployment & packaging | solid |
| [02](02-backend.md) | Backend Service — `vr-console-server` | Module layout, `OmpSessionAdapter`, planner→worker engine, lifecycle, REST, WebSocket protocol, approval broker | needs-fixes |
| [03](03-data-model.md) | Data Model & Persistence | Host-FS-truth / Postgres-projection split, mirror vs console-owned tables, ARTEX→VR concept map, projection/sync worker, conflict rule | needs-fixes |
| [04](04-frontend.md) | Frontend — `vr-console-web` | ARTEX stack reuse, sidebar remap, campaign workspace tabs, findings+gate tracker, coverage graph, live event rendering | needs-fixes |
| [05](05-vrlab-integration.md) | vr-lab Domain Integration | Domain object model, wiring omp to the 12 MCP servers, gate authority, brokering host-bound evidence, programme/scope sync, local kb-RAG recall | solid |
| [06](06-orchestration.md) | Agent Orchestration, Skills & Subagents | Planner/worker over omp sessions, task-tool subagents, the 36 vr-* skills, bridged tool registry, model routing, lifecycle, autoApprove→real approval | needs-fixes |
| [07](07-hitl-approval.md) | Human-in-the-Loop & Approval Seam | The universal `ExtensionToolWrapper` gate, read-vs-mutating tiers (always-ask default), per-tool policy compilation, WS cards, ask-operator, audit | needs-fixes |
| [08](08-security.md) | Security, Trust & Multi-Tenancy | Trust boundaries, credential vault (AES-256-GCM, agent-excluded, token-blind integration), local-only RAG routing, scope/egress, supply chain, autoApprove controls, tenancy | needs-fixes |
| [09](09-observability.md) | Observability, Cost & Operations | Provider-computed cost ledger, transcripts & WS archive, `omp stats` reuse, OTLP export, operational runbook | needs-fixes |
| [10](10-roadmap.md) | Roadmap, Milestones & Risks | Phase 0→3 sequencing, deliverables & exit criteria, effort ranges, top risks & mitigations | needs-fixes |
| [99](99-registers.md) | Consolidated Registers | Key decisions, open questions, risks & mitigations, cross-section consistency check | — |

**Authority precedence when sections disagree.** Host FS + campaign-mcp is the
domain authority (gates, promotion, scope). §7 is authoritative on the approval
mechanics (tiers, default mode, policy compilation); §8 frames the surrounding
trust model and defers approval mechanics to §7. §3 is authoritative on table and
enum names; §2/§5 reference them. §6.4 and §7.3 are authoritative on the canonical
minted MCP tool-name spelling. Where a cite's line number drifts as finals are cut,
the symbol name and file are the stable anchor.
