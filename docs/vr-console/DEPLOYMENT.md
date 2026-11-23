# VR Console — Kali host deployment / run guide

Stand up the VR Console (Phase 1–2) on the Kali host that already runs vr-lab. The
console is **additive packages inside this omp fork**; omp itself is unmodified. It
embeds the omp SDK in-process and serves a web UI that reads the real `campaign-mcp`
layout and drives the agent — with every host mutation gated by a fail-closed
approval card.

Everything below runs on the **Kali host** (the console must be near the vr-lab MCP
servers + VMs; DESIGN §1). v1 is localhost-only.

---

## 0. Prerequisites

- **This fork**, on branch `vr-console`, checked out on the host.
- **Bun** ≥ 1.4 (`curl -fsSL https://bun.sh/install | sh`).
- A working **Rust toolchain** (for the omp native addon) — or a prebuilt
  `packages/natives/native/*.node` already present.
- The **vr-lab checkout** with its MCP servers bootstrapped (`scripts/setup/bootstrap.sh`
  → generates `.mcp.json`, per-server venvs). The external `binary-mcp` / `ProxmoxMCP`
  / `knife-mcp` registered in omp's global MCP config as usual.
- **omp model/auth configured** on the host (the console reuses omp's own
  `~/.omp` auth + model registry — whatever `omp` is already logged into). Pick a
  model whose provider is acceptable for binary content (see Safety).
- **PostgreSQL** (optional — enables the cost ledger + projection + approval audit).

## 1. Build

```bash
cd <this-fork>
bun setup                 # installs the workspace + builds the omp native addon
bun run --cwd packages/vr-console-web build   # bundles the SPA → packages/vr-console-web/dist
```

`bun setup` is only needed once (and after an omp bump). The server serves the web
bundle automatically from `packages/vr-console-web/dist`.

## 2. (Optional) Postgres

```bash
createdb vrconsole
export DATABASE_URL="postgres://<user>:<pass>@127.0.0.1:5432/vrconsole"
```

The schema **migrates itself on boot** (idempotent `CREATE TABLE IF NOT EXISTS`).
Without `DATABASE_URL` the console runs on filesystem reads alone — no cost ledger,
projection, or approval audit, but every other view works.

## 3. Run

```bash
export VR_LAB_ROOT=/path/to/vr-lab                                  # campaigns/, targets/ live here
export VR_CONSOLE_CWD="$VR_LAB_ROOT/campaigns/active/<campaign-id>" # the agent session's cwd
export PORT=8800
bun run packages/vr-console-server/src/server.ts
# prints:  open:  http://127.0.0.1:8800/?token=<random>
```

**Auth.** The server binds `127.0.0.1` only and mints a random per-launch token,
printed once in the launch URL above. That token is required on every `/api/*`
request, the `/ws` upgrade, and `/debug`; a cross-site `Origin` or a non-loopback
`Host` is rejected outright. Open the printed URL: the SPA stores the token and
strips it from the address bar. Set a fixed token with `VR_CONSOLE_TOKEN` (for a
reverse proxy or scripts). This is what keeps a web page the operator visits, or
another local process, from driving the agent or approving a tool call.

Why `VR_CONSOLE_CWD` points at a campaign dir under the vr-lab checkout: omp
discovers the vr-lab MCP servers from that cwd (it walks up to `$VR_LAB_ROOT/.mcp.json`),
and the agent operates in that campaign's context. `VR_CONSOLE_CWD` is the **default**
session's cwd; the console is multi-session, so you can create more sessions (each
with its own cwd, model, and approval state) from the **Sessions** page without a
second server.

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `8800` | HTTP/WS port |
| `VR_CONSOLE_HOST` | `127.0.0.1` | bind address — keep loopback; a LAN IP/`0.0.0.0` is refused by the Host check anyway |
| `VR_CONSOLE_TOKEN` | *(random per launch)* | bearer token required on `/api/*`, `/ws`, `/debug`; set a fixed value behind a proxy |
| `VR_CONSOLE_CWD` | `cwd` | the **default** session's cwd — a vr-lab campaign dir (drives MCP discovery) |
| `VR_LAB_ROOT` | — | vr-lab checkout (campaign + programme read APIs) |
| `DATABASE_URL` | — | optional Postgres (cost ledger, projection, approval audit) |
| `VR_CONSOLE_WEB_DIST` | `…/vr-console-web/dist` | override the served SPA directory |

## 4. Verify

```bash
T=<token-from-startup>                                        # or your VR_CONSOLE_TOKEN
curl -s "localhost:8800/api/health?token=$T"                  # {"ok":true,"labRoot":"…","db":true|false}
curl -s "localhost:8800/api/campaigns?scope=all&token=$T"
curl -s "localhost:8800/api/programmes?token=$T" | head -c 200
# without the token: 401; from a cross-site Origin: 403
```

Then open the launch URL printed at startup (it carries the token):

- **Dashboard** — campaign tiles (+ cost tiles if Postgres is on).
- **Campaign → Findings + Gates** — the board; click a finding for gate status + the
  evidence viewer; **Request promote** / per-gate **request record** compose an agent
  instruction (watch it in the Session tab).
- **HITL Session** — prompt the agent; a mutating tool call raises an **approval card**.
- **Approval Records** — the audit trail (Postgres).
- **Scope + Programmes** — `bounty_programs.yaml`.

`GET /debug` serves the raw event-stream page if you want the unstyled view.

## 5. First-run checks (the two things this container couldn't prove)

1. **Approval card on a real tool call (DESIGN §7a).** Prompt the agent with something
   that calls a mutating vr-lab tool (e.g. "revert the webtarget VM" → `ProxmoxMCP`,
   or a `finding_promote`). Confirm a card appears in the **Session** tab and that
   **Deny** blocks the call. Confirm it also fires for host-bridged `ask_operator`-class
   tools (the one open question §7a flags). The default posture is `always-ask`, and
   omp tiers every MCP tool as `write`, so every MCP tool should card.
2. **Cost ledger** populates after the first real turn (`/api/cost`).

## 6. Safety (do not skip)

- **Read-only tasks only** until approval-text redaction lands: `approve()` currently
  truncates but does not strip research-bearing content from the omp-built prompt
  strings. Mutating tools always card, but their previews aren't yet redacted
  (Constraint 2 — no research content to third-party surfaces).
- **Keep research content on local models.** For binary/decompile analysis, route the
  agent's model to a local/self-hosted provider; the lab's rule is *no research content
  to third-party APIs* (DESIGN §8.3).
- **Authority stays on the host.** The console can display and *request* a promotion;
  only `campaign-mcp` (`finding_promote` / `gate_record`) can validate one, and it
  re-checks on-disk evidence. The console never writes campaign/gate state.
- **Build local, pin deps** (the ARTEX supply-chain lesson) — never pull a prebuilt
  `artex`/console image.

## 7. Troubleshooting

| symptom | fix |
|---|---|
| `VR_LAB_ROOT is not set` on `/api/campaigns` | export `VR_LAB_ROOT` to the vr-lab checkout |
| `MCP discovery failed` / 0 tools | run against a cwd under `$VR_LAB_ROOT` with a generated `.mcp.json`; bring up the vr-lab servers |
| assistant turn errors with HTTP 401/403 | omp has no valid model credential — `omp` login / provider config on the host |
| `/api/cost` returns `{"enabled":false}` | `DATABASE_URL` not set, or Postgres unreachable |
| nothing renders at `/` | run `bun run --cwd packages/vr-console-web build` (the SPA isn't built) |
| port in use | change `PORT` |

## 8. Operational notes

- **One session per cwd** (single-writer lease). Concurrency = multiple server
  instances, each its own `PORT` + campaign `VR_CONSOLE_CWD`.
- **Postgres is a projection**, not the source of truth. `GET /api/projection/sync`
  refreshes the mirror from the host FS; the host FS + `campaign-mcp` remain authoritative.
- **Remote access**: keep it on loopback. To reach it from elsewhere, front it with an
  SSH tunnel or an mTLS reverse proxy — do not bind `0.0.0.0` on a lab network.
```

## 9. Tasks (autonomous layer)

The **Tasks** page runs autonomous campaigns: a planner decomposes a goal into
intents, a bounded worker pool pursues them and reports facts/findings, and the
exploration graph drives the planner until the goal is met. See
[`TASKS-DESIGN.md`](TASKS-DESIGN.md).

Requirements:

- **Postgres** (`DATABASE_URL`) — the exploration graph / frontier is live
  operational state. Tasks are disabled (the page shows a hint) without it.
- **A model configured in omp on the host** — the planner and worker are real omp
  sessions. Without a working model a task starts but produces no intents/facts.

Run a task:

1. **Tasks → new task**: a goal (required), an optional name and working dir (a
   campaign dir, so the workers discover the vr-lab MCP tools), and whether to
   **allow mutating tools**. Creating it seeds the graph (origin fact + goal).
2. **Open it → start.** The engine runs: watch the **Exploration graph** (goal →
   intents → facts → findings) and the **Activity** timeline advance live.
   **pause** returns running intents to the frontier; **stop** ends it.

Safety: every real worker tool call still goes through the always-ask approval
gate. Under the default **read-only-only** posture (no `VR_CONSOLE_ALLOW_MUTATIONS`)
a task does reconnaissance only — mutating tools are denied until you opt in. The
graph bookkeeping tools (`add_intent`, `report_fact`, …) are read-tier, so they run
without a card and do not drown you in approvals.

Per-task knobs live in the task `config` (jsonb): `concurrency` (max workers),
`heartbeatMinutes` (deadlock backstop), `allowMutations`. One server hosts many
tasks; each runs its own engine.
