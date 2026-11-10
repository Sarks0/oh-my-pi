# @oh-my-pi/vr-console-spike

**Phase 0 spike** for the VR Console. Proves the one load-bearing assumption:
an external TypeScript process can embed the omp SDK **in-process**, run one
agent session headlessly, and stream its events to a browser over WebSocket —
the TS/Bun analog of how ARTEX sits on the `norma` harness.

Full plan: [`docs/vr-console/phase-0-spike.md`](../../docs/vr-console/phase-0-spike.md).

## What it is

- `src/omp-bridge.ts` — embeds the omp SDK (`createAgentSession`), relays its
  event stream, exposes `prompt()` / `dispose()`. **omp itself is untouched.**
- `src/server.ts` — a Bun server: static page + `/ws` WebSocket, one shared
  session. The only genuinely new code (the transport omp doesn't ship).
- `src/event-shape.ts` — copy of print-mode's `printableEvent()` shaping (keeps
  WS payloads from growing quadratically).
- `public/index.html` — a one-page debug UI: prompt box + live event log.

## Run

```bash
bun install                       # once, at repo root (wires the workspace)
bun run packages/vr-console-spike/src/server.ts
# open http://localhost:8799
```

Environment:

| var | default | meaning |
|---|---|---|
| `PORT` | `8799` | HTTP/WS port |
| `VR_SPIKE_CWD` | `process.cwd()` | working dir for the agent session; point at a **vr-lab campaign dir on the Kali host** for the real-MCP test |

Model/auth come from omp's own on-host config (its existing login). Pick a cheap
model for the smoke test.

## Suggested bring-up order

1. **Loop smoke test:** `VR_SPIKE_CWD` = a throwaway empty dir, prompt "say hi".
   Confirms create → subscribe → prompt → stream → dispose with no MCP.
2. **Real MCP, read-only:** `VR_SPIKE_CWD` = a vr-lab campaign dir on the Kali
   host; prompt a **read-only** query (e.g. summarise recorded surfaces via
   `campaign-mcp`, or a `notes-mcp` `target_history` lookup). Watch the tool
   call appear in the log.

## ⚠️ Safety

The spike runs with `autoApprove: true` (`src/omp-bridge.ts`) so you don't have
to build the approval UX yet. A vr-lab agent with auto-approve can execute real
tools against real infrastructure (WinRM to canary/torpedo, Ghidra, Proxmox,
fuzzing). **Only prompt read-only tasks while auto-approve is on.** Gating
anything that mutates lab state is exactly what the Phase 1 approval seam
(`setToolUIContext` / `request_permission`) is for.

## Known TODOs (expected, not bugs)

- Verify `settings` / `model` resolution on your host; pass them explicitly to
  `createAgentSession` if the defaults don't resolve (see
  `packages/coding-agent/src/commit/agentic/agent.ts` for the pattern).
- The exact `assistantMessageEvent` delta field is confirmed at runtime; the UI
  renders best-effort and falls back to printing the raw frame.
- Approvals are auto-approved; the `Approve` button is a Phase 1 placeholder.
