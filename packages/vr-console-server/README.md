# @oh-my-pi/vr-console-server

VR Console backend (Phase 1). Embeds the omp SDK **in-process** and adds the
HTTP + WebSocket transport omp does not ship, with a **real human approval seam**
replacing the Phase-0 spike's `autoApprove`. omp itself is never modified
(DESIGN Constraint 6). Full design: [`docs/vr-console/DESIGN.md`](../../docs/vr-console/DESIGN.md).

## What's here (Increments 1–2)

```
src/
  adapter/omp-session-adapter.ts  THE single omp seam (createAgentSession + subscribe + MCP + approval)
  approval/
    ui-context.ts                 ConsoleUIContext: real approve() over WS, fail-closed
    policy.ts                     pinned ARTEX-style ruleset → omp exact-name tools.approval map
    pending.ts                    request/reply correlation (fail-closed on dispose)
  campaign/
    reader.ts                     read-only projection over campaign-mcp's on-disk tree (Bun.YAML)
    types.ts                      campaign/surface/finding read model
  event-shape.ts                  print-mode payload-bloat guard
  server.ts                       Bun HTTP+WS + read-only campaign REST API
public/index.html                 debug UI: event log, prompt, approval cards, campaigns panel
```

## Approval model (DESIGN §7)

- Session runs **`tools.approvalMode = "always-ask"`** (not omp's `yolo` default, not
  the spike's `autoApprove`). omp tiers every MCP tool as `write`, so **every MCP
  tool reaches the gate**.
- The pinned ruleset is compiled against the **live minted tool roster**
  (`discoverMCPServers`) and seeded into `tools.approval` — read-only record/knowledge
  queries auto-run; `lab-mcp` WinRM, host compute, Proxmox, and any mutation
  (`*_promote` / `*_revert` / …) always raise a card.
- `ConsoleUIContext.approve()` pushes an `approval_request` WS frame and **fails
  closed**: anything but an explicit answer → `deny`; `session`/grants honored only
  when the prompt offered them; parked approvals denied on disconnect.

## Campaign reads (DESIGN §3/§5)

The console **reads** campaign state from the host FS (the source of truth); it never
writes campaign/finding/gate state — that stays with `campaign-mcp`. `state` is
derived from the directory (`findings/` ⇒ `validated`), never a stale field.

```
GET /api/health
GET /api/campaigns?scope=active|archived|all
GET /api/campaigns/:id
GET /api/campaigns/:id/findings
```

## Run

```bash
bun install
VR_LAB_ROOT=/path/to/vr-lab VR_CONSOLE_CWD=/path/to/vr-lab/campaigns/active/<id> \
  bun run packages/vr-console-server/src/server.ts
# → http://localhost:8800
```

Env: `PORT` (8800), `VR_CONSOLE_CWD` (agent session cwd), `VR_LAB_ROOT` (vr-lab checkout
for the campaign API). Model/auth come from omp's own on-host config.

## Tests

```bash
bun test packages/vr-console-server
```

Covered: fail-closed approval decision, policy compiler, campaign reader (against a
synthetic fixture).

## ⚠️ Safety

Still run **read-only tasks only** until approval-text redaction (Constraint 2) lands —
`approve()` currently truncates but does not strip research-bearing content from the
omp-built prompt strings. Mutating lab/VM tools always card, but their arg previews
are not yet redacted.
