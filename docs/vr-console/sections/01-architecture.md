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
