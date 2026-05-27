-- Migration: add description column to drugs table
-- Run this in the Supabase SQL Editor before running fetch-data.js

ALTER TABLE drugs ADD COLUMN IF NOT EXISTS description TEXT;
