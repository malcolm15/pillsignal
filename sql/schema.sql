-- PillSignal Database Schema. Run this in the Supabase SQL Editor.

-- ─── drugs ───────────────────────────────────────────────────────────────────

CREATE TABLE drugs (
  id               SERIAL PRIMARY KEY,
  brand_name       TEXT NOT NULL,
  generic_name     TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  total_reports    INTEGER NOT NULL DEFAULT 0,
  description      TEXT,
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

-- ─── co_reported_drugs ────────────────────────────────────────────────────────
-- Medications most frequently co-reported in the same FAERS/AEMS reports as this
-- drug, by normalized openfda generic_name. Stored canonicalized, self-excluded,
-- stoplist-filtered, and floor-filtered by fetch-data.js (top 5 per drug). This is
-- co-occurrence only; see CLAUDE.md for the framing rule (never interaction/causation).

CREATE TABLE co_reported_drugs (
  id      SERIAL PRIMARY KEY,
  drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX ON adverse_events (drug_id);
CREATE INDEX ON demographics (drug_id);
CREATE INDEX ON outcomes (drug_id);
CREATE INDEX ON trends (drug_id);
CREATE INDEX ON co_reported_drugs (drug_id);

CREATE UNIQUE INDEX ON trends (drug_id, year, quarter);
CREATE UNIQUE INDEX ON demographics (drug_id, dimension, value);
CREATE UNIQUE INDEX ON outcomes (drug_id, outcome);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE drugs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE adverse_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE demographics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trends             ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_reported_drugs  ENABLE ROW LEVEL SECURITY;
