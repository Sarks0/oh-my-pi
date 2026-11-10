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
