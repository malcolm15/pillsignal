/**
 * fetch-data.js — PillSignal Stage 1
 *
 * Reads scripts/drug-list.json, queries the OpenFDA FAERS API for each drug,
 * and stores aggregated results in Supabase.
 *
 * Usage:
 *   node scripts/fetch-data.js              # process all drugs
 *   node scripts/fetch-data.js --limit 5    # process first 5 (for testing)
 *
 * Requires: OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 * Native fetch is used (Node 18+). No node-fetch needed.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Environment ──────────────────────────────────────────────────────────────

const { OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!OPENFDA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing environment variables. Check your .env file.');
  console.error('Required: OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FAERS_BASE    = 'https://api.fda.gov/drug/event.json';
const LABEL_BASE    = 'https://api.fda.gov/drug/label.json';
const CALL_DELAY_MS = 260; // ~230 req/min — safely under the 240/min API key limit

// ─── CLI flag ─────────────────────────────────────────────────────────────────

function getCLILimit() {
  const idx = process.argv.indexOf('--limit');
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds an OpenFDA URL.
 * @param {string} searchField - e.g. "patient.drug.openfda.brand_name.exact"
 * @param {string} searchTerm  - already uppercased drug name
 * @param {string|null} countField - omit for a plain search (total count only)
 * @param {number} countLimit
 */
function buildUrl(searchField, searchTerm, countField = null, countLimit = 100) {
  const params = new URLSearchParams({
    search:  `${searchField}:"${searchTerm}"`,
    api_key: OPENFDA_API_KEY,
  });
  if (countField) {
    params.set('count', countField);
    params.set('limit', String(countLimit));
  } else {
    params.set('limit', '1');
  }
  return `${FAERS_BASE}?${params}`;
}

/**
 * Fetches a URL with retry logic.
 * - 404: no data for this query → returns null (not an error)
 * - 429: rate limited → waits 10s and retries up to 3 times
 * - Other errors: logs warning and returns null (script continues)
 */
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

// ─── Search term resolution ───────────────────────────────────────────────────

/**
 * Determines which search field + term to use for a drug.
 * Tries brand_name first (uppercased); falls back to generic_name (uppercased).
 * Returns null if neither yields results.
 *
 * @returns {{ field: string, term: string, totalReports: number, method: string } | null}
 */
async function resolveSearchTerm(drug) {
  const brandUpper   = drug.brand_name.toUpperCase();
  const genericUpper = drug.generic_name.toUpperCase();

  // Attempt 1: brand name
  await sleep(CALL_DELAY_MS);
  const brandData = await apiFetch(
    buildUrl('patient.drug.openfda.brand_name.exact', brandUpper)
  );
  if (brandData?.meta?.results?.total) {
    return {
      field:        'patient.drug.openfda.brand_name.exact',
      term:         brandUpper,
      totalReports: brandData.meta.results.total,
      method:       'brand_name',
    };
  }

  // Attempt 2: generic name
  await sleep(CALL_DELAY_MS);
  const genericData = await apiFetch(
    buildUrl('patient.drug.openfda.generic_name.exact', genericUpper)
  );
  if (genericData?.meta?.results?.total) {
    return {
      field:        'patient.drug.openfda.generic_name.exact',
      term:         genericUpper,
      totalReports: genericData.meta.results.total,
      method:       'generic_name',
    };
  }

  return null;
}

// ─── OpenFDA data fetchers ────────────────────────────────────────────────────

async function fetchAdverseEvents(searchField, searchTerm) {
  await sleep(CALL_DELAY_MS);
  const data = await apiFetch(
    buildUrl(searchField, searchTerm, 'patient.reaction.reactionmeddrapt.exact', 50)
  );
  if (!data?.results) return [];
  return data.results.map(r => ({
    event_name: r.term,
    count:      r.count,
  }));
}

// ─── Demographics: sex ────────────────────────────────────────────────────────

const SEX_LABELS = { '0': 'Unknown', '1': 'Male', '2': 'Female' };

async function fetchSexDemographics(searchField, searchTerm) {
  await sleep(CALL_DELAY_MS);
  const data = await apiFetch(
    buildUrl(searchField, searchTerm, 'patient.patientsex', 10)
  );
  if (!data?.results) return [];
  return data.results
    .filter(r => SEX_LABELS[String(r.term)])
    .map(r => ({
      dimension: 'sex',
      value:     SEX_LABELS[String(r.term)],
      count:     r.count,
    }));
}

// ─── Demographics: age ────────────────────────────────────────────────────────

function ageBucket(age) {
  if (age < 0 || age > 120) return null; // filter out implausible values
  if (age < 18) return '0-17';
  if (age < 35) return '18-34';
  if (age < 50) return '35-49';
  if (age < 65) return '50-64';
  if (age < 75) return '65-74';
  return '75+';
}

async function fetchAgeDemographics(searchField, searchTerm) {
  await sleep(CALL_DELAY_MS);
  const data = await apiFetch(
    buildUrl(searchField, searchTerm, 'patient.patientonsetage', 500)
  );
  if (!data?.results) return [];

  const buckets = {};
  for (const r of data.results) {
    const age = parseFloat(r.term);
    if (isNaN(age)) continue;
    const bucket = ageBucket(age);
    if (bucket) buckets[bucket] = (buckets[bucket] || 0) + r.count;
  }

  return Object.entries(buckets).map(([value, count]) => ({
    dimension: 'age',
    value,
    count,
  }));
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

const SERIOUSNESS_FIELDS = [
  { field: 'seriousnessdeath',           label: 'Death' },
  { field: 'seriousnesshospitalization', label: 'Hospitalization' },
  { field: 'seriousnesslifethreatening', label: 'Life-Threatening' },
  { field: 'seriousnessdisabling',       label: 'Disability' },
  { field: 'seriousnessother',           label: 'Other Serious' },
];

async function fetchOutcomes(searchField, searchTerm) {
  const outcomes = [];

  for (const { field, label } of SERIOUSNESS_FIELDS) {
    await sleep(CALL_DELAY_MS);
    const data = await apiFetch(buildUrl(searchField, searchTerm, field, 10));
    if (data?.results) {
      // term "1" = this seriousness flag was set on the report
      const hit = data.results.find(r => String(r.term) === '1');
      if (hit?.count) outcomes.push({ outcome: label, count: hit.count });
    }
  }

  // Non-serious: reports where serious === 2
  await sleep(CALL_DELAY_MS);
  const seriousData = await apiFetch(buildUrl(searchField, searchTerm, 'serious', 10));
  if (seriousData?.results) {
    const nonSerious = seriousData.results.find(r => String(r.term) === '2');
    if (nonSerious?.count) outcomes.push({ outcome: 'Non-Serious', count: nonSerious.count });
  }

  return outcomes;
}

// ─── Trends ───────────────────────────────────────────────────────────────────

async function fetchTrends(searchField, searchTerm) {
  await sleep(CALL_DELAY_MS);
  // receivedate returns { time: "YYYYMMDD", count: N } — note "time" not "term"
  const data = await apiFetch(buildUrl(searchField, searchTerm, 'receivedate', 1000));
  if (!data?.results) return [];

  const quarterly = {};
  for (const r of data.results) {
    const s = String(r.time);
    if (s.length < 6) continue;
    const year  = parseInt(s.slice(0, 4), 10);
    const month = parseInt(s.slice(4, 6), 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) continue;
    const quarter = Math.ceil(month / 3);
    const key = `${year}-${quarter}`;
    quarterly[key] = (quarterly[key] || 0) + r.count;
  }

  return Object.entries(quarterly).map(([key, count]) => {
    const [year, quarter] = key.split('-').map(Number);
    return { year, quarter, count };
  });
}

// ─── Drug label / description ─────────────────────────────────────────────────

function cleanDescription(raw) {
  if (!raw) return null;
  let text = raw
    .replace(/^\s*\d*\s*INDICATIONS?\s+AND\s+USAGE\s*[:\n]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  // Try to return the first complete sentence
  const m = text.match(/^.+?[.!?](?:\s|$)/);
  if (m) {
    const sentence = m[0].trim();
    if (sentence.length <= 200) return sentence;
  }
  if (text.length <= 200) return text;
  // Truncate at a word boundary near 200 chars
  const sub = text.slice(0, 200);
  const lastSpace = sub.lastIndexOf(' ');
  return (lastSpace > 80 ? sub.slice(0, lastSpace) : sub) + '...';
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

// ─── Supabase operations ──────────────────────────────────────────────────────

async function upsertDrug(drug, totalReports, description) {
  const { data, error } = await supabase
    .from('drugs')
    .upsert(
      {
        brand_name:    drug.brand_name,
        generic_name:  drug.generic_name,
        slug:          drug.slug,
        total_reports: totalReports,
        description:   description ?? null,
        last_updated:  new Date().toISOString(),
      },
      { onConflict: 'slug' }
    )
    .select('id')
    .single();

  if (error) throw new Error(`Upsert failed for "${drug.brand_name}": ${error.message}`);
  return data.id;
}

async function clearDrugData(drugId) {
  await Promise.all([
    supabase.from('adverse_events').delete().eq('drug_id', drugId),
    supabase.from('demographics').delete().eq('drug_id', drugId),
    supabase.from('outcomes').delete().eq('drug_id', drugId),
    supabase.from('trends').delete().eq('drug_id', drugId),
  ]);
}

async function insertRows(table, drugId, rows) {
  if (!rows.length) return;
  const { error } = await supabase
    .from(table)
    .insert(rows.map(r => ({ drug_id: drugId, ...r })));
  if (error) console.warn(`    [${table}] insert error: ${error.message}`);
}

// ─── Per-drug processor ───────────────────────────────────────────────────────

async function processDrug(drug, index, total) {
  const tag = `[${index}/${total}]`;

  const resolved = await resolveSearchTerm(drug);
  if (!resolved) {
    console.warn(`  ${tag} WARNING: no FAERS data for "${drug.brand_name}" (tried brand and generic) — skipping`);
    return;
  }

  const { field, term, totalReports, method } = resolved;
  console.log(`  ${tag} ${drug.brand_name} — matched via ${method} ("${term}", ${totalReports.toLocaleString()} reports)`);

  const adverseEvents   = await fetchAdverseEvents(field, term);
  const sexDemographics = await fetchSexDemographics(field, term);
  const ageDemographics = await fetchAgeDemographics(field, term);
  const outcomes        = await fetchOutcomes(field, term);
  const trends          = await fetchTrends(field, term);
  const description     = await fetchDrugLabel(drug.brand_name, drug.generic_name);

  const drugId = await upsertDrug(drug, totalReports, description);
  await clearDrugData(drugId);

  await insertRows('adverse_events', drugId, adverseEvents);
  await insertRows('demographics',   drugId, [...sexDemographics, ...ageDemographics]);
  await insertRows('outcomes',       drugId, outcomes);
  await insertRows('trends',         drugId, trends);

  console.log(
    `  ${tag} Saved: ${adverseEvents.length} events,` +
    ` ${sexDemographics.length + ageDemographics.length} demographic rows,` +
    ` ${outcomes.length} outcomes,` +
    ` ${trends.length} trend periods,` +
    ` description: ${description ? 'yes' : 'none'}`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const drugList = JSON.parse(
    readFileSync(join(__dirname, 'drug-list.json'), 'utf8')
  );

  const cliLimit = getCLILimit();
  const drugs    = cliLimit !== null ? drugList.slice(0, cliLimit) : drugList;

  // Up to 14 API calls per drug: 1–2 for FAERS resolution + 9 for data + 1–2 for label
  const CALLS_PER_DRUG = 14;
  const estMinutes = Math.ceil(drugs.length * CALLS_PER_DRUG * CALL_DELAY_MS / 60_000);

  console.log('\nPillSignal — Stage 1: Fetch');
  console.log(`Drugs to process : ${drugs.length}`);
  console.log(`Estimated time   : ~${estMinutes} minute${estMinutes !== 1 ? 's' : ''}`);
  console.log('');

  for (let i = 0; i < drugs.length; i++) {
    try {
      await processDrug(drugs[i], i + 1, drugs.length);
    } catch (err) {
      console.error(`  [${i + 1}/${drugs.length}] ERROR — ${drugs[i].brand_name}: ${err.message}`);
    }
  }

  console.log('\nStage 1 complete.');
  console.log('Next: node scripts/generate-pages.js\n');
}

main();
