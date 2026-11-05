-- Temcool schema. Applied automatically on startup (idempotent).
-- Timestamps that the app compares are stored as epoch milliseconds in
-- BIGINT columns so the Node process and PostgreSQL never disagree on
-- time zones. Audit columns use TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS sessions (
  sid              TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL,
  password         TEXT NOT NULL,
  token            TEXT NOT NULL DEFAULT '',
  token_expires_at BIGINT NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL,
  inbox_expires_at BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  ip               TEXT,
  user_agent       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_address_idx ON sessions (address);

-- One row per inbox lifecycle event. Powers the public counter and gives
-- operators a lightweight audit trail.
CREATE TABLE IF NOT EXISTS inbox_events (
  id         BIGSERIAL PRIMARY KEY,
  address    TEXT,
  action     TEXT NOT NULL CHECK (action IN ('created', 'extended', 'deleted')),
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_events_created_at_idx ON inbox_events (created_at);
CREATE INDEX IF NOT EXISTS inbox_events_action_idx ON inbox_events (action);

-- Sliding-window inbox creation limit, shared by every app instance.
CREATE TABLE IF NOT EXISTS rate_limits (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_ip_created_idx ON rate_limits (ip, created_at);
