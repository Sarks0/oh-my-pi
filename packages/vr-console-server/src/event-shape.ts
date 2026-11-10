/**
 * Event shaping — adapted from `printableEvent()` in
 * `packages/coding-agent/src/modes/print-mode.ts:88` (not re-exported, copied on
 * purpose). Drops `message_update` snapshots (keeping only the delta) and strips
 * `providerPayload`, so WS payloads grow linearly, not quadratically, with turn
 * length. Same guard the omp authors added after multi-GB transcripts upstream.
 */
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

function stripProviderPayload<T extends { providerPayload?: unknown }>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

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
