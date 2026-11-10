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
