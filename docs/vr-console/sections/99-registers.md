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
