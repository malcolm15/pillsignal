-- PillSignal Database Schema. Run this in the Supabase SQL Editor.

-- ─── drugs ───────────────────────────────────────────────────────────────────

CREATE TABLE drugs (
  id               SERIAL PRIMARY KEY,
  brand_name       TEXT NOT NULL,
  generic_name     TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  total_reports    INTEGER NOT NULL DEFAULT 0,
  first_report_date DATE,
  last_updated     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── adverse_events ───────────────────────────────────────────────────────────

CREATE TABLE adverse_events (
  id       SERIAL PRIMARY KEY,
  drug_id  INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0
);

-- ─── demographics ─────────────────────────────────────────────────────────────

CREATE TABLE demographics (
  id        SERIAL PRIMARY KEY,
  drug_id   INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  value     TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0
);

-- ─── outcomes ─────────────────────────────────────────────────────────────────

CREATE TABLE outcomes (
  id      SERIAL PRIMARY KEY,
  drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0
);

-- ─── trends ───────────────────────────────────────────────────────────────────

CREATE TABLE trends (
  id      SERIAL PRIMARY KEY,
  drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  year    INTEGER NOT NULL,
  quarter INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX ON adverse_events (drug_id);
CREATE INDEX ON demographics (drug_id);
CREATE INDEX ON outcomes (drug_id);
CREATE INDEX ON trends (drug_id);

CREATE UNIQUE INDEX ON trends (drug_id, year, quarter);
CREATE UNIQUE INDEX ON demographics (drug_id, dimension, value);
CREATE UNIQUE INDEX ON outcomes (drug_id, outcome);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE drugs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE adverse_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE demographics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trends          ENABLE ROW LEVEL SECURITY;
