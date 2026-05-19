-- db/schema.sql
-- Evan AI — PostgreSQL schema
-- Redis handles: sessions, short-lived caches, real-time queues, rate limits.
-- Postgres handles: durable records, outcome tracking, accuracy metrics, portfolio.
--
-- Run: psql $DATABASE_URL -f db/schema.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy text search on item names

-- ─────────────────────────────────────────────────────────────────────────────
-- scan_sessions
-- One row per scan attempt. Linked to outcomes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       TEXT        NOT NULL UNIQUE,         -- matches Redis scan key
  user_id       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Vision identity
  brand         TEXT,
  model         TEXT,
  category      TEXT,
  condition     TEXT,
  identity_quality REAL,                             -- 0.0–1.0

  -- Market query
  query         TEXT,
  comps_count   INTEGER     DEFAULT 0,
  depth_tier    TEXT,                                -- INSUFFICIENT/THIN/DEVELOPING/ADEQUATE/DEEP

  -- Pricing
  price_median  REAL,
  price_p10     REAL,
  price_p90     REAL,
  scanned_price REAL,
  deal_strength REAL,

  -- Signal outputs
  buy_signal         TEXT,                           -- STRONG BUY, GOOD DEAL, etc.
  buy_signal_raw     TEXT,                           -- before depth/liquidity cap
  trust_score        REAL,
  confidence_v2      REAL,
  liquidity_score    REAL,
  resale_score       REAL,
  demand_score       REAL,

  -- Platform
  platform_source    TEXT,                           -- ebay, facebook, etc.
  image_url          TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_sessions_user_id  ON scan_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_signal    ON scan_sessions(buy_signal);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_category  ON scan_sessions(category);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_created   ON scan_sessions(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- scan_outcomes
-- One row per user-reported outcome.
-- Separate from scan_sessions so outcomes can arrive weeks later.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_outcomes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       TEXT        NOT NULL,                -- FK to scan_sessions.scan_id
  user_id       TEXT        NOT NULL,
  reported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What happened
  did_buy       BOOLEAN     NOT NULL DEFAULT FALSE,
  buy_price     REAL,
  did_sell      BOOLEAN     NOT NULL DEFAULT FALSE,
  sell_price    REAL,
  sold_at       TIMESTAMPTZ,
  pass_reason   TEXT,                                -- why they passed if !did_buy

  -- Computed P&L (stored for fast aggregation)
  gross_profit  REAL,                                -- sell_price - buy_price
  net_profit    REAL,                                -- after platform fees + shipping
  platform_fees REAL,
  shipping_cost REAL,
  sell_platform TEXT,
  is_win        BOOLEAN,                             -- net_profit > 0

  -- Signal at time of scan (denormalized for accuracy tracking)
  signal_shown  TEXT,                                -- the signal the user saw
  signal_raw    TEXT,                                -- before any adjustment

  -- Verification
  verified_at   TIMESTAMPTZ,                         -- if we cross-verified the outcome
  verify_method TEXT,                                -- 'user_photo', 'receipt', 'platform_api', 'none'
  is_verified   BOOLEAN     NOT NULL DEFAULT FALSE,

  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_outcomes_user_id       ON scan_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_scan_id       ON scan_outcomes(scan_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_signal_shown  ON scan_outcomes(signal_shown);
CREATE INDEX IF NOT EXISTS idx_outcomes_reported_at   ON scan_outcomes(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_is_win        ON scan_outcomes(is_win);

-- Prevent duplicate outcomes per scan
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_scan_unique
  ON scan_outcomes(scan_id, user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- accuracy_snapshots
-- Pre-computed accuracy metrics. Updated by background worker.
-- Avoids expensive real-time aggregation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accuracy_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Overall
  total_scans          INTEGER DEFAULT 0,
  total_reported       INTEGER DEFAULT 0,
  total_wins           INTEGER DEFAULT 0,
  total_losses         INTEGER DEFAULT 0,
  reporting_rate       REAL,                         -- 0–100
  reported_accuracy    REAL,                         -- 0–100 raw (biased up)
  corrected_accuracy   REAL,                         -- 0–100 bias-corrected
  calibration_score    REAL,                         -- 0–100

  -- Per-signal breakdown (JSON for flexibility)
  signal_breakdown     JSONB,

  -- Bias correction metadata
  loser_silence_factor REAL DEFAULT 0.65,
  inflation_estimate   REAL                          -- how much raw is inflated
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accuracy_user_latest
  ON accuracy_snapshots(user_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_accuracy_user_id    ON accuracy_snapshots(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- portfolio_items
-- Active holdings + sold items. Source of truth for P&L ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_items (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       TEXT        NOT NULL UNIQUE,          -- stable client-side ID
  user_id       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Identity
  title         TEXT,
  brand         TEXT,
  model         TEXT,
  category      TEXT,
  condition     TEXT,
  image_url     TEXT,

  -- Financials
  buy_price     REAL,
  target_sell   REAL,
  list_price    REAL,

  -- Lifecycle
  status        TEXT        NOT NULL DEFAULT 'HOLDING',  -- HOLDING, LISTED, SOLD, DONATED, LOST
  purchased_at  TIMESTAMPTZ,
  listed_at     TIMESTAMPTZ,
  sold_at       TIMESTAMPTZ,
  sell_price    REAL,
  net_profit    REAL,                                 -- computed at sell
  sell_platform TEXT,

  -- Linked to scan
  scan_id       TEXT,

  -- Tags
  tags          TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user_id    ON portfolio_items(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_status     ON portfolio_items(status);
CREATE INDEX IF NOT EXISTS idx_portfolio_category   ON portfolio_items(category);
CREATE INDEX IF NOT EXISTS idx_portfolio_created    ON portfolio_items(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- watchlist_items
-- Items user wants to monitor for price drops.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist_items (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id        TEXT        NOT NULL UNIQUE,
  user_id         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked    TIMESTAMPTZ,

  -- What to watch
  query           TEXT        NOT NULL,
  brand           TEXT,
  model           TEXT,
  category        TEXT,

  -- Targets
  target_price    REAL,
  added_price     REAL,                               -- price when watchlist entry created
  current_price   REAL,

  -- Alert state
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  alert_triggered BOOLEAN     NOT NULL DEFAULT FALSE,
  alert_type      TEXT,                               -- target_hit, new_low, significant_drop
  alert_pct_drop  REAL,                               -- % drop threshold

  -- Linked to scan
  scan_id         TEXT
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user_id    ON watchlist_items(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_active     ON watchlist_items(is_active, last_checked);
CREATE INDEX IF NOT EXISTS idx_watchlist_category   ON watchlist_items(category);

-- ─────────────────────────────────────────────────────────────────────────────
-- signal_calibration_global
-- Aggregate cross-user accuracy. One row per signal tier, updated by worker.
-- Used to detect global model drift.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_calibration_global (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_days INTEGER     NOT NULL DEFAULT 90,        -- rolling window

  signal      TEXT        NOT NULL,
  reported    INTEGER     DEFAULT 0,
  wins        INTEGER     DEFAULT 0,
  losses      INTEGER     DEFAULT 0,
  win_rate    REAL,                                   -- 0–100

  target_win_rate    REAL,
  calibration_gap    REAL,                            -- win_rate - target_win_rate
  is_calibrated      BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_sig_cal_signal_date
  ON signal_calibration_global(signal, computed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- price_history
-- Tracks price over time for watched/scanned items. Powers price history chart.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  query         TEXT        NOT NULL,
  category      TEXT,

  price_p10     REAL,
  price_p25     REAL,
  price_median  REAL,
  price_p75     REAL,
  price_p90     REAL,
  price_min     REAL,
  price_max     REAL,
  comps_count   INTEGER,
  liquidity_score REAL,
  depth_tier    TEXT,

  source        TEXT                                  -- ebay, facebook, etc.
);

CREATE INDEX IF NOT EXISTS idx_price_history_query   ON price_history(query, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_date    ON price_history(recorded_at DESC);

-- Trim old price history automatically (keep 180 days)
-- Can be run as a periodic job:
-- DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '180 days';

-- ─────────────────────────────────────────────────────────────────────────────
-- outcome_solicitations
-- WS1: Tracks outcome solicitation attempts (push prompts) for empirical
-- silence factor computation. 20% of scans are randomly sampled.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_solicitations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id               TEXT        NOT NULL,
  user_id               TEXT        NOT NULL,
  category              TEXT,
  signal_type           TEXT,                                -- STRONG BUY, GOOD DEAL, etc.
  solicitation_sent_at  TIMESTAMPTZ,
  response_received_at  TIMESTAMPTZ,
  response              TEXT        CHECK (response IN ('WIN', 'LOSS', NULL)),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitations_scan_user
  ON outcome_solicitations(scan_id, user_id);
CREATE INDEX IF NOT EXISTS idx_solicitations_user_id    ON outcome_solicitations(user_id);
CREATE INDEX IF NOT EXISTS idx_solicitations_category   ON outcome_solicitations(category);
CREATE INDEX IF NOT EXISTS idx_solicitations_sent_at    ON outcome_solicitations(solicitation_sent_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- calibration_audit
-- WS7: Weekly cross-user audit table. Tracks win rate drift per
-- category + signal_type over time. Auto-suppression writes Redis keys.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calibration_audit (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT        NOT NULL,
  week_start      DATE        NOT NULL,
  signal_type     TEXT        NOT NULL,
  total_outcomes  INTEGER     DEFAULT 0,
  win_count       INTEGER     DEFAULT 0,
  win_rate        REAL,                                      -- 0.0–1.0
  expected_rate   REAL,                                      -- 0.0–1.0 target
  status          TEXT        CHECK (status IN ('PASS', 'WARN', 'FAIL')),
  weeks_failing   INTEGER     DEFAULT 0,
  action_taken    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_audit_cat_week_sig
  ON calibration_audit(category, week_start, signal_type);
CREATE INDEX IF NOT EXISTS idx_cal_audit_status     ON calibration_audit(status);
CREATE INDEX IF NOT EXISTS idx_cal_audit_week_start ON calibration_audit(week_start DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- scan_outcomes — Phase 5 lifecycle columns
-- Added separately so existing rows are unaffected (DEFAULT handles backfill).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE scan_outcomes
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'SCANNED'
    CHECK (lifecycle_state IN ('SCANNED','WATCHED','BOUGHT','SKIPPED','LISTED','SOLD','RETURNED','FAILED_EXIT'));

ALTER TABLE scan_outcomes
  ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outcomes_lifecycle_state
  ON scan_outcomes(lifecycle_state);

-- ─────────────────────────────────────────────────────────────────────────────
-- outcome_events
-- Per-item ordered event log for the outcome lifecycle state machine.
-- Every state transition, financial note, and annotation is stored here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  event_type    TEXT        NOT NULL,                   -- state_transition | financial_note | annotation | rescan
  from_state    TEXT,
  to_state      TEXT,
  price_actual  REAL,                                   -- dollar amount if relevant
  price_label   TEXT,                                   -- buy_price | sell_price | list_price | return_credit
  platform      TEXT,
  notes         TEXT,
  meta          JSONB
);

CREATE INDEX IF NOT EXISTS idx_outcome_events_scan_id     ON outcome_events(scan_id);
CREATE INDEX IF NOT EXISTS idx_outcome_events_user_id     ON outcome_events(user_id);
CREATE INDEX IF NOT EXISTS idx_outcome_events_created     ON outcome_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_events_event_type  ON outcome_events(event_type);
CREATE INDEX IF NOT EXISTS idx_outcome_events_to_state    ON outcome_events(to_state);

-- ─────────────────────────────────────────────────────────────────────────────
-- realized_profit_ledger
-- Tracks ONLY confirmed realized P&L from actual buy+sell pairs.
-- netProfitRealized = confirmed. netProfitEstimated = fee estimation used.
-- Never written with hypothetical or estimated prices.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS realized_profit_ledger (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  scan_id       TEXT,                                   -- optional link to scan_sessions
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Item identity
  category      TEXT,
  brand         TEXT,
  model         TEXT,

  -- REALIZED — actual confirmed values (user-provided)
  buy_price_realized   REAL        NOT NULL,
  sell_price_realized  REAL        NOT NULL,
  gross_profit         REAL        NOT NULL,            -- sell_price - buy_price

  -- Fees: exactly one of realized or estimated will be set
  platform_fee_realized   REAL,                        -- actual fee paid (receipt/API); NULL if not provided
  platform_fee_estimated  REAL,                        -- estimated from fee schedule; NULL if realized provided
  shipping_realized       REAL,                        -- actual shipping; NULL if not provided

  -- Net profit: exactly one of realized or estimated will be set
  net_profit_realized   REAL,                          -- NULL if platform_fee_realized not provided
  net_profit_estimated  REAL,                          -- NULL if platform_fee_realized was provided

  -- Metadata
  sell_platform    TEXT,
  signal_at_buy    TEXT,                               -- Evan signal when user decided to buy
  days_to_sell     INTEGER,
  is_win           BOOLEAN     NOT NULL DEFAULT FALSE,
  is_verified      BOOLEAN     NOT NULL DEFAULT FALSE  -- cross-verified via receipt/API
);

CREATE INDEX IF NOT EXISTS idx_profit_ledger_user_id     ON realized_profit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_profit_ledger_recorded_at ON realized_profit_ledger(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_profit_ledger_category    ON realized_profit_ledger(user_id, category);
CREATE INDEX IF NOT EXISTS idx_profit_ledger_is_win      ON realized_profit_ledger(user_id, is_win);
