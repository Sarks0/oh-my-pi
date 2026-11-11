-- VR Console projection schema (DESIGN §3, §9).
-- Two populations (DESIGN §3.1):
--   * mirror tables  — read-only projection of the host FS (campaign-mcp is the
--                      source of truth; healed by re-read, never written back).
--   * console-owned  — the cost/token ledger and sync bookkeeping.
-- Idempotent (CREATE ... IF NOT EXISTS), applied on every startup (ARTEX idiom).
-- Deliberately NO foreign keys: a mirror is a projection and must tolerate the
-- host tree changing underneath it; the ledger must survive campaign deletion.

-- ── console-owned: cost / token ledger ────────────────────────────────────────
-- One row per assistant message_end, tapped from omp's own usage (DESIGN §9.1:
-- reuse provider-computed usage.cost.total, not a local rate card).
CREATE TABLE IF NOT EXISTS llm_usage (
	id            BIGSERIAL PRIMARY KEY,
	ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
	campaign_id   TEXT,
	session_cwd   TEXT,
	provider      TEXT,
	model         TEXT,
	api           TEXT,
	input         BIGINT NOT NULL DEFAULT 0,
	output        BIGINT NOT NULL DEFAULT 0,
	cache_read    BIGINT NOT NULL DEFAULT 0,
	cache_write   BIGINT NOT NULL DEFAULT 0,
	total_tokens  BIGINT NOT NULL DEFAULT 0,
	cost_total    DOUBLE PRECISION NOT NULL DEFAULT 0,
	stop_reason   TEXT
);
CREATE INDEX IF NOT EXISTS llm_usage_ts_idx ON llm_usage (ts DESC);
CREATE INDEX IF NOT EXISTS llm_usage_campaign_idx ON llm_usage (campaign_id);

-- ── mirror: campaigns (read-only projection of campaigns/{active,archived}/) ───
CREATE TABLE IF NOT EXISTS campaigns_mirror (
	id                TEXT PRIMARY KEY,
	archived          BOOLEAN NOT NULL DEFAULT false,
	platform          TEXT,
	scope             TEXT,
	title             TEXT,
	n_hallucinations  INTEGER NOT NULL DEFAULT 0,
	n_findings        INTEGER NOT NULL DEFAULT 0,
	n_rejected        INTEGER NOT NULL DEFAULT 0,
	n_surfaces        INTEGER NOT NULL DEFAULT 0,
	raw               JSONB,
	synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── mirror: findings (state is directory-derived; DESIGN §3) ──────────────────
CREATE TABLE IF NOT EXISTS findings_mirror (
	campaign_id         TEXT NOT NULL,
	id                  TEXT NOT NULL,
	state               TEXT NOT NULL,
	surface_id          TEXT,
	security_invariant  TEXT,
	gates               JSONB,
	raw                 JSONB,
	synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (campaign_id, id)
);
CREATE INDEX IF NOT EXISTS findings_mirror_state_idx ON findings_mirror (state);

-- ── console-owned: sync bookkeeping ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
	k           TEXT PRIMARY KEY,
	v           JSONB,
	updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
