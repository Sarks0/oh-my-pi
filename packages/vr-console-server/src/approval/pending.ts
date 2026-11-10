/**
 * PendingRegistry — correlates a UI request pushed to the browser (approval card,
 * select, confirm, input) with the browser's later reply. Each request mints an id,
 * pushes a WS frame carrying it, and returns a promise the server resolves when the
 * matching `{ type:"reply", id, value }` frame arrives.
 *
 * Fail-closed by construction: `rejectAll(safeDefault)` resolves every outstanding
 * request to a safe value (for approvals: "deny") on dispose/disconnect, so a turn
 * parked in `session.waitForUser` (agent-session.ts:1558, non-interruptible) never
 * hangs forever and never silently auto-approves.
 */
export type Broadcast = (frame: unknown) => void;

interface Pending {
	resolve: (value: unknown) => void;
	kind: string;
}

export class PendingRegistry {
	#seq = 0;
	#pending = new Map<string, Pending>();

	constructor(private broadcast: Broadcast) {}

	/** Push `frame` (with a fresh id) to the browser and await its reply value. */
	request(kind: string, frame: Record<string, unknown>): Promise<unknown> {
		const id = kind + "_" + ++this.#seq;
		return new Promise(resolve => {
			this.#pending.set(id, { resolve, kind });
			this.broadcast({ ...frame, type: frame.type ?? kind, id });
		});
	}

	/** Resolve the request `id` with the browser's value. Returns false if unknown/stale. */
	resolve(id: string, value: unknown): boolean {
		const p = this.#pending.get(id);
		if (!p) return false;
		this.#pending.delete(id);
		p.resolve(value);
		return true;
	}

	get size(): number {
		return this.#pending.size;
	}

	/** Resolve every outstanding request to a safe default (approvals → "deny"). */
	rejectAll(safeDefault: unknown): void {
		for (const [, p] of this.#pending) p.resolve(safeDefault);
		this.#pending.clear();
	}
}
