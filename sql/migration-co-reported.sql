-- Migration: add co_reported_drugs table (and description column if missing).
-- Run once in the Supabase SQL Editor before the next fetch-data.js run.
-- Safe to re-run: uses IF NOT EXISTS guards.

ALTER TABLE drugs ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS co_reported_drugs (
  id      SERIAL PRIMARY KEY,
  drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS co_reported_drugs_drug_id_idx ON co_reported_drugs (drug_id);

ALTER TABLE co_reported_drugs ENABLE ROW LEVEL SECURITY;

-- Grant the API roles access, matching the other tables. Tables created after
-- project setup do not always inherit default privileges, so grant explicitly.
GRANT ALL ON TABLE    public.co_reported_drugs        TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.co_reported_drugs_id_seq TO anon, authenticated, service_role;
