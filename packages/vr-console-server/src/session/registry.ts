/**
 * SessionRegistry — many omp sessions behind one server (Phase B, multi-session).
 *
 * Each managed session owns its own OmpSessionAdapter (its own omp session, cwd,
 * approval PendingRegistry, cost/approval taps) plus the transport state that was
 * previously module-global: the set of WebSocket clients watching it and a small
 * ring buffer of recent frames replayed to a (re)connecting client.
 *
 * The adapter already takes its `broadcast` sink by constructor injection, so a
 * session just hands it a sink scoped to that session's sockets + history. Frames
 * are stored and sent PRISTINE — no session id is injected, because an approval
 * frame already carries its own `session` field (the "approve for this session"
 * grant label) and each socket only ever receives its own session's frames.
 */
import { OmpSessionAdapter } from "../adapter/omp-session-adapter";
import type { Db } from "../db/client";
import { recordUsage, usageFromEvent } from "../cost/ledger";
import { makeDbAuditor } from "../approval/audit";

/** Frames kept per session for replay to a newly-attached socket. */
const HISTORY_CAP = 300;

type Socket = Bun.ServerWebSocket<unknown>;

export interface SessionMeta {
	id: string;
	cwd: string;
	title: string;
	createdAt: string;
}

export interface SessionListItem extends SessionMeta {
	started: boolean;
	model: string | null;
	provider: string | null;
	sockets: number;
}

interface ManagedSession {
	meta: SessionMeta;
	adapter: OmpSessionAdapter;
	sockets: Set<Socket>;
	history: string[];
	startPromise?: Promise<void>;
}

/** Campaign id if a cwd is a campaign dir (…/campaigns/{active,archived}/<id>[/…]). */
function campaignIdFromCwd(cwd: string): string | undefined {
	return cwd.match(/\/campaigns\/(?:active|archived)\/([^/]+)/)?.[1];
}

/** A readable default title: the campaign id, else the cwd's basename, else the id. */
function defaultTitle(cwd: string, id: string): string {
	return campaignIdFromCwd(cwd) ?? cwd.split("/").filter(Boolean).pop() ?? id;
}

export class SessionRegistry {
	#sessions = new Map<string, ManagedSession>();
	#db: Db | undefined;

	constructor(deps: { db?: Db } = {}) {
		this.#db = deps.db;
	}

	/** Create a session (adapter built, not yet started). Returns its metadata. */
	create(opts: { cwd: string; title?: string; id?: string }): SessionMeta {
		const id = opts.id ?? `sess_${crypto.randomUUID().slice(0, 8)}`;
		if (this.#sessions.has(id)) throw new Error(`session ${id} already exists`);
		const meta: SessionMeta = {
			id,
			cwd: opts.cwd,
			title: opts.title?.trim() || defaultTitle(opts.cwd, id),
			createdAt: new Date().toISOString(),
		};

		// Transport state the scoped broadcast closes over AND the ManagedSession holds.
		const sockets = new Set<Socket>();
		const history: string[] = [];
		const broadcast = (frame: unknown): void => {
			const text = JSON.stringify(frame);
			history.push(text);
			if (history.length > HISTORY_CAP) history.shift();
			for (const ws of sockets) {
				try {
					ws.send(text);
				} catch {
					/* a dead socket must not break the fan-out */
				}
			}
		};

		const db = this.#db;
		const adapter = new OmpSessionAdapter(broadcast, {
			onRawEvent: db
				? ev => {
						const row = usageFromEvent(ev, { cwd: meta.cwd, campaignId: campaignIdFromCwd(meta.cwd) });
						if (row) recordUsage(db, row).catch(() => {});
					}
				: undefined,
			approvalAuditor: db ? makeDbAuditor(db, { cwd: meta.cwd, campaignId: campaignIdFromCwd(meta.cwd) }) : undefined,
		});

		this.#sessions.set(id, { meta, adapter, sockets, history });
		return meta;
	}

	has(id: string): boolean {
		return this.#sessions.has(id);
	}

	/** The adapter for a session, or undefined if unknown. */
	adapter(id: string): OmpSessionAdapter | undefined {
		return this.#sessions.get(id)?.adapter;
	}

	meta(id: string): SessionMeta | undefined {
		return this.#sessions.get(id)?.meta;
	}

	list(): SessionListItem[] {
		return [...this.#sessions.values()].map(s => {
			const info = s.adapter.sessionInfo();
			return { ...s.meta, started: info.started, model: info.model, provider: info.provider, sockets: s.sockets.size };
		});
	}

	/** Start a session's omp session once (idempotent). Rejects for an unknown id. */
	ensureStarted(id: string): Promise<void> {
		const s = this.#sessions.get(id);
		if (!s) return Promise.reject(new Error(`no such session: ${id}`));
		if (!s.startPromise) s.startPromise = s.adapter.start(s.meta.cwd);
		return s.startPromise;
	}

	/** Attach a socket to a session and replay its buffered history. false if unknown. */
	attach(id: string, ws: Socket): boolean {
		const s = this.#sessions.get(id);
		if (!s) return false;
		s.sockets.add(ws);
		for (const text of s.history) {
			try {
				ws.send(text);
			} catch {
				/* ignore */
			}
		}
		return true;
	}

	/** Remove a socket from whichever session holds it. */
	detach(ws: Socket): void {
		for (const s of this.#sessions.values()) s.sockets.delete(ws);
	}

	/** Dispose a session (its omp session is torn down, parked approvals denied). */
	async dispose(id: string): Promise<boolean> {
		const s = this.#sessions.get(id);
		if (!s) return false;
		this.#sessions.delete(id);
		await s.adapter.dispose().catch(() => {});
		return true;
	}

	async disposeAll(): Promise<void> {
		await Promise.all([...this.#sessions.keys()].map(id => this.dispose(id)));
	}
}
