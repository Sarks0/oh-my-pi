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


---

## 1. System Architecture & Deployment Topology

> VR Console is a web UI for agentic vulnerability research, built as **additive
> workspace packages inside the omp fork**, in ARTEX's architectural style,
> driving the vr-lab domain. omp stays **unchanged**; the console is new packages
> around it. Phase 0 already proved the one load-bearing seam — an external
> TS/Bun process embedding the omp SDK in-process and streaming its events to a
> browser over WebSocket — in `packages/vr-console-spike` (see
> `docs/vr-console/phase-0-spike.md`).

All `file:line` references below are to the three repos on disk:
`/home/user/review/oh-my-pi` (omp), `/home/user/review/artex` (ARTEX),
`/home/user/review/vr-lab` (vr-lab). Paths inside omp are relative to
`packages/coding-agent/src/` unless noted.

### 1.1 Three planes

```
┌──────────────────────── Console plane (new packages) ───────────────────────┐
│  packages/vr-console-web   (Next.js 16 / React 19, adapted from artex/web)   │
│        │  HTTP + WebSocket (shaped JSON frames — the Phase-0 contract)       │
│  packages/vr-console-server  (Bun/TS)  ── Postgres (projections + cost ledger)│
│        │                                                                     │
│        ├── PRIMARY : in-process omp Node SDK embed  (createAgentSession)     │
│        └── FALLBACK: omp --mode rpc / rpc-ui subprocess (JSON over stdio)    │
└───────────────┬──────────────────────────────────────────┬──────────────────┘
                │ one AgentSession per campaign cwd         │
┌───────────────▼────────────── omp harness ───────────────▼──────────────────┐
│  @oh-my-pi/pi-coding-agent  (MCP CLIENT only; per-session single-writer lease)│
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ MCP (stdio), auto-discovered from <cwd>/.mcp.json
╔═══════════════▼══════════ vr-lab MCP / host plane ══════════ THE HOST LINE ═══╗
║  PORTABLE record tier (YAML+MD state, drivable from anywhere):               ║
║     campaign-mcp (SPINE + sole promoter + gate authority) · notes · target   ║
║     · report · msrc                                                           ║
║  HOST-BOUND evidence tier (IRREDUCIBLE — never leaves the Kali host):        ║
║     lab-mcp (WinRM→canary/stable/torpedo) · binary-mcp (Ghidra, /opt) ·      ║
║     fuzz-mcp (torpedo) · crash-mcp · kb-mcp (local Ollama+LanceDB RAG)       ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

The **host line** is the MCP/stdio boundary. The console orchestrates and
**brokers to** the host-bound tier through omp tool calls; it never runs
WinRM/Ghidra/fuzz itself (HARD CONSTRAINT 3).

**On the host-bound / portable split.** This naming is the *project's* framing of
vr-lab's own structure, not a label vr-lab uses verbatim (vr-lab's nearest own
word is "host-pinned", e.g. the syzkaller lane design,
`vr-lab/docs/superpowers/specs/2026-10-31-syzkaller-lane-design.md:52`: "validation
happens on the host-pinned kernel … Fuzz evidence never substitutes for a gate").
The split is grounded in vr-lab's real tiering
(`vr-lab/docs/automation-phase/ARCHITECTURE.md:145-153`): nine **in-repo MCP
servers** own state and invariants (campaign/notes/lab/crash/fuzz/target/report/
msrc/kb), with **external services** `binary-mcp` (Ghidra, `/opt/binary-mcp`),
ProxmoxMCP and `knife-mcp` listed separately, plus a **VM fleet** reached over
WinRM+FreeRDP. The portable subset (campaign/notes/target/report/msrc) is just
YAML+MD records and can be driven from anywhere; the host-bound subset
(lab-mcp/WinRM, binary-mcp/Ghidra, fuzz on torpedo, crash capture, kb-RAG on a
local GPU) is irreducibly tied to the Kali host.

### 1.2 omp integration model

**PRIMARY — in-process Node SDK embed.** `vr-console-server` imports
`@oh-my-pi/pi-coding-agent` as a workspace dependency and calls
`createAgentSession(options)` (`sdk.ts:1945`; options interface
`CreateAgentSessionOptions` `sdk.ts:581`; result interface
`CreateAgentSessionResult` `sdk.ts:1036`). The result exposes `session`
(`sdk.ts:1038`), `mcpManager` (`sdk.ts:1044`), `eventBus` (`sdk.ts:1052`), and
`setToolUIContext(uiContext, hasUI)` (`sdk.ts:1042`). The server streams via
`session.subscribe(listener)` (`agent-session.ts:6014`, returns an unsubscribe
`() => void`), prompts with `session.prompt(text, { images })` (awaited as one
turn at `print-mode.ts:485`; it resolves when the turn settles), and tears down
with `session.dispose({ reason })` (`print-mode.ts:167`).

This is the true analog of how ARTEX embeds its `norma` harness in-process:
`artex/server/engine.go:17` imports `github.com/Autumn-27/norma/harness`, and
`engine.go`'s event-driven planner/worker loop (`engine.go:88-129`) drives it.
In-process is the default because it is lowest-latency (no stdio marshalling),
shares one Bun process and the `@oh-my-pi/pi-natives` addon, and exposes the full
event union directly. The reference driver to mirror is `runPrintMode`
(`print-mode.ts:155`) — the smallest existing headless lifecycle (subscribe →
wait for MCP → prompt → drain → dispose). The spike *is* `runPrintMode` with
output redirected to a WebSocket instead of stdout.

**The `AgentSessionEvent` union** is shaped before transport by `printableEvent`
(`print-mode.ts:88`). Shaping is **not optional**: it drops `message_update`
snapshots (keeping only the incremental delta; the authoritative message follows
in `message_end`) and strips `providerPayload`, because without it a single long
turn re-serializes its whole in-progress message on every delta — the omp authors
hit multi-GB transcripts (the `print-mode.ts:76-87` comment). The console reuses
this exact shaping for both transports.

**FALLBACK — `omp --mode rpc` subprocess.** `runRpcMode(session, options)`
(`rpc-mode.ts:1389`) speaks a JSON stdin/stdout protocol built for embedding; the
`rpc-ui` mode additionally routes tool UI over the wire
(`RpcModeOptions.setToolUIContext`, `rpc-mode.ts:1372`; `Mode` union includes
`"rpc-ui"`, `cli/args.ts:25`). The console uses this seam **when isolation or
scale demand a separate process**: a wedged native addon, a crash-prone
fuzz-adjacent session, driving omp on a *remote* Kali host over SSH, or simply
bounding blast radius. omp also ships Go/Python/Rust RPC client SDKs
(`oh-my-pi/sdk/{go,python,rust}`) if a non-TS component ever drives it. Both
seams emit the **same** `AgentSessionEvent` union, so the server's projection
layer is transport-agnostic above a thin adapter.

### 1.3 Approval seam (DISPLAY-and-REQUEST only)

The spike auto-approves. `autoApprove` is a direct `createAgentSession` option
(`sdk.ts:1024`) that maps to the session-config field
(`agent-session-types.ts:207`); Phase 0's §7 restricts it to **read-only** vr-lab
tasks because an auto-approving agent can execute real WinRM/Ghidra/fuzz/Proxmox
tools.

The real approval seam is `setToolUIContext(uiContext, hasUI)`
(`sdk.ts:1042`). In-process, the server supplies an `ExtensionUIContext` whose
approval callbacks resolve against a browser round-trip. Over `rpc-ui`, the same
requests arrive as `extension_ui_request` frames (emitted at `rpc-mode.ts:1226`,
`:1248`, `:1314`; implemented by `RpcExtensionUIContext` `rpc-mode.ts:1517`) and
are answered with `extension_ui_response`. **Both paths implement the same
`ExtensionUIContext` interface**, so the console builds one approval UI and binds
it to whichever transport is live.

Crucially, this seam governs only **tool execution**. **Gate authority stays on
the host FS in campaign-mcp** (HARD CONSTRAINT 1). The invariant is explicit:
"every suspected finding starts in `hallucinations/`. Only `finding_promote` can
move it to `findings/`, and only when all required gates have `status: passed`
with at least one recorded evidence file still present on disk (re-checked at
promote time)" (`vr-lab/mcp/campaign-mcp/README.md:5`). The console renders gate
and promotion state and issues `finding_promote` **as an MCP tool call through
omp** (`mcp__campaign-mcp__finding_promote`); campaign-mcp still re-checks every
gate and every on-disk evidence file at promote time and refuses on any gap. The
console can DISPLAY and REQUEST, never fake a promotion.

### 1.4 Process & concurrency model

omp sessions are **single-writer**, and the enforcement is stronger than a soft
convention. The lease is a **per-session OS file lock**, not a per-cwd advisory
flag: `FileSessionStorage.claimSession(sessionId, sessionPath)`
(`session/session-storage.ts:1331`) acquires `tryAcquireSessionLease(sessionId)`
(`:638`, an actual `FileLockHandle` over a `sessionLeasePath`) and returns `null`
when another live process already holds it — a non-owner then never writes the
file (the `isSessionLeaseHeld` comment, `session-storage.ts:642-655`, and
`session-manager.ts:1151-1181`). Default persistence is per-cwd session journals
via `FileSessionStorage` (the default storage across `session-listing.ts` /
`session-manager.ts`); pluggable sqlite/redis backends route through
`IndexedSessionStorage` (`session-storage.ts:254-255`). Note that
`claimSession?` is **optional** on the `SessionStorage` interface
(`session-storage.ts:243`): the file backend enforces via the OS lock, but a
pluggable backend enforces single-writer only if it implements the method. (This
resolves the draft's open question about whether the lease is advisory — on the
default file backend it is a real lock; crash-safety for a redis/sqlite deployment
depends on that backend's `claimSession`.)

Concurrency therefore comes from **multiple sessions, each with its own cwd**,
never two writers on one session. A campaign's cwd is its on-disk home
(`campaigns/active/<id>/`), which is exactly the directory MCP discovery reads
`.mcp.json` from. So:

- **One live session per campaign**, keyed by campaign cwd — a pool of in-process
  `AgentSession`s managed by a `SessionRegistry` in `vr-console-server`, each its
  own lease-holder.
- **Overflow / isolation → subprocess-per-session** via `--mode rpc`, same
  cwd-keying, when the in-process pool is saturated or a session must be
  sandboxed.
- **Ephemeral read-only queries** (surface reads, history) use
  `SessionManager.inMemory(cwd)` (`session-manager.ts:4703`, backed by
  `MemorySessionStorage`, "no file persistence") so they take **no on-disk lease**
  and cannot collide with the campaign's writer.

Before the first prompt, each session mirrors print-mode's MCP readiness wait:
`await mcpManager.waitForStartup(timeoutMs)` (`print-mode.ts:415`) then
`session.refreshMCPTools(mcpManager.getTools())` (`print-mode.ts:419`). Prompting
before MCP is ready makes tool calls fail (Phase-0 risk register).

### 1.5 MCP wiring: per-campaign vs host-global

omp is an **MCP client only**, never a server (`mcp/index.ts:4`,
"per-project `.mcp.json` configuration for connecting to [MCP servers]"). It
discovers servers from `<cwd>/.mcp.json` (or `mcp.json`) under the `mcpServers`
key (`mcp/settings.ts:17`, `mcp/oauth-reauth.ts:245`). vr-lab splits its wiring
along the same host line, which the console must respect:

- **In-repo stdio servers** (campaign/notes/lab/crash/fuzz/target/report/msrc/kb)
  are registered in a per-checkout `.mcp.json`, **generated** by
  `scripts/setup/bootstrap.sh` from `vr-lab/.mcp.json.template` (it substitutes
  the checkout path for `__VR_LAB_ROOT__`; the generated file is gitignored, and
  `cwd` per entry cannot use `${VAR}` expansion — hence generation). Each entry is
  a stdio server (`command: <venv>/bin/python -m <pkg>.server`, with `cwd`).
- **External host-bound services** `binary-mcp` (`/opt/binary-mcp`) and
  ProxmoxMCP (`/opt/ProxmoxMCP`) live **outside the repo** and are registered in
  the host's *global* omp/Claude MCP config, **not** in `.mcp.json`
  (`vr-lab/.mcp.json.template` header comment). So a console-launched session with
  `cwd` = a campaign dir picks up the in-repo tools from the generated `.mcp.json`
  and the host-bound tools from the host's global config — another reason the
  authoritative wiring, and the host line, stay on the Kali host.

### 1.6 Deployment & packaging

**v1 — co-located on the Kali host (localhost).** `vr-console-server` and the
host-bound MCP tier run on one machine; the UI binds `127.0.0.1` as ARTEX does
(`artex/docker-compose.yml:40` publishes `${ARTEX_BIND_ADDR:-127.0.0.1}:8787:8787`).
Sessions run in-process; cwd is a local campaign dir; no research content
(binaries, decompiles) ever leaves for a third-party API (HARD CONSTRAINT 2 —
kb-mcp is local Ollama+LanceDB, `vr-lab/.mcp.json.template` header).

**Later — remote console.** The web/server tier runs off-host and reaches the
Kali host over **mTLS or an SSH tunnel**, driving omp there via `--mode rpc`
subprocesses. The host line is where WinRM/Ghidra/fuzz stay put; only shaped
events and approval frames cross it.

**Packaging reuses ARTEX's docker approach, built locally.** ARTEX's
supply-chain lesson is in the tree: the trojanized `tomicdd/artex` Docker Hub
image was a backdoor (`artex/artex-backdoor-report.md:7,16`), and the one line a
look-alike repo changed was `docker-compose.yml:18` repointing to it
(`artex-backdoor-report.md:14`). This fork builds from checkout: the `artex`
service uses `build:` → `image: artex:local` with a comment that the previous
reference was "a third-party namespace whose repository is gone"
(`artex/docker-compose.yml:19-26`); "The image is built locally. There is no
published image to pull" (`artex/README.md:119`); and Postgres is pinned by
digest (`postgres:16-alpine@sha256:…`, `artex/docker-compose.yml:4`). VR Console
follows suit (HARD CONSTRAINT 5): a multi-stage Dockerfile (Next.js static export
→ Bun server) built locally, digest-pinned deps, a Postgres sidecar, and the UI
statically served by the server — ARTEX embeds its exported SPA via
`//go:embed all:webui/dist` (`artex/server/webui_embed.go:18-19`, build tag
`embedui`); the Bun server serves the Next.js static export analogously.

**The DB holds projections only.** Campaigns, surfaces, findings, cost ledger,
tool/skill usage, and approvals — the ARTEX schema (55 `CREATE TABLE`s in
`artex/db/schema.sql`) narrowed to vr-lab's model. Authoritative state stays on
the host FS and in campaign-mcp; the DB is a read-optimized projection the UI
renders and the server can rebuild. omp itself is untouched — the console is
additive packages only (HARD CONSTRAINT 6).

### 1.7 How the hard constraints land in the topology

| # | Constraint | Where it is enforced in this architecture |
|---|---|---|
| 1 | Gate authority on host FS; console may DISPLAY/REQUEST, never fake a promotion | `finding_promote` is an MCP tool call through omp; campaign-mcp re-checks gates + on-disk evidence at promote time (`campaign-mcp/README.md:5`). §1.3 |
| 2 | Local-only kb-RAG; no research content to third-party APIs | kb-mcp is local Ollama+LanceDB; v1 is localhost; binaries/decompiles never cross the host line. §1.6 |
| 3 | Host-bound evidence tier is irreducible; console brokers, does not run it | Console issues tool calls only; lab-mcp/binary-mcp/fuzz run on the Kali host. §1.1 |
| 4 | omp sessions single-writer; concurrency = multiple sessions, own cwd | Per-session OS file lock (`session-storage.ts:1331`); one session per campaign cwd; in-memory sessions for read-only queries. §1.4 |
| 5 | Supply-chain: build images locally, pin deps | Build-local `artex:local` pattern; digest-pinned Postgres; no pulled console image. §1.6 |
| 6 | Keep omp unchanged; console is additive packages | `vr-console-server`/`vr-console-web` are new workspace packages importing `@oh-my-pi/pi-coding-agent`; no edits to `packages/coding-agent`. §1.2, §1.6 |
| 0 | Phase 0 done: in-process embed + WS transport proven | `packages/vr-console-spike`; `docs/vr-console/phase-0-spike.md`. §1.1 |

### 1.8 Open questions

- Exact `ExtensionUIContext` shape the server must implement for approval
  round-trips — read `RpcExtensionUIContext` (`rpc-mode.ts:1517`) fully as the
  reference implementation, then mirror it for the in-process WS path.
- Remote transport choice for the `--mode rpc` fallback: raw mTLS stream vs
  SSH-forwarded stdio. (The single-writer question is now resolved — see §1.4.)
- Projection-rebuild strategy: whether the server tails omp session events into
  Postgres live, or periodically reconciles against the host FS (campaign-mcp
  records) as the source of truth, or both.


---

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


---

## 3. Data Model & Persistence — `vr-console-server/src/db`

A Postgres schema adapted from ARTEX's **55** tables (`artex/db/schema.sql`, 1708 lines;
55 `CREATE TABLE IF NOT EXISTS` statements), re-pointed from web-app-sec to
Windows/binary VR. ARTEX embeds its schema (`db/db.go:23`, `//go:embed schema.sql`) and
`Exec`s it on **every** startup, which is why it is written to stay idempotent
(`db/db.go:342`: "schema.sql is Exec'd on every startup, so it stays idempotent"). VR
Console does the same: the schema lives at `packages/vr-console-server/src/db/schema.sql`
and is applied at boot using the same idempotent patterns — `CREATE TABLE IF NOT EXISTS`,
`CREATE … INDEX IF NOT EXISTS` (e.g. `schema.sql:84-92`), and
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` for additive migrations (e.g. `intercept_pending`
at `schema.sql:1098-1100`, `vault_credentials.agent_visible` at `schema.sql:1546`).

## 3.1 The load-bearing split: host FS is truth, Postgres is a projection

**HARD CONSTRAINT 1.** `campaign-mcp` owns campaign/finding/gate state as YAML+MD under
`campaigns/active/<id>/` on the Kali host FS. A finding is *born* in `hallucinations/`
and leaves **only** via `finding_promote` into `findings/` or via `finding_reject` into
`rejected/` (`AGENTS.md`, "Core rule"; `storage.py:4536` `finding_promote`). Promotion is
not a status flip — it re-checks every required gate's `status == "passed"` **and**
re-validates that each required gate still has at least one evidence file on disk under
its own `evidence/<gate>/` directory, **plus** re-runs the severity-bar and
dependency-origin guards over the stored values, all at promote time
(`storage.py:4601-4688` evidence re-check; `:4697-4726` rating re-check; `:4734-4744`
origin re-check). Only then does it `_move_finding(... "findings")` and stamp
`state = "validated"` (`storage.py:4964-4981`). None of that authority can move into
Postgres. So the schema is **two populations**:

- **Mirror tables** — a one-way read projection of the host FS. Never written back to
  the host; a divergence is healed by re-reading the FS, never by pushing SQL.
- **Console-owned tables** — authoritative *only* in Postgres: runtime, cost ledger,
  coverage graph, approvals, registries. These have no YAML counterpart.

```
 Kali host FS (TRUTH)              vr-console Postgres
 campaigns/active/<id>/            ┌─ MIRROR (read-only) ──────────┐
   campaign.yaml      ──sync──►    │ programmes, targets, campaigns │
   surface/records/*  ──sync──►    │ surfaces, hypotheses, findings │
   hallucinations/*   ──sync──►    │ gate_records, submissions      │
   findings/*,gates   ──sync──►    └────────────────────────────────┘
   evidence/<gate>/*  ──path+hash─►  (paths & sha256 only, never blobs)
                                   ┌─ CONSOLE-OWNED (authoritative) ┐
   (no YAML analog)   ◄────────────│ console_sessions, engine_rounds │
                                   │ llm_usage, llm_records, approvals│
                                   │ coverage graph, mcp_servers,vault│
                                   └──────────────────────────────────┘
```

## 3.2 ARTEX → VR concept map

Every ARTEX line reference below is verified against `artex/db/schema.sql`.

| ARTEX table (`schema.sql:line`) | VR table | Mirror / Owned |
|---|---|---|
| `companies` :28 (+`h1_handle`,`h1_labels`) | `programmes` (msrc/valve/chrome/kernel_org) | Mirror |
| `company_scope` :116 | `programme_scope` (boundary_category, OOS, clause) | Mirror |
| `assets` :41 (type root_domain/app/…) | `targets` (kind driver/service/named_pipe/com/rpc/web/binary) | Mirror |
| `tasks` :509 | `campaigns` (projection of `campaign.yaml`) | Mirror |
| `findings` :1105 | `findings` + `hypotheses` | Mirror |
| — (gates in YAML) | `gate_records` | Mirror |
| `explorations`/`_nodes`/`_edges`/`_anchors` :154/171/249/277 | coverage graph (`coverage_nodes`/`_edges`) | Owned |
| `llm_usage` (`llm_usage.go:30`), `llm_records` (`commands.go:157`) | same names | Owned |
| `intercept_pending` :1077 / `intercept_rules` :1057 | `approvals` / `approval_rules` | Owned |
| `mcp_servers` :847 / `mcp_tools_cache` :887 | same (+ `tier` host_bound/portable) | Owned |
| `vault_credentials` :1520 (AES-256-GCM) | same | Owned |
| `platform_program_cache` :1635 (H1/BC) | `programme_cache` (H1/Valve descriptors) | Owned |

Dropped from ARTEX as web-only: `asset_intercept_rules` :1269 / `task_intercept_rules`
:1303 (OOS URL blocking — the VR scope guard is `programme_scope` + the dated MSRC PDF
clause enforced in `campaign_create`, not domain patterns),
`traffic_evidence_snapshots` :1171 / `finding_traffic_bindings` :1188 (HTTP exchange
capture — VR evidence is dumps/decompiles on the host FS), `finding_retests` :1137,
`agent_prompts` :818, and the H1/BC sync machinery.

## 3.3 Mirror tables (read-only projection)

Each mirror row carries the **stable host id** as natural key plus projection metadata so
upsert is idempotent and staleness is visible:

```sql
CREATE TABLE campaigns (
  id            TEXT PRIMARY KEY,              -- campaign-mcp campaign id (folder name)
  programme_id  BIGINT REFERENCES programmes(id),
  title         TEXT NOT NULL,                 -- campaign.yaml title (campaign_create, storage.py:1891)
  target        TEXT NOT NULL,                 -- campaign.yaml target
  platform      TEXT NOT NULL,                 -- windows|chrome|linux|valve|vendor:<slug>
  status        TEXT NOT NULL,                 -- active|archived
  research_contract JSONB NOT NULL DEFAULT '{}',-- campaign.yaml research_contract (storage.py:2144)
  prior_art     JSONB NOT NULL DEFAULT '{}',   -- campaign.yaml prior_art (storage.py:2151)
  boundary_category TEXT,                       -- campaign_create params (storage.py:1895-1899)
  service_intent BOOLEAN,                       -- campaign_create service_intent: bool (storage.py:1896)
  clause_citation TEXT,
  src_sha256    TEXT NOT NULL,                 -- hash of campaign.yaml body
  src_mtime     TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  projection_version INT NOT NULL              -- campaign-mcp schema version seen
);
```

`findings` projects `finding.yaml` (`FINDING_SCHEMA_VERSION = 2`, `hypothesis.py:48`).
The natural key `finding_id` is `finding-NNN`, allocated and resolved by scanning the
three state dirs `hallucinations/`, `findings/`, `rejected/` (`storage.py:1268-1279`
allocation; `_find_finding_dir` at `:2701`). The disposition that matters is **which
directory the finding lives in**, surfaced in `finding.yaml` as the `state` field — and
the field value does **not** equal the directory name for a promoted finding: the
directory is `findings/` but `state == "validated"` (`storage.py:4964-4981`). So the
projected enum is:

```
 directory          finding.yaml state   finding_list filter
 hallucinations/  →  hallucination     →  "hallucination"
 findings/        →  validated         →  "validated"
 rejected/        →  rejected          →  "rejected"
```

(`finding_list` accepts exactly `hallucination|validated|rejected|all`,
`storage.py:3016-3019` / `server.py:357`). The mirror stores both: `state` as the
projected enum and `dir` for the on-disk directory, so the UI never has to reverse-map.
`findings` also carries `bug_class`, `severity`, and `reject_reason`.

`hypotheses` projects the hypothesis block (`security_invariant`, `source`,
`sink{description,class}`, `attacker_control_required`, `suspected_failure`,
`confirmed_root_cause`) **and the verification ledger** — one row per dimension, with
**five** dimensions, not three:
`reachability | attacker_control | defense_failure | invariant_violation | boundary_impact`
(`vocab.py:479-485`, `VERIFICATION_DIMENSIONS`, declaration order is cheapest-first). Each
dimension's `status ∈ unknown | static_supported | runtime_observed | verified | falsified
| blocked` (`vocab.py:487-494`, `VERIFICATION_STATUSES`). The split matters for the mirror:
`runtime_observed` and `verified` are `RUNTIME_VERIFICATION_STATUSES`
(`vocab.py:501`) — they assert something was *seen to happen* and require an evidence
artifact on disk (`finding_verification_record` refuses them without one), whereas a
decompile earns at most `static_supported`. Gate 1A/2 rest on these dimensions reaching a
runtime status.

`gate_records` projects each gate as
`(finding_id, gate_name, status, evidence_paths TEXT[], evidence_sha256 TEXT[],
evidence_present BOOL)` where
`gate_name ∈ gate0_poc_compiles, gate1a_canary_clean_repro, gate1b_stable_repro,
gate2_security_impact, gate2b_severity_bar, gate2c_dependency_origin,
gate3_privilege_context, gate4_report_package` (`gates.py:5-61`, `DEFAULT_GATES`) and
`status ∈ not_started | in_progress | passed | failed | blocked | not_applicable`
(`gates.py:130-137`, `ALLOWED_GATE_STATUSES`). Note that `gate1b_stable_repro` and
`gate2c_dependency_origin` are `required: False` in the baseline and only flipped to
required per-profile (Windows flips `gate2b`; Valve flips `gate2c` —
`gates.py:22-52`), so `required` is profile-derived, not a fixed column.

`surfaces` projects `surface/records/<surface-NNN>_<slug>/surface.yaml`
(component, five-state reachability, sink class, attacker principal, open/closed status —
`surfaces.py:86` `build_surface_record`).

**Evidence is referenced, never copied in.** `gate_records.evidence_paths` holds host-FS
paths (relative to `evidence/<gate>/`) and `evidence_sha256[]`; dumps, decompiles and PoC
artifacts stay on the host (HARD CONSTRAINT 2: no research content to any third party;
HARD CONSTRAINT 3: the host-bound tier is irreducible). Postgres is a searchable index
over them, not a store.

## 3.4 Console-owned tables

- **`console_sessions`** — one row per live omp `SessionAdapter` (§2.2):
  `(id, campaign_id, cwd, role planner|worker, lease_holder, adapter in_process|rpc,
  status, started_at)`. omp's own cross-process **ownership lease** is keyed by session id,
  not by cwd (`session/session-storage.ts:536`, "ownership leases by session id";
  claim/hold machinery at `:601-643`), but omp pairs one default session to a cwd and a
  writer without the lease is pushed aside as `contested`/`open-elsewhere`
  (`session-manager.ts:887-896`). The console enforces the matching **single-writer** rule
  (HARD CONSTRAINT 4) as its own DB invariant: a partial unique index
  `UNIQUE(cwd) WHERE status='active'` refuses a second active writer on one cwd. Concurrency
  is multiple sessions each with its own cwd — which is exactly omp's model
  (`SessionManager.inMemory(cwd)` for ephemeral per-cwd managers,
  `session/claude-session-store.ts:435`).
- **`engine_rounds`** / **`events`** — planner-round log and the shaped-event activity
  store behind the WS `seq` cursor (§2.6), analog of ARTEX `activity` (`schema.sql:299`,
  `kind` + `metadata JSONB`): `(campaign_id, seq BIGSERIAL, frame JSONB, ts)`, replayed on
  reconnect. The `frame` holds a shaped `AgentSessionEvent` (the union surfaced in
  `modes/print-mode.ts`), never a raw provider payload.
- **`llm_usage`** (metering, no bodies — `llm_usage.go:30`) and **`llm_records`** (full
  req/resp, gated debug — `commands.go:157`): the cost ledger, keyed by
  `campaign_id`/`console_session_id`. Deliberately **no FK**, so stats survive campaign
  deletion — ARTEX's explicit rule (`schema.sql:921`: "Deliberately no foreign keys: stats
  must survive task/conversation deletion (same as llm_usage)").
- **`approvals`** — pending tool-approval decisions the gate-broker (§2.7) raises for the
  host-bound tier, modeled on `intercept_pending` (`schema.sql:1077`):
  `(id, console_session_id, tool_name, tool_input JSONB, status pending|allowed|denied|
  timeout, reason, decided_at, decision_source)` — the status CHECK and `decision_source`
  column come straight from ARTEX (`schema.sql:1085-1086, 1099-1102`).
- **`coverage_nodes`/`coverage_edges`** — the reasoning graph (ARTEX `exploration_*`,
  `schema.sql:154-277`) retyped for VR: node `kind ∈ surface|hypothesis|gate|finding|
  intent`, edge `rel ∈ covers|yields|proves|spawns`. Console-owned because it is the
  console's own planner bookkeeping; the authoritative surface/finding rows are the
  mirror, which these nodes *reference* by host id.
- **`mcp_servers`/`mcp_tools_cache`** (`schema.sql:847-900`) — the 9 in-repo + 3 external
  vr-lab servers, each tagged `tier ∈ host_bound|portable` so the UI and broker know what
  may only run on the Kali host (lab/binary/fuzz/crash/kb-RAG) vs what is portable
  (campaign/notes/target/report/msrc). `mcp_servers.transport` reuses ARTEX's
  `stdio|http|sse` CHECK (`schema.sql:850`).
- **`vault_credentials`** (`schema.sql:1520`) — unchanged: AES-256-GCM `secret_enc`
  (`"v1:" + base64(nonce‖ciphertext‖tag)`, never returned raw — `schema.sql:1529`),
  `secret_hint` for lists, `agent_visible` (`schema.sql:1546`) to exclude platform infra
  from agent tools. Key beside the data dir, never in it.

## 3.5 The projection/sync worker (`src/db/projection/`)

`projection.ts` runs a single-direction **host FS → Postgres** sync. It never calls a
write tool; it reads through the **portable** campaign-mcp tools the console already
brokers to the Kali-host omp session (§2.5) — it does not touch the host FS directly.
All of these are real exposed tools: `campaign_list` (`server.py:245`) / `campaign_get`
(`server.py:260`), `finding_list` (`server.py:357`) / `finding_get` (`server.py:372`),
`surface_list` (`server.py:521`), `campaign_summary` (`server.py:1323`). Their record
content (campaign/finding/surface YAML) is the portable tier the console is allowed to
drive from anywhere; host-bound evidence stays put, only its path+hash is projected.

```
 trigger ─┬─ engine FS-change wake (campaign dir mtime)  ─┐
          ├─ worker turn_end / tool_execution_end event   ├─► reconcile(campaign_id)
          └─ periodic poll (fallback, 30s)                ─┘        │
 reconcile: campaign_get + finding_list/get + surface_list         │
            → diff by src_sha256 → upsert changed mirror rows ◄─────┘
            (gate_records.evidence_present = fs.exists(path))
```

Reconcile is **idempotent and diff-gated**: a row is rewritten only when `src_sha256`
changed, so a poll over an unchanged campaign is cheap. Because the projection drives the
same portable tools, it is also subject to campaign-mcp's advisory `flock`
(`AGENTS.md`, "One session per campaign") — the worker is a reader, so it never contends
for the write lock, and a projection read never blocks a hunting session's write.
`evidence_present` is recomputed from the host FS on every reconcile (via the same
path+exists check `finding_promote` itself performs at `storage.py:4647-4688`), so the
console's gate display matches what `finding_promote` would re-check — it never shows a
green gate whose evidence has been deleted off disk.

## 3.6 Conflict rule & gate authority

**The host FS always wins. Postgres never writes campaign/finding/gate state back.**
When a mirror row and the YAML disagree, the YAML is re-projected and the SQL row is
overwritten; there is no merge and no push path. The console's *only* mutation of gate
state is a **request**: the `/api/campaigns/{id}/gates/request` endpoint (§2.5) prompts
the Kali-host omp session to *attempt* `finding_promote`, and returns the host's result
verbatim — including its refusal shape (`ok=False` with `missing_required_gates` /
`absent_gates`, `storage.py:4638-4645`). The schema has **no** `UPDATE` path into
`findings`, `gate_records`, or `hypotheses` from any HTTP handler — those tables are
written exclusively by `projection.ts`. This makes HARD CONSTRAINT 1 a structural
property: the console **cannot** fake a promotion, because the authoritative bit
(`state = "validated"`, i.e. the finding directory moved into `findings/`) only ever
arrives in Postgres by re-reading a directory move the host FS performed, and that move is
guarded on the host by the on-disk evidence, severity-bar and dependency-origin re-checks
listed in §3.1.

## 3.7 Supply chain & constraints

Schema and migrations are in-tree (`src/db/schema.sql`), applied by the server, never a
pulled image (HARD CONSTRAINT 5; ARTEX backdoor lesson —
`artex/artex-backdoor-report.md`: the trojan was a ~160-byte `server.verifyCaptcha`
function compiled into the `tomicdd/artex` **image**, not present in any source tree, so
build-local + pin is the control that defeats it). The Postgres sidecar pins a digest
(the report flags `postgres:16-alpine` as unversioned-by-digest as the one residual —
`artex-backdoor-report.md` §C). No mirror table holds a binary, decompile, or PoC body —
only metadata, paths and hashes (HARD CONSTRAINTS 2, 3). omp is untouched: this is all in
`packages/vr-console-server` (HARD CONSTRAINT 6).

**Open questions:** (1) exact `src_sha256` granularity for multi-file findings
(per-`finding.yaml` vs whole-dir manifest — a finding's evidence and verification ledger
live in sibling files, so a per-`finding.yaml` hash can miss a gate-evidence change);
(2) whether `events` should retain full history or a rolling window with cold events
spilled to a `.tar.zst` like ARTEX `task_archives` (`schema.sql:583`); (3) whether the
coverage graph should be seeded from campaign-mcp surface records at first sync or built
purely from planner intents; (4) whether `console_sessions.cwd` should be stored as the
campaign's working directory on the Kali host (for the in-process adapter the server and
omp share a FS; for the rpc adapter they may not), since the `UNIQUE(cwd)` invariant only
holds within one host's namespace.


---

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


---

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


---

## 6. Agent Orchestration, Skills & Subagents

How the VR Console actually *runs* agents: the planner/worker loop over omp
sessions, subagents, the 36 vr-* skills, the bridged tool registry, model
routing and per-campaign policy, run lifecycle, and the auto-approve → real
approval transition. omp stays unchanged (HARD CONSTRAINT 6); everything here
lives in `packages/vr-console-server` and consumes omp only through its exported
SDK surface.

### 6.1 Planner/worker mapped onto omp sessions

ARTEX's `server/engine.go` is a real event-driven loop: on asset/exploration-graph
change (debounced) it wakes a **planner** LLM agent that reads the route, queries
assets, judges goals and emits intents; **N concurrent work agents** claim intents
and execute them (`server/engine.go:86-98`, the `Engine` doc comment). omp has
**no built-in planner/worker engine** — its native unit is *one* `AgentSession`
that plans for itself (todo-tracker) and fans out via the task tool. So the
console reproduces engine.go's outer loop **in TS, above omp**, exactly as
engine.go sits above `norma`:

```
 vr-console-server (TS)                          host FS (authority)
 ┌───────────────────────────┐
 │ CampaignOrchestrator      │  watches campaign.yaml / gate evidence
 │  = engine.go planner loop │  (portable tier: YAML+MD)
 │   • surface selection     │
 │   • cadence / round sep.  │
 │   • steer / pause / abort │
 └──────────┬────────────────┘
            │ prompt() / steer()         ┌──────────────────────────┐
            ▼                             │ campaign-mcp (host)      │
   per-campaign omp AgentSession  ──────▶ │  gates + finding_promote │
   (worker/main; cwd = campaign dir)      │  = SOLE promoter         │
            │ task tool (fan-out)         └──────────────────────────┘
            ▼
   read-only scouts (census, prior-art recall) in parallel
```

The **planner is the console orchestrator** (TS, not an omp construct); each
**worker run is a `session.prompt()` or `session.steer()`** into a per-campaign
omp session. `session.prompt(text, options?)` is awaitable and resolves at turn
end — `prompt(...): Promise<boolean>` (`session/agent-session-handle.ts:146`),
awaited in the reference headless driver at `modes/print-mode.ts:485`. Within a
worker run, omp's own task tool fans out read-only subagents (§6.2). This is the
faithful analog of ARTEX and keeps omp untouched.

**Session placement respects the host-bound/portable split (HARD CONSTRAINT 3).**
Portable workers (campaign/notes/target/report = YAML+MD) run as **in-process**
omp sessions on the console host (primary integration — the true analog of ARTEX
embedding norma in-process). Host-bound workers (lab-mcp/WinRM, binary-mcp/Ghidra,
fuzz on torpedo, kb-RAG) cannot move; the orchestrator **brokers** those to a
Kali-host omp driven as `omp --mode rpc` (the fallback seam proven by the Phase-0
spike, `docs/vr-console/phase-0-spike.md`). The orchestrator itself never runs
WinRM/Ghidra/fuzz — it only orchestrates and brokers.

**Single-writer (HARD CONSTRAINT 4).** omp holds one per-cwd ownership lease over
its session store, so each concurrent campaign gets its **own cwd** (a campaign
working dir). Subagents spawned inside one session are children of that session
(read-only scouts share its cwd without writing; isolated subagents get their own
worktree — `task/worktree.ts`), so they never contend for a second writer on the
same dir. `SessionManager.inMemory(cwd)` (`session/session-manager.ts:4703`) backs
ephemeral scout runs that need no persisted JSONL. Concurrency = N sessions, N
cwds — never two writers on one dir.

### 6.2 Subagents: the omp task tool + vr-lab agent definitions

The task tool parameter schema is built dynamically from the active isolation /
batch / per-call-model flags (`task/types.ts:174-299`, `createTaskSchema`). The
single-call base item is `{ name?, agent='task', task, solutionSpace,
outputSchema?, schemaMode?, tools?, isolated? }` (`task/types.ts:77-109`); `model`
is a **gated** field, declared only when `task.perCallModel` (or seance) permits
it (`task/types.ts:192-196`, `gatedFields`). A **batch** call is
`{ context, tasks: Item[] }` whose items **run in parallel** (`task/types.ts:132-145`,
`taskSchemaBatch`; the `guardBatchAgent` wrapper forbids a top-level `agent` on a
batch). Bundled agents are `scout` (read-only), `reviewer`, `security-reviewer`,
`seance`, `task` (`spawns: "*"`, `model: @task`) and `sonic` (`model: @smol`) —
`task/agents.ts:45-75` (`EMBEDDED_AGENT_DEFS`). Agent frontmatter is `name,
description, tools?, spawns?, model?, thinkingLevel?, blocking?, prewalk?, advisor?`
(`task/agents.ts:21-31`, the `AgentFrontmatter` interface).

The console ships **vr-lab agent definitions** as `.md` files (markdown + YAML
frontmatter) under the campaign cwd's **`.omp/agents/`** — discovered with
**highest precedence** by `discoverAgents` (`task/discovery.ts:86-177`): the
ordered search is project `.omp/agents` → user `~/.omp/agent/agents` → enabled
extension/plugin roots → bundled, with **first-seen-wins** dedup by agent name
(`task/discovery.ts:107-168`). Proposed set, mirroring ARTEX's
`agents.role IN ('goals','main','planner','worker','assistant')` (the `agents`
table at `db/schema.sql:778`, constraint `agents_role_ck` at `db/schema.sql:801`):
`vr-surveyor` (read-only census; `spawns: ""`, `tools` limited to MCP reads),
`vr-analyst` (binary triage; host-bound, brokered) and `vr-reporter` (report
draft; portable). The `spawns` frontmatter gates fan-out via `resolveSpawnPolicy`
(`task/spawn-policy.ts:19-58`): `spawns: ""` (or `false`) → `enabled: false` (no
fan-out); a comma list → a narrow allowlist whose first entry is the default
agent; `"*"` (or omitted) → unrestricted. Read-only agents get `spawns: ""`; the
main worker gets a narrow allowlist, **never `*`**.

### 6.3 Skills: the 36 vr-* playbooks

vr-lab already runs on omp with `skills.includeSkills: ["vr-*"]`
(`.omp/config.yml`) — a **hard allowlist**: a skill name that does not match is
absent from the catalogue and from `/skill:<name>` (`extensibility/skills.ts:364-367`,
`matchesIncludePatterns`, `new Bun.Glob(pattern).match(name)`). The console
inherits this verbatim by setting the campaign cwd to a checkout carrying that
config; `loadSkills` discovers every `SKILL.md`, injects name+description into the
prompt, and exposes `/skill:<name>` (`modes/skill-command.ts`, which routes through
`getSkillSlashCommandName`/`parseSkillInvocation` from `extensibility/skills`). The
**36** skills (`vr-campaign-open`, `vr-gate-evidence`, `vr-crash-triage`, …;
`vr-lab/skills/vr-*`, count verified 36) need **no porting** — they are the same
files the CLI uses. The web UI surfaces the catalogue (name/description) and
renders a `skill_use` chip when a worker invokes one.

**Supply-chain caveat (HARD CONSTRAINT 5, adjacency).** The console must keep
`autolearn.enabled: false` (`.omp/config.yml`): autolearn gates *writing* managed
skills, not loading. But the allowlist does **not** fully fence managed skills —
the config's own comment warns that a managed/auto-learned skill **whose name
itself matches `vr-*`** would still be advertised; those files live under
`~/.omp/agent/managed-skills/` on the host and must be moved aside. So "managed
skills stay out of the catalogue" holds only for names that do not match `vr-*`;
the console/host provisioning must treat `~/.omp/agent/managed-skills/vr-*` as a
build-local hygiene item, not something the allowlist silently handles.

### 6.4 Tool registry: built-ins + bridged MCP tools

Each session exposes omp built-ins (`BUILTIN_TOOLS` — Bash, Read, Edit, Write,
Grep, Glob, task, …; re-exported from `sdk.ts:1091-1106`) plus **bridged MCP
tools**. omp is an **MCP client only** (never an MCP server): every vr-lab server
tool is minted into a registry key by `createMCPToolName`
(`mcp/tool-bridge.ts:540` → `mintMCPToolName:488`).

**The minted key uses a SINGLE underscore between server and tool, and sanitizes
non-`[a-z0-9_]` characters (hyphens included) to `_`** — `sanitizeMCPToolNamePart`
(`mcp/tool-bridge.ts:471-479`) then `` `mcp__${server}_${tool}` ``
(`mcp/tool-bridge.ts:500`). So the real registry keys are
`mcp__campaign_mcp_finding_promote` and `mcp__lab_mcp_winrm_run` — **not**
`mcp__campaign-mcp__finding_promote`. The doubled-underscore `mcp__<server>__<tool>`
form (which ARTEX's `mcphttp/client.go` emits natively) is the **Claude-Code
spelling a primed model reliably produces**; omp recovers it with
`canonicalMCPToolNameCandidates` (`mcp/tool-bridge.ts:584-613`), which re-mints
every `__` boundary back through `createMCPToolName` to the canonical key. This is
a real ARTEX↔omp divergence: **the console's tool-usage ledger must store the
canonical single-underscore omp key** (or canonicalize on ingest) so a call shows
up once, not under two spellings.

Readiness is explicit and must gate the first worker turn:
`mcpManager.waitForStartup(timeoutMs)` then
`session.refreshMCPTools(mcpManager.getTools())` (`modes/print-mode.ts:405-419`,
`evaluateReadiness`). The console projects usage into a per-campaign **tool-usage
ledger** (ARTEX `tool_usage` / `mcp_tools_cache`, §4), tagging each call
host-bound vs portable (by server: campaign/notes/target/report = portable;
lab/binary/fuzz/crash/kb-RAG = host-bound) so the UI shows where a run is blocked.

### 6.5 Model/provider routing + per-campaign policy

omp resolves models by **role alias** — prefix `@` (`MODEL_ROLE_ALIAS_PREFIX`,
`config/model-roles.ts:19`) over the role table `MODEL_ROLES`
(`config/model-roles.ts:56-95`: `default`, `smol`, `slow`, `plan`, `advisor`,
`task`, … each as `@<role>`) against the `ModelRegistry`
(`config/model-registry.ts`). ARTEX stores per-campaign policy as an ordered
**failover chain** in `task_llm_profiles` (`position` + `status IN
('ready','quota_exhausted')`; `db/schema.sql:708-713`) plus a per-agent default
(`agents.llm_profile_id`, `db/schema.sql:794`). The console maps this onto omp
**without new omp code**:

- **Per-campaign default model** → `CreateAgentSessionOptions.model` (a `Model`,
  `sdk.ts:624`) and/or `modelRole` (the alias whose chain retries walk,
  `sdk.ts:626`).
- **Failover chain** → omp's `retry.fallbackChains` settings (a per-role
  `role → chain[]` map resolved at session build; `config/settings.ts:3631-3642`,
  expanded transitively per `tiny/online-candidates.ts:169`). The session walks
  the role's chain on a retryable error.
- **Per-run / per-subagent override** → the task spawn's gated `model` field,
  guarded by `assertDispatchModel` — called with the model of **every main-loop
  request before it is sent; throw to refuse** (`sdk.ts:650-655`, invoked at
  `sdk.ts:4863`). For determinism, `disableModelFallback` (`sdk.ts:661`) and
  `disableServerSideFallback` (`sdk.ts:663`) pin a worker to its own model; both
  are exactly what omp's own per-call `model` subagents set.
- **Account scoping** → `oauthAccountPools` (`sdk.ts:621`; applied through
  `SessionAccountPoolScope`, `sdk.ts:2155`).

**HARD CONSTRAINT 2 (local-only RAG; no research content to third-party APIs):**
host-bound workers that touch binaries or decompiles are pinned to local/
self-hosted providers (kb-RAG Ollama, local inference) via a campaign policy. The
orchestrator enforces this **twice**: at session-create it hands the worker only
the local model(s) (via `model`/`modelRole` and a trimmed fallback chain), and it
installs an `assertDispatchModel` that **throws** if any dispatched model is not
on the local allowlist — so neither a fallback-chain hop nor a per-call override
can route a decompile to a remote API.

### 6.6 Launch / pause / resume / abort / steer

The orchestrator drives each session through the handle API
(`session/agent-session-handle.ts`):

| Action | omp call | line | ARTEX analog |
|---|---|---|---|
| launch run | `session.prompt(text, options?)` → `Promise<boolean>` | :146 | `worker.Execute` |
| mid-run course-correct | `session.steer(text, images?, options?)` | :148 | `steerBox` + PreToolUse drain (`engine.go:135-140`) |
| pause | `session.abort({ goalReason: "interrupted" })` | :150 | `Engine.Pause` (`engine.go:182`) |
| resume | `session.resume()` | :383 | loop stays alive, re-prompt |
| abort/delete | `session.dispose(options?)` | :159 | `Engine.AbortDelete` (`engine.go:203`) |

Steering is the key fidelity point: ARTEX's worker drains queued planner
corrections in its `PreToolUse` hook before its next tool call; omp's `steer()`
**queues a steering message for the next step boundary** (`handle:147` doc
comment), and the queued state is inspectable via `getQueuedMessages(): { steering,
followUp, liveSteered }` (`agent-session-handle.ts:378-379`). That gives the
console the same "redirect without restart" the engine relies on. Pause/resume
survive because omp sessions persist (file JSONL default; pluggable sqlite/redis).

### 6.7 autoApprove → real approval

Phase 0 sets `autoApprove: true` (option `CreateAgentSessionOptions.autoApprove`,
`sdk.ts:1024`; applied to the session at `sdk.ts:3791`; mirrored on
`agent-session-types.ts:207`) — every tool call runs unattended. The real seam is
**`setToolUIContext(uiContext, hasUI)`** on `CreateAgentSessionResult`
(`sdk.ts:1042`; implementation at `sdk.ts:4725-4727`, which stores the context in
`toolContextStore.setUIContext`). The console installs its own `ExtensionUIContext`
(interface at `extensibility/extensions/types.ts:332`).

**The per-tool-call approval hook already exists at the right granularity** —
`ExtensionUIContext.approve(prompt: ExtensionApprovalPrompt, dialogOptions?):
Promise<ExtensionApprovalAnswer>` (`extensibility/extensions/types.ts:372-375`).
It is driven for **every gated tool call** by the approval path:
`tools/approval.ts:860-882` does `if (ui.approve) { const answer = await
ui.approve({ full, compact, session?, grants? }); … }` and falls back to
`ui.select` only when a context omits `approve`. The answer is an
`ExtensionApprovalAnswer` (`types.ts:317`) — `"once"`, `"session"` (when the
prompt offers it), a listed grant `{ grant, always }`, or `"deny"` (anything else
is denied). So the console's in-process context implements `approve` to **marshal
the `{ full, compact }` prompt over the WebSocket to the browser as a card** and
return the operator's answer. No `before_tool` extension hook is needed; the RPC
transport proves the shape (`RpcExtensionUIContext implements ExtensionUIContext`,
`modes/rpc/rpc-mode.ts:1517`, emitting `extension_ui_request` frames of methods
`select`/`confirm`/`ask`, `modes/rpc/rpc-types.ts:794-827`) — the console's version
resolves the same interface **in-process** instead of over a pipe.

Policy for which calls raise a card: portable MCP **reads** auto-approve; **writes**,
out-of-scope hosts, WinRM/Ghidra/fuzz brokered calls, and **`finding_promote`**
raise a card. The scope guard auto-blocks out-of-scope targets before a card is
even shown.

**Gate authority stays on the host (HARD CONSTRAINT 1):** promotion is a worker
**tool call to the canonical `mcp__campaign_mcp_finding_promote`** against the
host FS, which refuses on any missing required gate or missing on-disk evidence.
The console can *display* gate state and *request* promotion via the card; it can
never fake one — there is no console-side promotion path, only the brokered tool
call into campaign-mcp.

### Open questions

- **Cross-host steering latency.** Brokering `steer()` to a Kali-host `omp --mode
  rpc` worker adds a round-trip; confirm the rpc input channel (`modes/rpc/rpc-input.ts`)
  accepts mid-turn steering (not only next-prompt), and whether the step-boundary
  queue semantics of in-process `steer()` are preserved across the rpc hop.
- **Fallback-chain exhaustion fidelity.** Whether omp's `retry.fallbackChains`
  (role→chain map) fully expresses ARTEX's `task_llm_profiles.status =
  'quota_exhausted'` position-skipping, or the orchestrator must track per-account
  exhaustion itself and rebuild the chain on session-create.
- **(Resolved) per-tool-call approval granularity.** The draft asked whether the
  in-process context exposes a per-call hook or needs a `before_tool` hook. It
  does: `ExtensionUIContext.approve` (`types.ts:372`), driven at
  `tools/approval.ts:860`. Residual work is only wiring the console's
  WebSocket-backed `approve` and confirming `hasUI: true` is passed so the
  interactive path (not the non-interactive fallback) is taken.


---

## 7. Human-in-the-Loop & Approval Seam

The approval seam is the single most safety-critical surface in the console: a
vr-lab worker's tools drive **real side effects** — WinRM into Win11 VMs
(`lab-mcp`), Ghidra/fuzz on torpedo, Proxmox snapshot/revert, and the only exit
from `hallucinations/` (`finding_promote`). Phase 0 ran with `autoApprove`
(`agent-session-types.ts:207`; SDK option `sdk.ts:1024`, which maps to a `yolo`
posture — `agent-session.ts:5809` resolves `"yolo"`), and the spike itself flags
that as unsafe on a live host (`phase-0-spike.md` §7: "Auto-approve on a live VR
host → read-only task only"). This section replaces `autoApprove` with a real
human gate built **entirely on omp's existing approval machinery** — two levers
the SDK already exposes, no omp change (Constraint 6):

1. **Session `Settings`** — the per-tool policy map (`tools.approval`) and
   approval mode (`tools.approvalMode`) that omp resolves on every call.
2. **`setToolUIContext`** — the `ExtensionUIContext` whose `approve()` renders the
   prompt. The console supplies one that pushes a WS card and audits the decision.

Everything else (ARTEX-style intercept ruleset, audit projection, `ask_operator`)
is additive code in `packages/vr-console-server`.

### 7.1 The universal approval gate (what we wire to, verified)

omp wraps **every** registered tool — native, MCP, host-bridged — in one gate
before dispatch, so the approval path is identical whatever the tool is:

> `// Wrap every tool with ExtensionToolWrapper so the per-tool approval gate runs
> // on every call site, regardless of whether any user extensions are loaded.`
> (`sdk.ts:3889-3894`)

Inside that wrapper (`extensibility/extensions/wrapper.ts`):

- Approval inputs are read from the session's own `Settings`:
  `resolveApprovalFromContext(context.settings ?? runner.sessionSettings)` yields
  `{ approvalMode, userPolicies }` (`wrapper.ts:269-271`; `resolveApprovalFromContext`
  at `approval.ts:97`), plus `approvalGrants` and `approvalRestrictions`.
- `resolveApproval(tool, resolvedArgs, approvalMode, userPolicies, grants, restrictions, context)`
  (`wrapper.ts:361`) returns a policy.
- **`deny` fail-closes before execution**: `throw denyError(...)` (`wrapper.ts:371-373`;
  `denyError` at `approval.ts:617`). No card, no run.
- **`prompt`** raises `requestApproval(uiContext, tool, resolvedArgs, …)`
  (`wrapper.ts:478`).

`requestApproval` (`approval.ts:844`) is the one chokepoint the console's UI
object answers:

- When `ui.approve` exists it calls `ui.approve({ full, compact, session?, grants? })`
  (`approval.ts:869`) and maps the answer; **anything but an explicit approval is
  `deny`** (`approval.ts:879`, doc at `:842`) — fail-closed.
- When `ui.approve` is absent it falls back to `ui.select(full, labels)`
  (`approval.ts:882`).
- `ExtensionUIContext.approve?()` (`extensibility/extensions/types.ts:372`) takes an
  `ExtensionApprovalPrompt` (`types.ts:291`: `full`, `compact`, optional `session`,
  optional `grants`) and returns `ExtensionApprovalAnswer` (`types.ts:317`):
  `"once" | "session" | "deny" | { grant: "folder"|"target"; always: boolean }`.
- The prompt runs inside `session.waitForUser(dialog)` (`agent-session.ts:1558`): it
  marks the agent blocked on `USER_AWAIT_ID` and holds it **non-interruptibly**
  (`{ interruptible: false }`, `agent-session.ts:1564`), resuming on resolve. The
  wiring that makes every tool dialog a user-wait: `trackUserWait` is bound to
  `session.waitForUser` (`sdk.ts:3767`) and applied to the stored UI context by
  `ToolContextStore.setUIContext` (`tools/context.ts:66`). So an open approval card
  parks the turn — no polling, no timeout-race against the model.

**Supplying the UI object.** `createAgentSession(options)` *returns*
`setToolUIContext: (uiContext, hasUI) => void` as a result field (`sdk.ts:1036`,
typed `sdk.ts:1042`), whose impl stores the context (`sdk.ts:4725-4726`). The
console calls it once per session after `createAgentSession` returns — exactly as
the TUI builds an `ExtensionUIContext` with a real `approve()` and calls
`this.ctx.setToolUIContext(uiContext, true)` (`modes/controllers/extension-ui-controller.ts:200,243`).

**In-process adapter (primary).** `packages/vr-console-server/approval/ui-context.ts`
implements `ExtensionUIContext` with a real `approve()` (not just `select`), so we
get the first-class card shape. `approve()` mints a pending id, pushes an
`approval_request` WS frame, and returns a promise resolved by the browser's
`approve` frame. `confirm`/`input`/`select`/`notify` (`types.ts:338-378`) are
implemented too — `ask_operator` (§7.5) rides `input`.

**Subprocess adapter (fallback).** Under `omp --mode rpc`, `RpcExtensionUIContext`
(`modes/rpc/rpc-mode.ts:1517`) implements `select`/`confirm`/`input`/`notify` **but
not `approve`** — so `requestApproval` takes the `ui.select` branch
(`approval.ts:882`), emitting an `extension_ui_request` `method:"select"` frame
(`modes/rpc/rpc-types.ts:794`), answered by `extension_ui_response`
(`rpc-types.ts:975`). The console's rpc client resolves it over the same WS card,
synthesizing the select choices via `approvalChoiceLabels` (`approval.ts:895`).
Same card UX, two transports (see open question (b) on the select-label fidelity).

### 7.2 The read-only-vs-mutating gate (CRITICAL — corrected)

omp's privilege axis is the **tool tier**: `ToolTier = "read" | "write" | "exec"`
(`packages/agent/src/types.ts:1075`), ranked in `TIER_RANK` (`approval.ts:132`). The
active mode caps the tier that auto-runs (`APPROVAL_MODE_MAX_TIER`,
`approval.ts:153-158`):

| mode | auto-runs up to (no prompt) | prompts |
|---|---|---|
| `always-ask` | **read** | write, exec |
| `always-ask-cached` | read + cached-granted targets | uncached write/exec |
| `write` | read, write | exec |
| `yolo` | read, write, exec | nothing |

Multi-target tools fold to the strictest decision, deny-wins (`strictestApproval`,
`approval.ts:143`). Missing settings fail closed to `always-ask` with no grants
(`resolveApprovalFromContext`, `approval.ts:105-107`).

**The load-bearing fact the draft got wrong.** MCP tools are **not** unclassified.
omp statically tiers every MCP-bridged tool as **`write`**
(`mcp/tool-bridge.ts:735` and `:893`: `readonly approval = "write" as const`), and
a tool that declares no approval at all defaults to tier **`exec`**
(`agent/src/types.ts:1096`; `normalizeDecision` default `approval.ts:295`). The
server-declared `readOnlyHint` is captured only for prewalk and **does not relax
approval** — "approval stays conservative" (`tool-bridge.ts:733-734,770,930`). And
vr-lab's FastMCP servers declare no hints at all — the tools are bare `@mcp.tool()`
(`mcp/campaign-mcp/campaign_mcp/server.py:52` ff.), so `mcpReadOnlyHint` is
`undefined` for every vr-lab tool. **Consequence:** under the draft's proposed
default of `write` mode, every mutating MCP call — `lab-mcp` WinRM exec, Proxmox
revert, fuzz launch, `finding_promote` — is tier `write` and therefore
**auto-runs with no card**. That is the opposite of safe, and it contradicts §7.6's
own claim that `finding_promote` is carded.

**Corrected console policy.** The default campaign session runs **`always-ask`**,
not `write`. In `always-ask` only read-tier *native* tools auto-run; every
write/exec native tool prompts; and because omp tiers all MCP tools as `write`,
**every MCP tool reaches the gate**. The console then narrows that with omp's own
per-tool user-policy map (§7.3), so read-only lab/campaign queries auto-run,
out-of-scope calls fail closed, and mutating lab/VM/fuzz/promote calls always
raise a card. This is the console's hard read-only/mutating line, enforced through
settings omp already honors — no omp change.

### 7.3 Per-tool / per-MCP policy (ARTEX intercept → omp user policies)

omp resolves a per-tool user policy **before** the mode's tier comparison:
`resolvePolicy` consults `tools.approval.<key>` (`approval.ts:488`) ahead of the
mode fallback (`approval.ts:502`); a user `deny` fail-closes (`approval.ts:436`), a
user `prompt` forces the card, a user `allow` skips it. The key is the **exact tool
name** (`decision.policyKey ?? tool.name`, `approval.ts:401`) — omp has **no prefix
or glob matching** in this map.

So the ARTEX interceptor model (`intercept_rules`, `schema.sql:1057`: ordered rules
with `match_target ∈ {tool_name, tool_input}`, `match_type ∈ {string, regex}`,
`action ∈ {allow, deny, ask}`, `timeout_action` default **deny** `schema.sql:1069`)
is the console's **source policy**, but it is compiled down to omp's name-keyed map
at session build:

1. On startup, after `mcpManager.waitForStartup(timeoutMs)` and
   `session.refreshMCPTools(mcpManager.getTools())` (`modes/print-mode.ts:414-419`),
   enumerate the **live, minted** tool names.
2. Match each name against the pinned ARTEX-style ruleset.
3. Write the resulting `allow` / `deny` / `prompt` verdicts into `tools.approval`
   keyed by the exact minted name. `prompt` (ARTEX `ask`) is the human card.

**MCP tool names — the naming scheme the draft got wrong.** omp does **not** mint
`mcp__server__tool`. `createMCPToolName` (`tool-bridge.ts:540`) →
`mintMCPToolName` produces `mcp__${sanitizedServer}_${sanitizedTool}`
(`tool-bridge.ts:500`), where each part is lowercased and every non-`[a-z0-9_]`
char (hyphens included) collapses to `_` (`sanitizeMCPToolNamePart`,
`tool-bridge.ts:471-478`), with a redundant server-name prefix on the tool stripped
and names over 64 chars truncated + hash-suffixed (`capMCPToolNameLength`,
`tool-bridge.ts:533-538`). ARTEX's scheme is different — `"mcp__" + server + "__" +
name` (double underscore, server kept verbatim; `mcphttp/client.go:36`) — so the
two are **not** identical and ARTEX's names must not be used as omp policy keys.
For vr-lab's hyphenated servers the real omp keys are:

```
lab-mcp        → mcp__lab_mcp_<tool>        (e.g. mcp__lab_mcp_run_command)
campaign-mcp   → mcp__campaign_mcp_<tool>   (e.g. mcp__campaign_mcp_finding_promote)
notes-mcp      → mcp__notes_mcp_<tool>
target-mcp     → mcp__target_mcp_<tool>
fuzz-mcp       → mcp__fuzz_mcp_<tool>
crash-mcp      → mcp__crash_mcp_<tool>
binary-mcp     → mcp__binary_mcp_<tool>
msrc-mcp       → mcp__msrc_mcp_<tool>
kb-mcp         → mcp__kb_mcp_<tool>
ProxmoxMCP     → mcp__proxmoxmcp_<tool>
```

The console's own ruleset (matched in `vr-console-server` against these minted
names, *then* emitted as exact-name policies) therefore reads:

```
# read-only queries → allow (auto-run, no card)
allow  ^mcp__(campaign|notes|target|msrc|kb)_mcp_.*(get|list|history|ask|search|recommend)$
# every lab-mcp call (WinRM) → ask
prompt ^mcp__lab_mcp_
# host-bound compute → ask
prompt ^mcp__(fuzz|crash|binary)_mcp_
# mutations anywhere → ask
prompt ^mcp__.*_(promote|revert|snapshot|create|write|run|exec)
```

Because the match runs against the live roster at build time (not at call time),
truncated/hashed long names are matched as they actually mint, and the emitted
policy keys are exact. Omitted names fall through to `always-ask` mode and — being
tier `write` — still raise a card, so the default is fail-safe even for a tool the
ruleset forgot.

**Do not trust name heuristics as the read/write authority.** With no
`readOnlyHint` to lean on, the verb-suffix allowlist is a convenience, not a
classification: `notes-mcp` has mutators (`coverage_mark`) and `campaign-mcp`
mutators hold an advisory `flock` (vr-lab `AGENTS.md:169`). The pinned ruleset must
be **curated per tool** and reviewed, not generated from a regex and trusted.

**Scope / egress is NOT enforced at this seam.** The draft's claim that the
command-interception layer is "where the web lane's egress guard and the vr-lab
scope boundary live" is wrong on three counts, and asserting it would create a
false sense of containment:

- omp's `tools.approval` is keyed by **tool name only** — it cannot express a
  `deny` on `tool_input` (a domain/URL/CIDR) without an omp change (barred by
  Constraint 6). ARTEX's `tool_input` match (`schema.sql:1062`) has no omp
  equivalent at this seam.
- ARTEX's own asset-scope table says so honestly: `asset_intercept_rules`
  (`schema.sql:1269`) and `task_intercept_rules` (`schema.sql:1303`) gate **agent
  asset-registration operations, not runtime traffic** — "An agent that emits a
  Bash curl to a blocked domain is not stopped by this table"
  (`schema.sql:1700-1705`).
- vr-lab already owns egress enforcement on the host: CLI tools fail-closed through
  `scope_guard.py` and browser/proxy traffic through the guarded `mitm_scope_guard.py`,
  which **kills out-of-scope flows at egress**, with the dated asset capture as the
  sole scope authority (vr-lab `AGENTS.md:138-143`). Programme scope at campaign
  birth is gated by `campaign-mcp`'s `programme_scope_check`.

So the console enforces by **tool identity**; the **scope boundary stays on the
host** (mitmproxy + `scope_guard.py` + `campaign-mcp`). The console mirrors the OOS
rules (ARTEX sources suffix-domain rules from programme sync and tags them with a
`source` column, `schema.sql:1706`) **for display and audit**, and MAY add a
belt-and-suspenders arg check inside its own host-tool broker (§7.5, the subprocess
path it controls) — but it never claims to be the egress guard and never downgrades
a host scope-kill into a dismissible prompt.

**LLM fallback judge — opt-in, local-only.** Where a tool matched no rule, ARTEX
can consult an LLM fallback judge that runs **only** on unmatched calls
(`wireInterceptReviewer`, `server/intercept.go:31-35`), returning allow/deny with a
reason on a `judge` usage lane (`intercept.go:23,51`). The console offers this as an
**opt-in assist only**; the default for an unmatched **mutating** tool is `ask`
(human), never model-auto-allow. If ever enabled it MUST be bound to the local
kb-RAG model (Ollama) and fed **only redacted previews** — never a third-party API
and never research-bearing args (Constraint 2).

### 7.4 WS approval cards and the resolve protocol

```
 worker omp session           vr-console-server            browser
 ──────────────────           ─────────────────            ───────
 wrapper.ts:361 resolveApproval → "prompt"
 wrapper.ts:478 requestApproval
   │ ui.approve({full,compact,
   │            session?,grants?})          approval_request ─────▶  render card
   │   (parks in waitForUser,               frame {id,campaign,tool,  (full/compact,
   │    non-interruptible)       ─────────   args-preview,rule}        grant buttons)
   │                                                        ◀─── approve {id, answer}
   ▼ resolves "once"|"session"|            answer validated
     {grant,always}|"deny"  ◀────────────  against prompt.grants
```

The card carries `full`/`compact` (built at `approval.ts:859-868`), the matched
rule name, and a **redacted** arg preview, plus — when the prompt offers them — the
`grants` (`ExtensionApprovalGrant`, `types.ts:304`: `scope`, `label`, `alwaysLabel`)
and the `session` label. The browser's answer is validated back against
`prompt.grants` before it is trusted — an answer object whose `grant` is not one the
prompt listed degrades to `deny` (`approval.ts:876-879`). `session`/`always` grants
are recorded in omp's own grant store (`recordApprovalGrant`, `approval.ts:241`;
read via `getApprovalGrants`, used at `session-tools.ts:1206`) so repeat like-calls
stop prompting under `always-ask-cached`; the console surfaces that cache
read-only. **No research content crosses the WS** (Constraint 2): arg previews
strip binary blobs, decompiles and file bodies to names/hashes before the frame is
built.

Note the tier displayed on the card is advisory metadata the console attaches from
its ruleset match, not a field omp hands to `approve()` — `ExtensionApprovalPrompt`
is rendered strings plus grants (`types.ts:291`). The authoritative allow/deny
decision is omp's `resolveApproval` verdict; the card renders the human step for
the `prompt` branch only.

### 7.5 Operator handoff and ask-operator

Two distinct flows, both grounded in ARTEX:

1. **Agent-initiated `ask_operator`** — analog of `server/ask_operator.go:26`. A
   bridged host tool `ask_operator(question, image_path?)` (`ask_operator.go:36`) lets
   the worker request a captcha/OTP/decision or a one-line host command. In ARTEX it
   posts a user-role turn and **pauses the intent** (`applyIntentControl(..., "pause")`,
   `ask_operator.go:73`); the operator's reply resumes the run as the next input. The
   console registers it as an omp host tool (the `host_tool_call` frame,
   `rpc-types.ts:885`) whose handler emits an `operator_request` WS frame and resolves
   via `input()`; the answer returns as the tool result and the turn continues.
   Screenshots stage into the campaign's uploads dir (`ask_operator.go:83,99`), never
   off-host.
2. **Operator-initiated steer/handoff** — pause/steer/abort from the console sidebar
   (orchestration, §6) is a separate control channel; it interrupts via the session,
   not the approval seam.

### 7.6 Approval records and audit (the console's own projection)

Every decision is persisted to a console-owned table **modeled on** ARTEX's
`intercept_pending` (`schema.sql:1077`), not a verbatim copy. ARTEX's columns are
`id, rule_id, conversation_id, task_id, agent_name, tool_name, tool_input, status,
reason, decided_at, created_at`, with `status ∈ {pending, allowed, denied, timeout}`
(`schema.sql:1086`) and the later-added `audit JSONB` + `decision_source`
(`schema.sql:1095-1099`), whose backfilled values are `rule` / `model` / `unknown`
(`schema.sql:1099-1100`). The console's projection adapts that shape to its data
model:

```
id, campaign_id, session_id, agent_name,
tool_name (minted omp name), tool_input (redacted JSONB),
tier (console advisory), matched_rule,
status      ∈ {pending, allowed, denied, timeout},
decision_source ∈ {rule, human, model},   -- 'human' = a WS card answer; 'model' = the opt-in judge
reason, audit JSONB, decided_at, created_at
```

(`campaign_id`/`session_id`/`tier`/`matched_rule` are console additions over
ARTEX's schema; `status` keeps ARTEX's four values — a raised-but-unanswered card is
`pending`, not a new state.) A row is written at **raise** (pending) and updated at
**resolve**, so a crash leaves a `pending`/`timeout` forensic trail. This is the
console's answer to "who approved the WinRM exec that touched canary, and when" —
and it is **projection only**: the host FS and `campaign-mcp` remain the
gate/promotion authority (Constraint 1; vr-lab `AGENTS.md:112` — only `campaign-mcp`
promotes, `AGENTS.md:14-16` — `finding_promote` is the only exit from
`hallucinations/`). The console can DISPLAY and REQUEST a promotion; it can never
fake one — `finding_promote` (`mcp/campaign-mcp/campaign_mcp/server.py:1150`) is a
host-side MCP call the worker makes, itself behind a `prompt` card.

### 7.7 Constraint enforcement and open questions

1. **Gate authority on host FS** — approval records are projections;
   `finding_promote` is a host MCP call behind a card (§7.6), and the gate/evidence
   checks live in `campaign-mcp` (vr-lab `AGENTS.md:100-102`).
2. **No research content leaves** — arg previews redacted to names/hashes before any
   WS/API hop (§7.4); the optional judge is local-model-only (§7.3).
3. **Host-bound tier brokered** — mutating lab/VM/Ghidra/fuzz tools are tier `write`
   and forced to a card by seeded `prompt` policy under `always-ask` (§7.2–7.3); the
   server never execs them itself. Scope/egress stays on the host mitmproxy +
   `scope_guard.py`, not this seam.
4. **Single-writer** — one `ExtensionUIContext` per session/cwd (omp's one-writer
   lease); concurrency is N sessions, each with its own approval stream and audit
   rows.
5. **Build-local + pinned** — the default ruleset is a pinned in-repo file, not a
   fetched policy (ARTEX backdoor lesson).
6. **omp unchanged** — we only *consume* `Settings.tools.approval` /
   `tools.approvalMode`, `setToolUIContext`, and `requestApproval` → the
   `ExtensionToolWrapper` gate omp already installs on every tool (`sdk.ts:3889-3894`).
7. **Phase 0 proven** — this replaces the spike's `autoApprove` with the seam the
   spike already named (`phase-0-spike.md` §7, which points at `setToolUIContext` +
   `extension_ui_request`).

**Open questions.** (a) Host-bridged tools: confirm `ExtensionToolWrapper` wraps
host tools on the same path as native/MCP so `approve()` fires for them too — the
wrap loop is over `toolRegistry.values()` (`sdk.ts:3892`); verify host tools are in
that registry before relying on a card for `ask_operator`-class tools. (b) RPC path
has no `approve` frame, only `select` (`rpc-mode.ts:1517`); confirm the
`approvalChoiceLabels` fallback (`approval.ts:895`) renders acceptably as a card, or
add a host-side shim that reconstructs the first-class card from the select
choices. (c) Grant-cache lifetime across a reconnect: does the on-disk grant store
(`getApprovalGrants`) survive `session.dispose()`, or must the console re-seed
session grants on resume? (d) Enumeration timing: tools that reconnect mid-run
re-fire `refreshMCPTools`; the policy compiler (§7.3) must re-run on roster change
so a newly-appearing mutating tool is not left at mode-default without an explicit
`prompt` seed (it still cards under `always-ask`, but loses its rule name in the
audit). (e) LLM fallback judge — in or out for v1 (default: out for mutating tools).


---

## 8. Security, Trust & Multi-Tenancy

The console is an operator cockpit over a vulnerability-research lab. Its secrets
(programme API tokens, VM admin/lowpriv passwords) are *keys to other people's
systems*, and its agents hold the most dangerous capability in the stack —
`autoApprove`. This section ports ARTEX's vault/guard concepts to TS, binds them
to omp's **real** approval seam (`setToolUIContext` + `requestApproval`, not a
hook that omp does not have), and keeps the hard constraints (local-only kb-RAG,
host-FS gate authority, build-local supply chain). v1 is **single operator**; the
model is designed so multi-tenant is an additive layer, not a rewrite.

The approval *mechanics* (tool tiers, `requestApproval`, WS card protocol,
`ask_operator`) are specified in **§7 (Human-in-the-Loop & Approval Seam)**. This
section is the security/trust framing around them: what is secret, where trust
boundaries sit, how the console fails closed, and what multi-tenancy would add.

## 8.1 Trust boundaries

```
 operator browser ──auth──► vr-console-server (Bun) ──in-proc──► omp Node SDK
      (vr-console-web)            │  vault (AES-256-GCM, agent-excluded)
                                 │  guard (policy + ExtensionUIContext → approval)
                                 ▼
                          Kali-host omp sessions ──► vr-lab MCP servers
                          (campaign-mcp = gate authority, on host FS)
                          (kb-mcp = local Ollama+LanceDB, no egress)
```

Three irreducible rules sit on the *host*, never in the console: gate promotion
(`finding_promote`, campaign-mcp — AGENTS.md "Only `campaign-mcp` promotes a
finding"), scope egress kill (`scope_guard.py` / `mitm_scope_guard.py`), and
local-only RAG (kb-mcp). The console **displays and requests**; it never fakes a
promotion or relaxes a scope refusal (HARD CONSTRAINTS 1–3).

## 8.2 Credential vault — `packages/vr-console-server/src/vault/`

A faithful TS port of `artex/vault/` (`vault.go`, `secret.go`) + `artex/db/vault.go`.
ARTEX's store is Postgres (pgx, `$N` placeholders, SQLSTATE 23505); the console
port keeps the **column set and the two-path decryption discipline** but lands it
on `bun:sqlite` per the data-model section.

- **Cipher** (`cipher.ts`): AES-256-GCM, mirroring `vault.go:128` (`Encrypt`).
  Format is a `v1:` prefix + base64(nonce) ‖ base64(nonce-less sealed) which
  decodes back as one `base64(nonce‖ciphertext‖tag)` blob (the 12-byte nonce is a
  multiple of 3 bytes, so the two segments concatenate cleanly, `vault.go:138-142`
  / `:152`). A **fresh 12-byte random nonce per call** (`vault.go:133`) means
  encrypting the same secret twice never correlates across rows; the GCM tag
  authenticates nonce and ciphertext together. `decrypt` throws one generic
  "decryption failed (wrong key or corrupted/tampered ciphertext)" string that
  carries **no plaintext and no shape** (`vault.go:167`). Bun ships WebCrypto
  (`crypto.subtle` AES-GCM) and `node:crypto`; either satisfies this contract.
- **Key** (`key.ts`): a 32-byte key read from `${VR_CONSOLE_KEY_DIR}/vault.key`,
  created `O_EXCL` mode `0600` on first use, **never overwritten** (`vault.go:75`
  `LoadOrCreateKey`, `:107` `writeNewKey` O_EXCL race guard); a present-but-
  wrong-length key is a **fatal startup error**, because silently regenerating
  makes every stored credential undecryptable (`vault.go:85-86`). The key dir is
  **not** any browsable/served path — the same rule ARTEX states for `vault.key`
  living beside `jwt.key`, away from the file manager (`vault.go:26-29`).
- **Bundle** (`secret.ts`): the closed `Secret` type — `password | cookies[] |
  headers[] | api_key | text` (`secret.go:47-53`) with `kind ∈
  {password,cookies,api_key,custom}` (`secret.go:13-18`, validated in the store and
  CHECKed in SQL so UI selects stay total). Plaintext is marshalled to one JSON
  blob and encrypted as a unit (`secret.go:184` `Marshal`); the masked
  `…<last6>` hint (`secret.go:155` `Hint`) is the only thing list views ever carry.
- **Store** (`store.ts`): rows in a `vault_credentials(id, target, label, username,
  kind, secret_enc, secret_hint, note, agent_visible, created_at, updated_at)`
  table (column list `db/vault.go:146`). The ciphertext column (`secretEnc`) is
  **unexported and JSON-invisible** — any DTO built from the row physically cannot
  leak it (`db/vault.go:44`). Decryption exists in **exactly two code paths** — the
  operator *Reveal* endpoint and the agent `vault_get` tool — stated as an
  invariant in the package doc and implemented in `Reveal` (`db/vault.go:20-22`,
  `:411`).

**Agent-excluded (the core trust flag).** Each row carries `agent_visible`. When
`false` ("Exclude from agents"), the entry is for *server-side integration use
only*: `ListForAgents` filters it out at the SQL level (`db/vault.go:342-343`) and
`vault_get` runs a **visibility gate before any decryption** — `Get` returns the
row without touching the ciphertext, and an excluded entry is refused with one
generic agent-safe message, so a stale cached id cannot become an
existence/state oracle on excluded material (`tools_vault.go:143-158`). Agent-
*visible* secrets (a target login the agent must type) are honestly acknowledged
as exposed at retrieval time — "the secret becomes part of this conversation's
context the moment you call this" (`tools_vault.go:19-20`, `:97`) — which is why
`vault_get` is gated through the approval seam (§8.5, §7).

**How a programme API token lives in the console without ever entering an LLM
transcript.** The server-side consumer does *not* use `vault_get`; it uses the
sanctioned token-blind accessor `GetForIntegrationByTargetLabel`
(`db/vault.go:388`), which deliberately ignores `agent_visible` **because that
flag is a promise about agent-facing tools and this is the non-agent consumer the
promise carves out** (`db/vault.go:371-387`). Its contract: the resolved material
— identifier, token, ciphertext, and any lookup/decrypt failure detail — **never
reaches tool output, logs, or an agent-visible error**. ARTEX cannot enforce that
in the store ("a store cannot police its callers' error strings", `:385`); it
pins it with token-blind tests covering not-found, corrupt-ciphertext, and
storage-failure paths. **The console inherits that obligation**: its H1/Bugcrowd
integration consumes the token through this path, and its error handling must
render every failure as an opaque message in any agent-reachable context. This is
the mechanism behind "the H1 token is consumed by the console, never typed by a
model."

## 8.3 Local-only kb-RAG & the no-research-content rule

kb-mcp runs entirely on the Kali/GPU host: Ollama on the RTX 3070 Ti + a LanceDB
index, and it "answers questions *only* from retrieved lab records"
(`kb-mcp/README.md:4`, `:6-8`). The MCP subprocess is a thin HTTP client + index
reader that "never loads a model into VRAM"; the Ollama endpoint defaults to
`http://127.0.0.1:11434`, overridable only by `KB_OLLAMA_HOST`
(`kb_mcp/config.py:18`; documented at `README.md:329-330`). The console **must not
add a cloud egress path for research content.** Enforcement + surfacing:

- The console classifies any payload that may contain **binary/research content**
  (decompiles, raw bytes, crash dumps, Ghidra output) as `research-sensitive`.
  Such content is only ever routed to omp sessions whose configured model
  provider is on a **local/self-hosted allow-list** (Ollama, a local vLLM). The
  model-picker UI renders a provider as *disabled for binary content* when it is a
  third-party API (HARD CONSTRAINT 2). The permissible-provider list is config,
  pinned, and shown in the session header so the operator always sees where a
  decompile would go. (See **§8.10 open questions** — whether omp already has a
  local-model backend wired, or the console must add one, is unresolved and gates
  this route.)
- This is the lab's own **HOST-BOUND vs PORTABLE** split lifted into a routing
  policy: the portable tier (campaign/notes/target/report YAML+MD) may use a
  cloud model; the host-bound evidence tier (binaries, decompiles, dumps, the
  kb-RAG corpus itself) may not. The irreducibility is also physical — kb-RAG, the
  GPU, and the Ghidra cache the analysis corpus shadows all live on the Kali host
  (`kb-mcp/README.md:52-59`), which the console orchestrates but does not relocate
  (HARD CONSTRAINT 3).

## 8.4 Scope enforcement & out-of-scope auto-block

The console **never re-implements** scope logic; it brokers to the host's
fail-closed guards and *displays* their records. AGENTS.md makes the guards
mandatory: "Every active run against a web programme target or the bench is
scope-guarded, no exceptions … The dated asset capture is the only scope
authority."

- `scope_guard.py` is the hard refusal for argv-shaped tool runs: every
  host-shaped token must resolve to an asset in the newest dated captured
  inventory or the command refuses (**exit 2**) and never executes
  (`scope_guard.py:11-13`, `:59-61`). **Loopback and RFC1918 get NO special-
  casing** — "one rule, inventory-or-refuse, so 'it's only private space' can
  never quietly become 'it's only someone else's private space'"
  (`scope_guard.py:23-26`). It **fails CLOSED on purpose** — missing PyYAML,
  unparsable inventory, or an unwritable envelope → exit 3, no exec
  (`scope_guard.py:27-32`). A decision envelope (JSON: command, resolved assets,
  refusals, allows, inventory path + **SHA-256**, UTC) is written **before** exec,
  refusals included, and "a wrap-mode run whose envelope cannot be written is
  refused: an unrecorded authorization is indistinguishable from none"
  (`scope_guard.py:53-57`).
- Browser traffic is covered at egress by the `mitm_scope_guard.py` mitmdump
  addon, which kills any out-of-scope flow before application data flows and
  **reuses scope_guard's own loader and `decide()`** — "one scope semantics
  everywhere … no second opinion about wildcards, eligibility or normalization to
  drift" (`mitm_scope_guard.py` header). It fails closed identically: an unreadable
  inventory kills the addon rather than degrading to pass-through.
- The console reads these records — the argv guard's envelope (filed beside tool
  output at the `--envelope` path it is given) and the proxy guard's decision log
  (`captures/scope-guard/mitm-<tag>-<utc>.jsonl`, `mitm_scope_guard.py` header) —
  and renders an *out-of-scope auto-block* feed. It surfaces refusals as
  first-class events, **never as errors to retry**: this is the ARTEX
  `systemBlockMessage` lesson (`guard.go:142-157`) — a platform/governance block
  is not a target defence to be bypassed, so the UI must not invite a
  re-encode-and-retry. The scope guard is itself argv-only and has documented
  blind spots (smuggled `Host:` headers, bare single-label hosts,
  internally-derived destinations, `scope_guard.py:34-46`); the console must not
  present a passed envelope as a network-level guarantee.

## 8.5 Console-side guard — `packages/vr-console-server/src/guard/`

**omp has no `PreToolUse` hook.** Unlike norma/ARTEX (whose `guard.go` attaches
`hook.PreToolUse`/`PostToolUse`, `guard.go:49-51`), omp exposes no hook registry
— a source-wide search for `PreToolUse`/`preToolUse` in `packages/coding-agent`
returns nothing. omp's interception point is its **approval pipeline**: every tool
runs through `ExtensionToolWrapper`, which resolves an approval decision from the
tool context (`resolveApprovalFromContext`, `tools/approval.ts:97`) against the
tool's **tier** (`ToolTier = "read" | "write" | "exec"`,
`packages/agent/src/types.ts:1075`; ranked in `TIER_RANK`, `approval.ts:132`) and
the active approval mode's cap (`APPROVAL_MODE_MAX_TIER`, `approval.ts:153`),
multi-target folding to the **strictest** decision (`strictestApproval`,
`approval.ts:143`). When a prompt is required it calls `requestApproval(ui, …)`
(`approval.ts:844`), and **anything but an explicit approval is `deny`**
(`approval.ts:879`). This is the seam §7 wires in full.

So the console ports ARTEX's guard **not onto a hook**, but as a policy +
UI-context layer on top of that pipeline:

- **Policy (allow / ask / deny).** The ARTEX intercept-rule model
  (ordered rules, `allow`/`deny`/`ask`, a `timeout_action` defaulting to deny) is
  evaluated console-side ahead of omp's mode and mapped onto omp's own tier/mode
  policy (`tools.approvalMode` + per-tool `tools.approval.<tool>`), exactly as §7.2–7.3
  specifies. The *gate-all safe default* is honored: ARTEX treats an unset
  enabled-tools list as "gate ALL tools, including every `mcp__server__tool` the
  platform mints at runtime" and fails *toward* more gating on a read error
  (`intercept/intercept.go:147-157`, `loadLocked` `:176-184`). The console's
  default ruleset is pinned in-repo (build-local, §8.7) and keyed by MCP prefix.
- **`ask` resolves through omp's real approval seam, never a spike shortcut.** The
  console wires a custom `ExtensionUIContext` via `setToolUIContext(uiContext,
  hasUI)` (returned from `createAgentSession`, `sdk.ts:1042`; stored on the
  tool-context store, `sdk.ts:4725`) whose `approve()` routes the card to the
  operator over WebSocket and blocks on the answer (§7.1, §7.4). In the RPC
  fallback the same prompt rides `extension_ui_request` frames
  (`modes/rpc/rpc-types.ts:794`, incl. `method:"confirm"`/`"select"` `:802`).
- **Fail-closed is a property of omp, not just our policy.** If a tool needs
  approval and no interactive UI context is wired (and no `allow` policy covers
  it), `ExtensionToolWrapper` **throws** rather than running — it tells the caller
  to set `approvalMode: yolo`, add `tools.approval.<tool>: allow`, or supply an
  interactive UI (`extensibility/extensions/wrapper.ts:464-470`). The console's
  obligation is therefore narrow and absolute: **always wire a UI context**, so a
  bridge/MCP tool can never run unattended, and never ship a blanket `allow`.
- **Audit.** Every outcome (allow/ask→answer/deny, source, reason, redacted
  input, tier, matched rule) is written to the console's audit store — the ARTEX
  guard's audit ring buffer (`guard.go:197-204`, capped at 2000) reimplemented as
  a durable table (§7.6, `intercept_pending` analog). The host FS and campaign-mcp
  remain the gate/promotion authority; the audit table is projection only
  (CONSTRAINT 1).

## 8.6 Auth & sessions for the console

Single bearer/JWT, with the signing key file managed **exactly like the vault
key** (`O_EXCL`, `0600`, never-overwrite, in the non-served key dir — ARTEX stores
`jwt.key` beside `vault.key`, `vault.go:26-29`). Endpoints: `POST /api/login` →
JWT; the WebSocket upgrade carries the token; `POST /api/vault` (create/update,
with the masked-echo sentinel so an unchanged secret round-trips without
re-submission — sentinel defined in `vault.go:52` `MaskedPrefix` / `:63`
`MaskedValue`, update semantics `db/vault.go:236-271`); `POST /api/vault/:id/
reveal` (one of the two deliberate decryptions, itself audited); `GET
/api/intercept` (the approval queue); `POST /api/intercept/:id/{approve,deny}`.
All mutating routes are logged to the same audit store as the guard.

## 8.7 Supply-chain discipline (the ARTEX backdoor lesson)

`artex/artex-backdoor-report.md`: the real incident was a **trojanised Docker
image** (`tomicdd/artex`, 7,946 pulls) whose ~160-byte `server.verifyCaptcha` ran
an attacker-supplied field through `sh -c` **as root before any credential
check** — an unauthenticated root shell that looked like a failed login on the
wire (`artex-backdoor-report.md:7`, `:15`). The **source tree was never
backdoored**; the vector was a prebuilt image a copycat `docker-compose.yml`
pulled (`:14`, `:35`). Rules the console build inherits:

1. **Build locally.** `vr-console-server`/`web` images build from this checkout
   (analog of ARTEX's `artex:local` built from source, `:40`), never a pulled
   `*-console` image. No console service references a third-party `artex`/`console`
   registry image.
2. **Pin base images by digest, not tag** — the report's explicit residual-risk
   note on the unversioned-by-digest `postgres:16-alpine`, with a digest-verifying
   audit worker (`:42`).
3. **Pin and checksum-verify every dependency.** The report flags ARTEX's *own*
   remaining gaps — recon tools downloaded at pinned-but-unchecksummed versions,
   sqlmap on default branch, Playwright at `@latest` (`:42`). omp already pins
   internal deps via `catalog:` and its native addon `@oh-my-pi/pi-natives`, which
   we keep; the console adds no unpinned fetch.

Also inherited from §C of the report: any host that ever ran a copycat compose
file is in scope for rotation — the backdoor survived re-pulls and lived in data
volumes (`:43`). The console keeps a single, auditable local build path.

## 8.8 autoApprove danger controls

`autoApprove` is real in the omp SDK (option `sdk.ts:1024`; type
`agent-session-types.ts:207` "yolo/auto-approve"; defaulted at `sdk.ts:3791`,
threaded to advisors at `:5135`) and the Phase-0 spike used it — the spike itself
flags this as unsafe on a live lab, "a vr-lab agent with auto-approve can execute
real tools against real infrastructure — WinRM to canary/torpedo, fuzzing,
Ghidra, Proxmox" (`phase-0-spike.md` §7). In the console it is the single most
dangerous switch and is therefore:

- **Off by default**, and never settable from an agent message or MCP payload —
  only from an authenticated operator action (CONSTRAINT: no agent message is
  consent; this is also stated in the console's governing rules).
- **Scoped, never global.** Even enabled, the guard still forces `ask` for a
  deny-list of tool classes — `vault_get` on agent-visible secrets, anything that
  writes host-FS gate evidence or calls `finding_promote`, and any scope-guarded
  network tool. autoApprove may fast-path read-only recon (the `read` tier,
  campaign/notes/kb reads); it may **never** fast-path a promotion request, a
  WinRM/Proxmox/fuzz exec, or a credential reveal. Mechanically this is the §8.5
  policy layer overriding the mode, not a trust in `yolo` itself.
- **Visibly flagged** in the session header and written to the audit log on
  toggle, with a session-scoped lifetime (cleared on `session.dispose()`).

## 8.9 Multi-tenancy (v1 single operator)

v1 is one operator, one key, one vault. The design is tenant-ready without a
rewrite: the vault/audit/intercept tables carry no cross-tenant assumptions;
adding tenancy means a `tenant_id` column + per-tenant vault keys (each its own
`O_EXCL` key file in the non-served dir) + scoping the WebSocket/JWT subject. The
hard asymmetry to preserve is **omp's single-writer-per-cwd lease** (HARD
CONSTRAINT 4): a campaign cwd has one owning writer, so tenant isolation is
naturally expressed as *separate cwds / separate omp sessions*, each with its own
lease and its own `ExtensionUIContext`. Concurrency is **many sessions, never a
shared one** — which also means a per-tenant vault key never has to be shared
across a session boundary.

## 8.10 Open questions

- The §8.5 policy→omp mapping is specified in §7; the remaining omp-side unknowns
  are §7's open questions (does the in-process `approve()` fire for *bridged host
  tools* as well as MCP/native tools; does the RPC `select`-only fallback render
  acceptably as a card; does omp's grant cache survive `dispose()`). Resolve those
  before trusting the seam for a mutating bridge tool.
- Whether a local-model provider (Ollama / vLLM) is already wired as an omp model
  backend, or the console must add one, to satisfy the §8.3 binary-content route.
  Until it is, `research-sensitive` payloads have no compliant destination and
  must be blocked, not downgraded.
- Token-blind enforcement for the H1/Bugcrowd integration consumer (§8.2) is a
  console obligation with no store-level backstop; it needs the same token-blind
  test coverage ARTEX pins (`db/vault.go:385-387`) before the integration ships.


---

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


---

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


---

## Consolidated Registers

Consolidated across the ten section files (`01`…`10`). Entries are attributed to
the section that owns them. This is a cross-cutting index, not a re-derivation: the
owning section carries the full grounding and `file:line` cites.

Section verdicts: **solid** — §1, §5. **needs-fixes** — §2, §3, §4, §6, §7, §8, §9,
§10. ("needs-fixes" here means open questions or precision items remain, not that
the architecture is wrong; every section's core thesis survived verification.)

---

## 1. Consolidated Key Decisions

**Architecture & integration (§1, §2, §6)**

- **Embed omp in-process as the primary integration; drive `omp --mode rpc`/`rpc-ui`
  as the fallback.** In-process is the true analog of ARTEX embedding norma and is
  lowest-latency; the subprocess seam is for isolation, scale, and cross-host
  brokering. Both emit the same `AgentSessionEvent` union, so everything above a
  thin adapter is transport-agnostic (§1.2, §2.2).
- **omp stays unchanged (HARD CONSTRAINT 6).** The console consumes only the exported
  SDK surface; `OmpSessionAdapter` is the single integration seam, so an omp surface
  change is a one-file fix (§2.2, §10 R7).
- **Reproduce ARTEX's planner→worker engine in TS above omp** (analog of
  `engine.go`): one planner loop + N worker loops per campaign, the engine (not the
  model) owning scheduling, debounce, heartbeat, and steer queue (§2.3, §6.1).
- **Shape the event stream before transport** (copy of `printableEvent`
  `print-mode.ts:88`): drop `message_update` snapshots, strip `providerPayload`.
  Not optional — raw forwarding produced multi-GB transcripts upstream (§1.2, §2.2,
  §4.5).
- **Await MCP readiness before the first prompt** (`mcpManager.waitForStartup` then
  `session.refreshMCPTools(mcpManager.getTools())`, `print-mode.ts:415-419`) on every
  session (§1.4, §2.2, §5.2, §9.5).

**Data & authority (§1, §3, §5)**

- **Host FS is truth; Postgres is a one-way projection.** Two table populations:
  mirror tables (read-only projection of host YAML, healed by re-read, never
  writeback) and console-owned tables (runtime, cost ledger, coverage graph,
  approvals, registries, vault) (§3.1, §3.6).
- **campaign-mcp is the sole promoter; the console cannot fake a promotion.** No SQL
  write path into `findings`/`gate_records`/`hypotheses` from any HTTP handler;
  promotion is a brokered MCP call that campaign-mcp re-validates against on-disk
  evidence, severity bar, and dependency origin (§3.6, §5.3, §1.3).
- **Evidence is referenced, never copied in** — paths + sha256 only; dumps,
  decompiles and PoCs stay on the host (§3.3).
- **Adapt ARTEX's 55-table schema**, dropping the web-only tables (traffic capture,
  asset-intercept URL rules, H1/BC sync machinery) and re-pointing the rest to the
  Windows/binary VR model (§3.2).

**Concurrency (§1, §2, §3, §6, §8)**

- **Single-writer per cwd; concurrency = N sessions, N cwds.** Enforced by omp's
  per-session OS file lock and mirrored as a console DB invariant
  (`UNIQUE(cwd) WHERE status='active'`). Ephemeral read-only queries use
  `SessionManager.inMemory(cwd)` so they take no disk lease (§1.4, §2.3, §3.4).

**Frontend (§4)**

- **Re-skin ARTEX `web/` verbatim-stack, new data only.** Next 16 / React 19 / shadcn
  / g6 + xyflow / recharts / zustand; no new top-level deps. Remap the two NavGroups,
  the 11 task-detail tabs, the findings table (shadcn `ui/table`, **not**
  `@tanstack/react-table`), and the coverage graph (§4.1-4.3).
- **Switch SSE→WebSocket** (one bidirectional connection carries the event stream and
  the approve/deny replies); keep ARTEX's history-then-tail-at-cursor + dedup
  reliability discipline (§4.4, §4.5).
- **The gate tracker is strictly read-only over projected host state** — "Promote" /
  "Record gate" buttons compose an agent instruction, never write status (§4.3).

**Orchestration, approval & security (§6, §7, §8)**

- **Default approval mode is `always-ask`, not `write`** — because omp statically
  tiers every MCP tool as `write`, so under `always-ask` every MCP tool reaches the
  gate; the console then narrows via seeded exact-name `allow` policies for
  read-only queries (§7.2, §7.3). This is the single most important safety decision.
- **The universal gate is `ExtensionToolWrapper` + `requestApproval` → `ui.approve`**,
  fail-closed (anything but explicit approval = deny). The console drives it purely
  via `Settings.tools.approval`/`tools.approvalMode` + `setToolUIContext` — omp
  unchanged (§7.1, §6.7, §8.5).
- **Per-tool policy is compiled from an ARTEX-style ruleset to omp's exact-name map
  against the live minted roster**, because omp has no prefix/glob matching and
  names are minted/hyphen-collapsed/capped (§7.3, §6.4).
- **Scope/egress is NOT enforced at the approval seam** — it stays on the host
  (mitmproxy + `scope_guard.py` + campaign-mcp); the console enforces by tool
  identity and mirrors scope for display/audit only (§7.3, §8.4).
- **Vault: AES-256-GCM, two decryption paths only, agent-excluded flag, token-blind
  integration accessor** so a programme API token is consumed by the console and
  never enters an LLM transcript (§8.2).
- **Route research-sensitive content only to local/self-hosted model providers**;
  until a local-model backend is confirmed wired, such payloads are **blocked, not
  downgraded** (§8.3, §8.10).
- **autoApprove is off by default, never agent-settable, scoped (never global), and
  session-lifetime-bound** (§8.8).

**Observability & roadmap (§9, §10)**

- **Reuse omp's provider-computed cost** (`usage.cost.total`), not a local rate card;
  ingest via one `session.subscribe` → `message_end` tap; the console-owned
  `llm_usage` ledger is the authoritative cross-tier record (omp-stats covers only
  the portable tier) (§9.1, §9.3).
- **Embed `omp stats` in-process** for per-campaign drill-down; keep OTLP export off
  by default with content capture disabled (§9.3, §9.4).
- **Sequence Phase 0→3 so each phase ends on a running, demoable console**, and
  removing `autoApprove` for a real card is a hard Phase 1 exit criterion (§10).

---

## 2. Consolidated Open Questions

Grouped by theme; each tagged with the owning section(s). Several questions raised
in earlier sections are **resolved** by later ones — those are marked.

**Approval-seam mechanics (the largest unproven surface)**

- **Does the in-process `approve()` fire for bridged host tools** (`ask_operator`-class),
  not just MCP/native tools? The wrap loop is over `toolRegistry.values()`
  (`sdk.ts:3892`) — verify host tools are in that registry before trusting a card for
  them (§7 open-q a; §8.10).
- **Does the RPC `select`-only fallback render acceptably as a first-class card**, or
  is a host-side shim needed to reconstruct the card from the select choices
  (`approval.ts:895`)? Plain `--mode rpc`'s `RpcExtensionUIContext` implements
  `select` but **not** `approve` (§7 open-q b; §8.10).
- **Does omp's on-disk grant store (`getApprovalGrants`) survive `session.dispose()`**,
  or must the console re-seed session grants on resume? (§7 open-q c; §8.10).
- **Policy-compiler re-run timing**: tools that reconnect mid-run re-fire
  `refreshMCPTools`; the compiler must re-run on roster change so a newly-appearing
  mutating tool is not left at mode-default without an explicit `prompt` seed (it
  still cards under `always-ask`, but loses its rule name in the audit) (§7 open-q d).
- **LLM fallback judge — in or out for v1?** Default: out for mutating tools;
  local-model-only if ever enabled (§7 open-q e; §8.10).
- **(RESOLVED)** The exact `ExtensionUIContext`/`approve()` shape §1.8 and §4.7 left
  open is located and transcribed: `ExtensionUIContext.approve(prompt, dialogOptions?)
  → ExtensionApprovalAnswer` (`extensibility/extensions/types.ts:332,363-375`), driven
  at `tools/approval.ts:860-882` (§2.2, §6.7, §7.1).

**Cross-host / remote transport**

- **Cross-host brokering fan-out**: one rpc-ui subprocess per remote Kali host, or a
  thin relay multiplexing several sessions over one connection? (§2 open-q; §1.8).
- **Remote transport for the rpc fallback**: raw mTLS stream vs SSH-forwarded stdio
  (§1.8; §10.4 adds a §8 remote-transport subsection — ownership to settle when §8
  final is cut).
- **Cross-host steering fidelity**: does `modes/rpc/rpc-input.ts` accept mid-turn
  steering with the same next-step-boundary queue semantics as in-process `steer()`,
  or does the redirect-without-restart parity degrade to next-prompt-only over the rpc
  hop? (§6 open-q; §2 risk).
- **Which `--mode` emits `extension_ui_request` for tool approvals** — plain `rpc` or
  `rpc-ui`? Inferred from the mode list and `--no-ui` flag; needs empirical
  confirmation before the subprocess broker is built (§2 risk; see Cross-Section item C).

**Projection & data model**

- **Projection-rebuild strategy**: live event-tail into Postgres vs periodic
  reconcile against campaign-mcp host-FS records as source of truth (§1.8).
- **`src_sha256` granularity for multi-file findings** — a per-`finding.yaml` hash can
  miss a sibling gate-evidence change (§3 open-q 1).
- **`events` retention**: full history vs rolling window with cold-event spill (ARTEX
  `task_archives` model) (§3 open-q 2).
- **Coverage-graph seeding**: from campaign-mcp surface records at first sync vs built
  purely from planner intents (§3 open-q 3; §4.7).
- **`console_sessions.cwd` UNIQUE invariant** holds only within one host's FS
  namespace — needs a decision for the rpc adapter where server and omp may not share
  a filesystem (and where `evidence_present`/the gate broker must execute on the Kali
  host, not the server host) (§3 open-q 4; §3 risk 2).

**Model routing, cost & lanes**

- **Fallback-chain exhaustion fidelity**: does `retry.fallbackChains` express ARTEX's
  `task_llm_profiles.status='quota_exhausted'` position-skipping, or must the
  orchestrator track per-account exhaustion and rebuild chains at session-create? (§6
  open-q; §9).
- **Is a local-model provider (Ollama/vLLM) already wired as an omp model backend**, or
  must the console add one, to satisfy the §8.3 binary-content route? Gates HARD
  CONSTRAINT 2 compliance (§8.10).
- **Intra-turn live cost**: `usage.cost` settles only at `message_end` (turn
  granularity); a running-cost UI needs delta accumulation from `message_update`
  without the authoritative cost object, or must accept per-message granularity (§9
  open-q).
- **`agent_lane` provenance**: confirm the orchestrator stamps planner/worker/scout at
  session-create vs inferring from the subagent spawn tree, so lane roll-ups survive
  model fallbacks (§9 open-q).
- **Host-bound stats parity**: run a second omp-stats sync on the Kali host, or treat
  the console `llm_usage` ledger as sufficient and leave Kali-host JSONL for forensic
  drill-down (§9 open-q).

**Frontend & lease surfacing**

- **How the single-writer lease state reaches the badge** — REST poll vs synthesized
  `notice` frame; there is no omp `session` event to carry it (§4.7; a §2/§3 decision).
- **Surface graph served as a projected snapshot vs derived live** from campaign-mcp
  surface records (§4.7; depends on §5).
- **Per-campaign live state**: one zustand store per open workspace vs a keyed slice of
  a single store (§4.7).

**Roadmap / estimates**

- **Effort estimates** (P1 12–16 d, P2 14–18 d, P3 16–22 d) are unverifiable judgement
  calls, kept as-is; no source grounds them (§10 open-q).
- **In-process→rpc fallback threshold**: the memory-per-session figure that triggers
  R1 is undefined, deferred to the first host-run measurement (§10 open-q; R1).

---

## 3. Consolidated Risks & Mitigations

Ordered roughly by impact. The §10 risk table (R1–R9) is the authoritative roadmap
register; items below fold in risks surfaced by other sections.

| Risk | L / I | Mitigation | Owner |
|---|---|---|---|
| **R2 — Auto-approve on a live lab** mutates canary/torpedo/Proxmox before the human gate exists | Med / **Critical** | Removing `autoApprove` and shipping the fail-closed `requestApproval` card is a hard Phase 1 exit criterion; `always-ask` is the enforced default (not `write`, which would auto-run every mutating MCP tool silently — the single most dangerous misconfiguration); spike/host runs stay read-only until the card ships | §10, §7, §8 |
| **R4/R-supply — Supply-chain compromise** (the ARTEX `tomicdd/artex` trojanized image; source tree was never backdoored) | Low / Critical | Build images locally, pin all deps (omp at `18.18.6` via `catalog:`), digest-pin base images, no third-party prebuilt image; rotate any host that ever ran a copycat compose file | §10, §8.7, §1.6, §2.1 |
| **R5 — Research-content egress** (a binary/decompile reaches a third-party model/API) | Low / Critical | kb-RAG stays local (Ollama+LanceDB); research-sensitive payloads blocked from cloud providers until a local backend is confirmed; evidence viewer streams host→authenticated operator over the console's own channel; arg previews redacted; OTLP off by default with content capture disabled | §10, §8.3, §7.4, §9.4 |
| **Approval-seam unproven** — the whole Approvals view and WS approve/deny shape rest on seams Phase 0 auto-approved past (bridged-host-tool `approve()`, RPC select-only fallback, grant-cache survival) | Med / High | Resolve §7 open-qs (a)(b)(c) before trusting the seam for a mutating bridge tool; validate empirically which `--mode` emits approval frames | §7, §8, §2, §4 |
| **R3 — Projection drift** (Postgres mirror diverges from host-FS truth) | High / Med | One-way host-FS→SQL only; heal by re-read, never writeback; gate/promotion authority never leaves campaign-mcp; `projection_version` hook with a **fail-loud** sync worker on an unseen `FINDING_SCHEMA_VERSION` (already at 2), never silent field drop | §10, §3.1, §3.6 |
| **R1 — In-process embed degrades at N sessions** (one Bun process holding N agents + MCP clients + native addon) | Med / High | P0 proved the seam; P3 falls back per-session to `omp --mode rpc` subprocesses with no change above the transport line; measure memory-per-session on the first host run (threshold undefined) | §10, §1.2 |
| **Remote-console phase unproven** — off-host server driving omp via `--mode rpc` over SSH/mTLS is sketched, not spiked; only the in-process localhost embed is validated | Med / High | Spike the rpc-ui approval-frame path and remote transport before relying on the remote topology; §10.4 adds a §8 remote-transport subsection (mTLS) | §1, §8, §10 |
| **R8 — Scope-guard bypass** (an out-of-scope target is reached) | Low / High | Egress kill stays on the host (`mitm_scope_guard.py` + `scope_guard.py`, fail-closed); the console displays scope state and cannot override it; never downgrade a host scope-kill into a dismissible prompt; a passed envelope is not presented as a network-level guarantee (documented argv-only blind spots) | §10, §8.4, §7.3 |
| **Stale/ungrounded ruleset regex** silently matches nothing, leaving a tool at mode-default | Med / Med | Compile policy against the live minted roster at build time; curate the ruleset per tool and review it (don't trust verb-suffix heuristics as read/write authority — no `readOnlyHint` exists for vr-lab's bare `@mcp.tool()` servers); fail-safe holds because `always-ask` still cards write-tier tools, but the rule name is lost from the audit | §7.2, §7.3 |
| **Token-blind enforcement has no store-level backstop** — a careless error string could leak the H1/Bugcrowd token to an agent/log | Low / High | Inherit ARTEX's token-blind obligation on `GetForIntegrationByTargetLabel`; add token-blind test coverage (not-found, corrupt-ciphertext, storage-failure) before the integration ships | §8.2, §8.10 |
| **R6 — Single-writer lease contention** at concurrency; crash-safety for a sqlite/redis backend depends on that backend implementing the optional `claimSession` (the file backend's OS lock does not carry over) | Med / Med | One `AgentSession` per campaign cwd; `UNIQUE(cwd) WHERE status='active'`; `inMemory(cwd)` for ephemerals; verify any pluggable backend implements `claimSession` | §10, §1.4, §3.4 |
| **R7 — omp SDK surface shifts under the fork** | Low / Med | Keep omp unchanged; `OmpSessionAdapter` is the single integration seam; pin the omp workspace version | §10, §2.2 |
| **Host-vs-server filesystem skew for the rpc adapter** — `evidence_present` path+exists and the gate/request broker must execute on the Kali host, else computed against the wrong FS | Low / High | Run the projection's path checks and brokered tools on the host omp session; never assume local FS access to the campaign tree (§3 open-q 4) | §3, §5 |
| **kb-mcp degraded state** (index not built / Ollama unreachable) reads as structured errors, not server-down | Low / Med | Surface per-server readiness as a status strip; render kb's "index not built"/"ollama unreachable" distinctly; cold `kb_ask` ≈100 s is expected, not a hang | §1, §5.2, §9.5 |
| **R9 — Cross-section drift** — §7/§9 (and other) finals cite drafts; line numbers may move | Med / Low | Freeze the WS frame + approval-decision contracts as the inter-section interface; reconcile finals against the cites; the symbol name + file is the stable anchor when a line drifts | §10, and see §4 below |

---

## 4. Cross-Section Consistency Check

Checked for contradictions and gaps across the ten sections. The architecture is
internally coherent — host-FS-truth, single-writer, broker-the-host-tier, and
omp-unchanged are applied uniformly, and the core theses do not conflict. The
following are **resolved tensions, spelling divergences, and cross-reference
couplings** a reader should know; none invalidates a section.

**A. Phase 0 "done" vs "model-turn deferred" (reconciled, but two docs still read
differently).** The task authority and §00/§01 call Phase 0 done; §10.1 is precise
that the *structural seam* was validated live while the *model-driven turn* was
deferred for lack of cloud-session credentials and is the first Phase 1 smoke test.
`docs/vr-console/phase-0-spike.md` still reads "plan (uncommitted)" with an unchecked
checklist. **Gap:** a reader comparing the two docs sees tension until
`phase-0-spike.md` is updated to match §10.1's "structural-validated vs
model-turn-deferred" framing. Not a contradiction in the design — a documentation
sync item.

**B. Approval default mode: `write` (early draft) → `always-ask` (final).** §7.2
explicitly corrects an earlier draft that proposed `write` mode, which would
auto-run every mutating MCP tool because omp tiers all MCP tools as `write`. The
**finals are consistent**: §7 (always-ask default, narrowed by seeded `allow`
policies), §6.7 (reads auto-approve, writes/host-bound/promote raise a card), and
§8.8 (autoApprove off, scoped) all agree. **Coupling to watch:** §6.7's "portable
MCP reads auto-approve" is true only *via* the seeded exact-name `allow` policy of
§7.3, not via the mode — because under `always-ask` an MCP read is still tier
`write` and would otherwise card. §7.3 is the authority and explains the mechanism;
§6.7 should be read through it.

**C. `--mode rpc` vs `--mode rpc-ui` for approval frames (open, flagged).** §2
insists the subprocess fallback drives `rpc-ui` (the variant whose tool UI stays
enabled, emitting `extension_ui_request`), while §5, §6, §9, §10 refer loosely to
`omp --mode rpc`, and §7.1 treats plain `--mode rpc`'s `RpcExtensionUIContext` as
routing approvals through `select` (not `approve`). This is a genuine unresolved
point, correctly flagged in §2's risks and §7 open-q (b): which mode emits approval
frames must be confirmed empirically before the subprocess broker is built. **Gap,
not contradiction** — the sections agree a fallback exists and agree it is unproven;
they differ only on the mode label, which the spike will settle.

**D. Minted MCP tool-name spelling diverges by section (internally defensible).**
§6.4 and §7.3 establish the **canonical** omp registry/policy key is
single-underscore with hyphens collapsed: `mcp__campaign_mcp_finding_promote`,
`mcp__lab_mcp_<tool>`. §1.3, §3.5 and §4 show the double-underscore/hyphen form
(`mcp__campaign-mcp__finding_promote`) and §5 uses a dotted illustrative form
(`campaign-mcp.finding_promote`). These are **not a contradiction**: the
double-underscore form is the Claude-Code spelling a primed model reliably produces,
which omp recovers via `canonicalMCPToolNameCandidates`. **Obligation (from §6.4,
§7.3):** policy keys and the tool-usage ledger must store the **canonical
single-underscore** key (or canonicalize on ingest) so a call shows up once, not
under two spellings. Sections 1/3/4/5 are showing the model-facing spelling, not the
policy key — worth a one-line note in those sections to avoid a reader keying a
policy off the wrong form.

**E. `ExtensionUIContext` shape: open in §1/§4, resolved in §2/§6/§7.** §1.8 and §4.7
list "exact `ExtensionUIContext` shape" as open; §2.2, §6.7 and §7.1 locate and
transcribe it (`types.ts:332,363-375`; driven at `approval.ts:860-882`). **Gap:** §1.8
and §4.7 should cross-reference §2/§7 as resolving it rather than leaving it open.
Consistent in substance; stale open-question wording in the earlier sections.

**F. Table/enum name coupling (§5 ↔ §3).** §5 explicitly defers table/enum names to
§3.4 and was corrected to match it verbatim (`coverage_nodes`/`coverage_edges`,
`console_sessions`, node kind `intent`, edge rels `covers|yields|proves|spawns`).
These are currently in lockstep. **Coupling to maintain:** if §3's finalize pass
renames any of them, §5's cross-refs must move with it. Likewise §4's findings
lifecycle and gate vocabulary must track §3's projected enums and
`ALLOWED_GATE_STATUSES`.

**G. Activity-store durability coupling (§2 ↔ §3).** §2.6's drop-and-catch-up WS
reconnect assumes a durable per-campaign event log exists (ARTEX relies on Postgres);
§3.4 provides it as the `engine_rounds`/`events` store. Consistent — but if §3 ever
lands a non-durable store, §2's replay guarantee breaks. Flagged in §2's risks; noted
here as a live coupling.

**H. Lease-badge surfacing is an acknowledged gap, not a conflict (§4 ↔ §2/§3).**
§4.7 correctly states no omp `session` event carries lease state, so the badge's
liveness depends on a §2/§3 server decision (REST poll vs synthesized `notice`
frame). Open across sections, owned by §2/§3; no section contradicts another.

**Summary:** no hard contradictions found. The items above are (A) a doc-sync item
between the roadmap and the spike doc, (B/E) stale open-question wording in earlier
sections resolved by later ones, (C) one genuinely-open mode-label question already
flagged as needing a spike, (D) a spelling convention that is defensible but carries
a concrete storage obligation, and (F/G/H) cross-reference couplings to keep in
lockstep as finals are cut. All are tracked in the open-questions and risk registers
above.
