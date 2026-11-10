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
