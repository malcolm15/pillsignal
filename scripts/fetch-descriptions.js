/**
 * fetch-descriptions.js — PillSignal targeted description refresh
 *
 * Reads all drugs from Supabase, fetches each drug's description from the
 * OpenFDA drug label API, and updates the description column. Skips all FAERS
 * event/demographic/outcomes/trends calls — much faster than a full fetch.
 *
 * Usage:
 *   node scripts/fetch-descriptions.js           # all drugs
 *   node scripts/fetch-descriptions.js --limit 5 # first 5 (testing)
 *
 * Requires: OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Environment ──────────────────────────────────────────────────────────────

const { OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!OPENFDA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing environment variables. Check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const LABEL_BASE    = 'https://api.fda.gov/drug/label.json';
const CALL_DELAY_MS = 260;

// ─── CLI flag ─────────────────────────────────────────────────────────────────

function getCLILimit() {
  const idx = process.argv.indexOf('--limit');
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (res.status === 429) {
        console.warn(`    [rate limit] Waiting 10s... (attempt ${attempt}/${retries})`);
        await sleep(10_000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`    [HTTP ${res.status}] ${body.slice(0, 160)}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) {
        console.warn(`    [network error] ${err.message}`);
        return null;
      }
      await sleep(2_000);
    }
  }
  return null;
}

// ─── Description extraction ───────────────────────────────────────────────────

function cleanDescription(raw) {
  if (!raw) return null;
  let text = raw
    .replace(/^\s*\d*\s*INDICATIONS?\s+AND\s+USAGE\s*[:\n]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= 500) return text;
  // Find the last sentence boundary within 500 chars
  const sub = text.slice(0, 500);
  const lastPeriod = sub.lastIndexOf('. ');
  if (lastPeriod > 80) return sub.slice(0, lastPeriod + 1);
  // No sentence boundary — truncate at last word
  const lastSpace = sub.lastIndexOf(' ');
  return (lastSpace > 80 ? sub.slice(0, lastSpace) : sub) + '…';
}

async function fetchDrugLabel(brandName, genericName) {
  const tryName = async (field, name) => {
    await sleep(CALL_DELAY_MS);
    const url = `${LABEL_BASE}?search=${field}:"${encodeURIComponent(name)}"&limit=1&api_key=${OPENFDA_API_KEY}`;
    const data = await apiFetch(url);
    const raw  = data?.results?.[0]?.indications_and_usage?.[0];
    return cleanDescription(raw) || null;
  };

  return (
    (await tryName('openfda.brand_name.exact',   brandName.toUpperCase()))   ??
    (await tryName('openfda.generic_name.exact', genericName.toUpperCase())) ??
    null
  );
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function fetchAllDrugs() {
  const all   = [];
  const batch = 1000;
  let   from  = 0;

  while (true) {
    const { data, error } = await supabase
      .from('drugs')
      .select('id, brand_name, generic_name, slug')
      .order('brand_name')
      .range(from, from + batch - 1);
    if (error) throw new Error(`Failed to fetch drugs: ${error.message}`);
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
  }

  return all;
}

async function updateDescription(drugId, description) {
  const { error } = await supabase
    .from('drugs')
    .update({ description: description ?? null })
    .eq('id', drugId);
  if (error) throw new Error(`Update failed: ${error.message}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allDrugs = await fetchAllDrugs();
  const cliLimit = getCLILimit();
  const drugs    = cliLimit !== null ? allDrugs.slice(0, cliLimit) : allDrugs;

  // 1–2 label API calls per drug
  const estMinutes = Math.ceil(drugs.length * 2 * CALL_DELAY_MS / 60_000);

  console.log('\nPillSignal — Description Refresh');
  console.log(`Drugs to process : ${drugs.length}`);
  console.log(`Estimated time   : ~${estMinutes} minute${estMinutes !== 1 ? 's' : ''}`);
  console.log('');

  let updated = 0;
  let nulled  = 0;
  let errors  = 0;

  for (let i = 0; i < drugs.length; i++) {
    const drug = drugs[i];
    const tag  = `[${i + 1}/${drugs.length}]`;

    try {
      const description = await fetchDrugLabel(drug.brand_name, drug.generic_name || '');
      await updateDescription(drug.id, description);

      if (description) {
        console.log(`  ${tag} ${drug.brand_name} — updated (${description.length} chars)`);
        updated++;
      } else {
        console.log(`  ${tag} ${drug.brand_name} — no label data`);
        nulled++;
      }
    } catch (err) {
      console.error(`  ${tag} ERROR — ${drug.brand_name}: ${err.message}`);
      errors++;
    }
  }

  console.log('\nDescription refresh complete.');
  console.log(`  Updated with description : ${updated}`);
  console.log(`  No label data found      : ${nulled}`);
  console.log(`  Errors                   : ${errors}`);
  console.log('\nNext: node scripts/generate-pages.js\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
