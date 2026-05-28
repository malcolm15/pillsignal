/**
 * build-full-drug-list.js — PillSignal drug discovery
 *
 * Queries the OpenFDA FAERS count endpoint year-by-year (2004–2026) to discover
 * all unique brand names. Each yearly slice returns up to 1000 brand names;
 * combining them yields far more than the single-query cap.
 *
 * Outputs scripts/drug-list.json in the same format as the existing file.
 * Generic names are left empty — fetch-data.js fills them from the label API.
 *
 * Usage:
 *   node scripts/build-full-drug-list.js
 *
 * Requires: OPENFDA_API_KEY in .env
 */

import 'dotenv/config';
import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { OPENFDA_API_KEY } = process.env;
if (!OPENFDA_API_KEY) {
  console.error('ERROR: OPENFDA_API_KEY not set in .env');
  process.exit(1);
}

const FAERS_BASE       = 'https://api.fda.gov/drug/event.json';
const CALL_DELAY_MS    = 300;
const MIN_REPORT_COUNT = 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Slug generation ──────────────────────────────────────────────────────────

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip special chars except hyphens
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse repeated hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}

// ─── Brand name cleaning ──────────────────────────────────────────────────────

// Patterns that indicate a dosage/formulation suffix rather than a brand name.
// We strip at the first occurrence of these.
const DOSAGE_PATTERN = /[,\s]+(?:\d[\d.,]*\s*(?:MG|MCG|ML|G|IU|MEQ|%|UNIT)|TABLETS?|CAPSULES?|USP|NF|HCL|INJECTION|SOLUTION|CREAM|OINTMENT|PATCH|SPRAY|SYRUP|SUSPENSION|POWDER|GEL|LOTION|DROPS?|INHALER)\b.*/i;

// Patterns that are clearly not brand names
const REJECT_PATTERN = /^\d|^(UNKNOWN|NOT SPECIFIED|OTHER|NONE|NA|N\/A|VARIOUS|MULTIPLE|PLACEBO|SALINE|WATER|GLUCOSE|SODIUM CHLORIDE)$/i;

function cleanBrandName(raw) {
  // Strip dosage/formulation suffixes
  let name = raw.replace(DOSAGE_PATTERN, '').trim();
  // Remove trailing commas/dots/dashes left after stripping
  name = name.replace(/[,.\-–—]+$/, '').trim();
  // Title case (preserve internal caps for acronyms)
  name = name.replace(/\b\w/g, c => c.toUpperCase()).replace(/\b([A-Z]{2,})\b/g, w => w);
  return name;
}

function isValidBrandName(name) {
  if (!name || name.length < 2 || name.length > 60) return false;
  if (REJECT_PATTERN.test(name)) return false;
  // Reject if it still contains dosage indicators after cleaning
  if (/\d\s*(mg|mcg|ml|g|iu|meq|%)/i.test(name)) return false;
  return true;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchBrandNamesForYear(year) {
  const start = `${year}0101`;
  const end   = `${year}1231`;
  const url   =
    `${FAERS_BASE}?search=receivedate:[${start}+TO+${end}]` +
    `&count=patient.drug.openfda.brand_name.exact&limit=1000&api_key=${OPENFDA_API_KEY}`;

  try {
    const res = await fetch(url);
    if (res.status === 404) return [];
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`  [${year}] HTTP ${res.status}: ${body.slice(0, 100)}`);
      return [];
    }
    const data = await res.json();
    return data.results ?? [];
  } catch (err) {
    console.warn(`  [${year}] network error: ${err.message}`);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — Build Full Drug List\n');

  // Load existing drug list to preserve hand-curated slugs
  const existingPath = join(__dirname, 'drug-list-original.json');
  let existingDrugs = [];
  try {
    existingDrugs = JSON.parse(readFileSync(existingPath, 'utf8'));
    console.log(`Loaded ${existingDrugs.length} existing drugs for slug preservation\n`);
  } catch {
    console.log('No existing drug list found — slugs will all be generated fresh\n');
  }

  // Build lookup maps from the existing list
  // Keyed by lowercase brand_name and by slug for flexible matching
  const existingByName = new Map(existingDrugs.map(d => [d.brand_name.toLowerCase(), d]));
  const existingBySlug = new Map(existingDrugs.map(d => [d.slug, d]));

  const START_YEAR = 2004;
  const END_YEAR   = 2026;
  const years      = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i);

  // Collect all raw brand name terms across all years, summing counts
  const rawCounts = new Map(); // term → total count across years

  for (const year of years) {
    process.stdout.write(`  Fetching ${year}...`);
    const results = await fetchBrandNamesForYear(year);
    for (const r of results) {
      const prev = rawCounts.get(r.term) ?? 0;
      rawCounts.set(r.term, prev + r.count);
    }
    console.log(` ${results.length} brands (running unique: ${rawCounts.size})`);
    await sleep(CALL_DELAY_MS);
  }

  console.log(`\nRaw unique terms collected: ${rawCounts.size}`);
  const belowThreshold = [...rawCounts.values()].filter(c => c < MIN_REPORT_COUNT).length;
  console.log(`Below ${MIN_REPORT_COUNT}-report threshold: ${belowThreshold}`);

  // Phase 1: seed the merged map with ALL existing drugs (guaranteed inclusion)
  const slugMap = new Map(); // slug → { brand_name, generic_name, count, source }

  for (const drug of existingDrugs) {
    slugMap.set(drug.slug, {
      brand_name:   drug.brand_name,
      generic_name: drug.generic_name ?? '',
      count:        0,
      source:       'original',
    });
  }

  // Phase 2: add API-discovered drugs not already covered
  let addedFromApi = 0;

  for (const [raw, count] of rawCounts) {
    if (count < MIN_REPORT_COUNT) continue;

    const cleaned = cleanBrandName(raw);
    if (!isValidBrandName(cleaned)) continue;

    const generatedSlug = toSlug(cleaned);
    if (!generatedSlug) continue;

    // Check if this drug is already covered (by slug or by brand name)
    const coveredBySlug = slugMap.has(generatedSlug);
    const coveredByName = existingByName.has(cleaned.toLowerCase());
    if (coveredBySlug || coveredByName) {
      // Update count on existing entry for reporting, but don't overwrite anything
      const key = coveredBySlug ? generatedSlug : [...slugMap.entries()].find(([, v]) => v.brand_name.toLowerCase() === cleaned.toLowerCase())?.[0];
      if (key && slugMap.get(key).count === 0) slugMap.get(key).count = count;
      continue;
    }

    slugMap.set(generatedSlug, {
      brand_name:   cleaned,
      generic_name: '',
      count,
      source:       'api',
    });
    addedFromApi++;
  }

  // Sort alphabetically
  const drugs = [...slugMap.entries()]
    .sort(([, a], [, b]) => a.brand_name.localeCompare(b.brand_name))
    .map(([slug, { brand_name, generic_name }]) => ({ brand_name, generic_name, slug }));

  console.log(`\nMerge results:`);
  console.log(`  Original drugs (always included): ${existingDrugs.length}`);
  console.log(`  New drugs added from API:         ${addedFromApi}`);
  console.log(`  Total merged:                     ${drugs.length}`);

  const output = drugs;

  const outPath = join(__dirname, 'drug-list.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nWrote ${output.length} drugs to scripts/drug-list.json`);
  console.log('\nTop 10 API drugs by report count:');
  [...slugMap.entries()]
    .filter(([, v]) => v.source === 'api')
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10)
    .forEach(([slug, { brand_name, count }], i) =>
      console.log(`  ${i + 1}. ${brand_name} (${count.toLocaleString()} reports) → ${slug}`)
    );
  console.log('\nNext: review the count, then run node scripts/fetch-data.js\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
