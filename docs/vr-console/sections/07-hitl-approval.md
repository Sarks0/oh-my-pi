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
