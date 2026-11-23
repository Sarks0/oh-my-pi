/**
 * Event shaping for the VR Console spike.
 *
 * Adapted from `printableEvent()` in
 * `packages/coding-agent/src/modes/print-mode.ts` (it is NOT re-exported from
 * the package index, so the logic is copied here on purpose).
 *
 * Why this matters: forwarding raw `AgentSessionEvent`s over the socket grows
 * the payload quadratically — a single long turn re-serializes its whole
 * in-progress message on every streamed delta (the omp authors hit multi-GB
 * transcripts; see the comment above `printableEvent` in print-mode.ts). So we:
 *   - drop the `message_update` snapshot and keep only the incremental delta
 *     (the authoritative message still arrives in `message_end`), and
 *   - strip `providerPayload`, which is transport-native replay state that is
 *     opaque and useless outside the omp process.
 */
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items). */
function stripProviderPayload<T extends { providerPayload?: unknown }>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/**
 * Shape an `AgentSessionEvent` into a compact JSON frame for the browser.
 * Mirrors print-mode's `--mode json` output shaping.
 */
export function shapeEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "tool_stream_update":
			return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}
