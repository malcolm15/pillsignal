/**
 * fetch-data.js — PillSignal Stage 1
 *
 * Reads scripts/drug-list.json, queries the OpenFDA FAERS API for each drug,
 * and stores aggregated results in Supabase.
 *
 * Usage:
 *   node scripts/fetch-data.js                    # process all drugs
 *   node scripts/fetch-data.js --limit 5          # process first 5 (for testing)
 *   node scripts/fetch-data.js --only mirena,advil # process only these slugs
 *
 * Requires: OPENFDA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 * Native fetch is used (Node 18+). No node-fetch needed.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
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

// --only slug1,slug2 — restrict the run to specific slugs (targeted re-fetch).
function getCLIOnly() {
  const idx = process.argv.indexOf('--only');
  if (idx !== -1 && process.argv[idx + 1]) {
    return new Set(process.argv[idx + 1].split(',').map(s => s.trim()).filter(Boolean));
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

// ─── Co-reported medications ──────────────────────────────────────────────────
// Medications most often reported in the SAME FAERS/AEMS report as this drug,
// counted by normalized openfda generic_name. This is co-occurrence only, never
// an interaction or causal signal (see CLAUDE.md). The raw generic_name field is
// fragmented into dose/form/salt variants, so we canonicalize and dedupe before
// storing the top results.

const CO_SELF_CAPTURE   = 0.5;  // a generic in >=50% of the drug's reports IS the drug itself
const CO_SELF_HEURISTIC = 0.9;  // fallback guard: drop anything in >=90% of reports
const CO_FLOOR_PCT      = 0.01; // noise floor: >=1% of the drug's total reports...
const CO_FLOOR_MIN      = 25;   // ...but never below an absolute 25 reports
const CO_MAX            = 5;    // store at most this many per drug

// Fuzzy self-match: catch misspellings of the drug's OWN name (e.g. Lexapro's
// "ESCITSLOPRAM", distance 1 from "ESCITALOPRAM"). Count-independent, so it never
// touches the count thresholds above and cannot drop a legitimate co-reported drug
// by frequency. Guards keep it from dropping similarly named but DIFFERENT drugs.
const CO_FUZZY_MAX_DIST = 2;    // max Levenshtein distance to a self-alias token
const CO_FUZZY_LEN_TOL  = 0.2;  // candidate length must be within 20% of the alias token
const CO_FUZZY_MIN_LEN  = 5;    // only fuzzy-match alias tokens this long (precision guard)

// Levenshtein edit distance with an early exit once it exceeds CO_FUZZY_MAX_DIST.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > CO_FUZZY_MAX_DIST) return CO_FUZZY_MAX_DIST + 1;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}

// Dose/form/salt vocabulary stripped during canonicalization.
const CO_FORM_WORDS = /\b(TABLETS?|CAPSULES?|CAPLETS?|ORAL|FILM[- ]?COATED|EXTENDED[- ]?RELEASE|DELAYED[- ]?RELEASE|PROLONGED[- ]?RELEASE|MODIFIED[- ]?RELEASE|SUSTAINED[- ]?RELEASE|USP|INJECTION|INJECTABLE|SOLUTION|SUSPENSION|CREAM|GEL|OINTMENT|PATCH|CHEWABLE|COATED|EFFERVESCENT|LOZENGE|SPRAY|INHALER|DROPS?|SYRUP|POWDER|SOLUBLE)\b/g;
const CO_SALT_WORDS = /\b(SODIUM|POTASSIUM|MAGNESIUM|CALCIUM|ZINC|SULFATE|SULPHATE|HYDROCHLORIDE|HCL|HYDROBROMIDE|HBR|BESYLATE|MESYLATE|MALEATE|TARTRATE|BITARTRATE|CITRATE|FUMARATE|SUCCINATE|ACETATE|PHOSPHATE|NITRATE|BROMIDE|CHLORIDE|OXALATE|DIHYDRATE|MONOHYDRATE|HEMIHYDRATE|ANHYDROUS|PROPIONATE|DIPROPIONATE|VALERATE|FUROATE|ENANTHATE|DECANOATE|PALMITATE|PAMOATE|EMBONATE|XINAFOATE|TROMETHAMINE|MICRONIZED)\b/g;

// Non-drug descriptors and junk that should never appear as a co-reported "drug".
const CO_STOP_TOKENS  = new Set(['VITAMIN', 'MULTIVITAMIN', 'SUPPLEMENT', 'SUPPLEMENTS', 'HERBAL', 'UNKNOWN']);
const CO_STOP_PHRASES = ['PAIN RELIEVER'];

// Collapse a raw openfda generic_name to a plain, patient-recognizable ingredient.
function canonicalizeMed(name) {
  return String(name)
    .toUpperCase()
    .replace(/[()\[\].,;:/]/g, ' ')                                                      // punctuation
    .replace(/\b\d+(?:\.\d+)?\s*(?:MG|MCG|UG|G|GR|ML|L|%|IU|U|UNITS?|MEQ|MMOL)\b/g, ' ')  // dosage tokens
    .replace(/\b(?:ER|XR|SR|CR|IR|XL|DR|LA|XT|MR)\b/g, ' ')                               // release abbreviations
    .replace(CO_FORM_WORDS, ' ')
    .replace(CO_SALT_WORDS, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')                                                   // leftover bare numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function isStopName(canon) {
  if (!canon) return true;
  if (/^\d+$/.test(canon)) return true;                       // purely numeric
  for (const p of CO_STOP_PHRASES) if (canon.includes(p)) return true;
  for (const t of canon.split(' ')) if (CO_STOP_TOKENS.has(t)) return true;
  return false;
}

async function fetchCoReported(searchField, searchTerm, totalReports, drug) {
  await sleep(CALL_DELAY_MS);
  const data = await apiFetch(
    buildUrl(searchField, searchTerm, 'patient.drug.openfda.generic_name.exact', 100)
  );
  if (!data?.results || !totalReports) return [];

  // Self-exclusion. Build the drug's own name aliases as exact canonical names AND as
  // individual tokens for fuzzy matching. Seed from the brand and list generic
  // (canonicalize strips salt/ester suffixes, so "escitalopram oxalate" contributes
  // the token "ESCITALOPRAM"), plus any generic appearing in >=50% of the drug's own
  // reports (that IS the drug, e.g. Mirena -> LEVONORGESTREL). The >=90% rule remains
  // a secondary fallback guard at filter time.
  // Fuzzy matching is seeded ONLY from the brand and generic, the authoritative names
  // for THIS drug. The >=50% count-capture can grab a different drug that merely
  // co-occurs in most reports (e.g. another PPI in Nexium reports), so those terms go
  // to exact self-exclusion only, never to the fuzzy token set, or they would fuzzily
  // drop legitimate neighbors (e.g. lansoprazole capture dropping pantoprazole).
  const selfCanon   = new Set();   // exact canonical self names
  const aliasTokens = new Set();   // self tokens for fuzzy matching: brand + generic only
  const addExact = raw => { const c = canonicalizeMed(raw); if (c) selfCanon.add(c); };
  const addAlias = raw => {
    const c = canonicalizeMed(raw);
    if (!c) return;
    selfCanon.add(c);
    for (const t of c.split(' ')) if (t) aliasTokens.add(t);
  };
  addAlias(drug.brand_name);
  if (drug.generic_name) addAlias(drug.generic_name);
  for (const r of data.results) {
    if (r.count >= CO_SELF_CAPTURE * totalReports) addExact(r.term);
  }

  // A candidate is the drug itself if it matches a self name exactly, or is within a
  // small edit distance of a self-alias token. The length guard and minimum token
  // length keep this from dropping similarly named but DIFFERENT drugs (e.g.
  // hydralazine vs hydroxyzine).
  const isSelf = c => {
    if (selfCanon.has(c)) return true;
    for (const t of aliasTokens) {
      if (t.length < CO_FUZZY_MIN_LEN) continue;
      if (Math.abs(c.length - t.length) > CO_FUZZY_LEN_TOL * t.length) continue;
      if (levenshtein(c, t) <= CO_FUZZY_MAX_DIST) return true;
    }
    return false;
  };

  // Canonicalize + dedupe variants, keeping the highest count as the representative.
  const groups = new Map();
  for (const r of data.results) {
    if (r.count >= CO_SELF_HEURISTIC * totalReports) continue; // fallback self guard
    const c = canonicalizeMed(r.term);
    if (isStopName(c) || isSelf(c)) continue;
    if (!groups.has(c) || groups.get(c).count < r.count) groups.set(c, { name: c, count: r.count });
  }

  // Relative noise floor, then take the top CO_MAX.
  const floor = Math.max(CO_FLOOR_MIN, Math.ceil(CO_FLOOR_PCT * totalReports));
  return [...groups.values()]
    .filter(x => x.count >= floor)
    .sort((a, b) => b.count - a.count)
    .slice(0, CO_MAX);
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
  if (text.length <= 500) return text;
  // Find the last sentence boundary (period followed by space or end) within 500 chars
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
    supabase.from('co_reported_drugs').delete().eq('drug_id', drugId),
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

  // Warn when a drug matched only via generic_name fallback, not its brand name.
  // This is the root cause of duplicate-content clusters: every store-brand variant
  // that fails a brand-name lookup falls back to the generic and ingests the same
  // full generic dataset, creating pages that are clones of each other.
  if (method === 'generic_name') {
    console.warn(
      `  ${tag} ⚠  GENERIC FALLBACK: "${drug.brand_name}" has no brand-specific ` +
      `FAERS data — fell back to generic "${term}". ` +
      `If this drug is a store-label or variant of a generic, it will produce ` +
      `a duplicate-content page. Consider removing it from drug-list.json.`
    );
  }

  const adverseEvents   = await fetchAdverseEvents(field, term);
  const sexDemographics = await fetchSexDemographics(field, term);
  const ageDemographics = await fetchAgeDemographics(field, term);
  const outcomes        = await fetchOutcomes(field, term);
  const trends          = await fetchTrends(field, term);
  const coReported      = await fetchCoReported(field, term, totalReports, drug);
  const description     = await fetchDrugLabel(drug.brand_name, drug.generic_name);

  const drugId = await upsertDrug(drug, totalReports, description);
  await clearDrugData(drugId);

  await insertRows('adverse_events',   drugId, adverseEvents);
  await insertRows('demographics',     drugId, [...sexDemographics, ...ageDemographics]);
  await insertRows('outcomes',         drugId, outcomes);
  await insertRows('trends',           drugId, trends);
  await insertRows('co_reported_drugs', drugId, coReported);

  console.log(
    `  ${tag} Saved: ${adverseEvents.length} events,` +
    ` ${sexDemographics.length + ageDemographics.length} demographic rows,` +
    ` ${outcomes.length} outcomes,` +
    ` ${trends.length} trend periods,` +
    ` ${coReported.length} co-reported,` +
    ` description: ${description ? 'yes' : 'none'}`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const drugList = JSON.parse(
    readFileSync(join(__dirname, 'drug-list.json'), 'utf8')
  );

  const cliOnly  = getCLIOnly();
  const cliLimit = getCLILimit();
  const drugs    = cliOnly
    ? drugList.filter(d => cliOnly.has(d.slug))
    : cliLimit !== null ? drugList.slice(0, cliLimit) : drugList;

  // Up to 15 API calls per drug: 1–2 resolution + 9 data + 1 co-reported + 1–2 label
  const CALLS_PER_DRUG = 15;
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

  writeFileSync(
    join(__dirname, 'fetch-metadata.json'),
    JSON.stringify({ lastFetched: new Date().toISOString(), drugCount: drugs.length }, null, 2)
  );

  console.log('\nStage 1 complete.');
  console.log('Next: node scripts/generate-pages.js\n');
}

main();
