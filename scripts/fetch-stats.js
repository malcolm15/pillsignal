/**
 * fetch-stats.js — Stage 1b: openFDA aggregate statistics -> scripts/stats-data.json
 *
 * Fetches DATABASE-WIDE aggregate numbers straight from openFDA's count
 * endpoints (~10 queries). These are the true totals across the whole
 * drug/event database. We deliberately do NOT sum our per-drug Supabase data
 * for these: one report can name multiple drugs, so summing double-counts.
 *
 * Output feeds the /statistics/ page rendered by generate-pages.js, so the
 * page refreshes with our normal data cadence. Run alongside the refresh:
 *   node scripts/fetch-stats.js
 *
 * Requires: OPENFDA_API_KEY in .env. Native fetch (Node 18+).
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { OPENFDA_API_KEY } = process.env;
if (!OPENFDA_API_KEY) {
  console.error('Missing OPENFDA_API_KEY in .env');
  process.exit(1);
}

const FAERS_BASE = 'https://api.fda.gov/drug/event.json';
const CALL_DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── canonicalizeMed: MIRRORS fetch-data.js. Keep in sync with the source of
// truth there (see CLAUDE.md "Co-Reported Medications"). Duplicated because
// fetch-data.js runs on import and cannot be imported cleanly. ────────────────
const CO_FORM_WORDS = /\b(TABLETS?|CAPSULES?|CAPLETS?|ORAL|FILM[- ]?COATED|EXTENDED[- ]?RELEASE|DELAYED[- ]?RELEASE|PROLONGED[- ]?RELEASE|MODIFIED[- ]?RELEASE|SUSTAINED[- ]?RELEASE|USP|INJECTION|INJECTABLE|SOLUTION|SUSPENSION|CREAM|GEL|OINTMENT|PATCH|CHEWABLE|COATED|EFFERVESCENT|LOZENGE|SPRAY|INHALER|DROPS?|SYRUP|POWDER|SOLUBLE)\b/g;
const CO_SALT_WORDS = /\b(SODIUM|POTASSIUM|MAGNESIUM|CALCIUM|ZINC|SULFATE|SULPHATE|HYDROCHLORIDE|HCL|HYDROBROMIDE|HBR|BESYLATE|MESYLATE|MALEATE|TARTRATE|BITARTRATE|CITRATE|FUMARATE|SUCCINATE|ACETATE|PHOSPHATE|NITRATE|BROMIDE|CHLORIDE|OXALATE|DIHYDRATE|MONOHYDRATE|HEMIHYDRATE|ANHYDROUS|PROPIONATE|DIPROPIONATE|VALERATE|FUROATE|ENANTHATE|DECANOATE|PALMITATE|PAMOATE|EMBONATE|XINAFOATE|TROMETHAMINE|MICRONIZED)\b/g;
const CO_STOP_TOKENS  = new Set(['VITAMIN', 'MULTIVITAMIN', 'SUPPLEMENT', 'SUPPLEMENTS', 'HERBAL', 'UNKNOWN']);
const CO_STOP_PHRASES = ['PAIN RELIEVER'];

function canonicalizeMed(name) {
  return String(name)
    .toUpperCase()
    .replace(/[()\[\].,;:/]/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:MG|MCG|UG|G|GR|ML|L|%|IU|U|UNITS?|MEQ|MMOL)\b/g, ' ')
    .replace(/\b(?:ER|XR|SR|CR|IR|XL|DR|LA|XT|MR)\b/g, ' ')
    .replace(CO_FORM_WORDS, ' ')
    .replace(CO_SALT_WORDS, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function isStopName(canon) {
  if (!canon) return true;
  if (/^\d+$/.test(canon)) return true;
  for (const p of CO_STOP_PHRASES) if (canon.includes(p)) return true;
  for (const t of canon.split(' ')) if (CO_STOP_TOKENS.has(t)) return true;
  return false;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
async function api(params) {
  const url = `${FAERS_BASE}?${new URLSearchParams({ ...params, api_key: OPENFDA_API_KEY })}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { console.warn('  [rate limit] waiting 10s'); await sleep(10_000); continue; }
      if (!res.ok) { console.warn(`  [HTTP ${res.status}] ${(await res.text().catch(() => '')).slice(0, 160)}`); return null; }
      return await res.json();
    } catch (err) {
      if (attempt === 3) { console.warn(`  [network] ${err.message}`); return null; }
      await sleep(2_000);
    }
  }
  return null;
}
async function total() {
  await sleep(CALL_DELAY_MS);
  const d = await api({ limit: '1' });
  return d?.meta?.results?.total ?? 0;
}
async function count(field, limit = 100) {
  await sleep(CALL_DELAY_MS);
  const d = await api({ count: field, limit: String(limit) });
  return d?.results ?? [];
}
async function countSeries(field) {
  await sleep(CALL_DELAY_MS);
  const d = await api({ count: field }); // date fields return the full time series
  return d?.results ?? [];
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const termOf = (rows, t) => rows.find(r => r.term === t)?.count ?? 0;

// ─── main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('Fetching openFDA aggregate statistics...\n');

  // 1. Total reports in the database
  const totalReports = await total();
  console.log(`total reports: ${totalReports.toLocaleString()}`);

  // 2. Reports by year (aggregate the daily receivedate series) + data cutoff
  const series = await countSeries('receivedate');
  const byYear = new Map();
  let maxDate = '';
  for (const { time, count: c } of series) {
    if (!time || time.length !== 8) continue;
    if (time > maxDate) maxDate = time;
    const y = Number(time.slice(0, 4));
    byYear.set(y, (byYear.get(y) || 0) + c);
  }
  const YEAR_FLOOR = 2004; // modern FAERS era; earlier years are sparse noise
  const dataCutoff = `${maxDate.slice(0, 4)}-${maxDate.slice(4, 6)}-${maxDate.slice(6, 8)}`;
  const cutoffYear = Number(maxDate.slice(0, 4));
  const cutoffIsYearEnd = maxDate.slice(4) === '1231';
  const latestFullYear = cutoffIsYearEnd ? cutoffYear : cutoffYear - 1;
  const reportsByYear = [...byYear.keys()]
    .filter(y => y >= YEAR_FLOOR && y <= cutoffYear)
    .sort((a, b) => a - b)
    .map(y => ({ year: y, count: byYear.get(y), partial: y > latestFullYear }));
  const latestFullYearReports = byYear.get(latestFullYear) || 0;
  const prevFullYearReports   = byYear.get(latestFullYear - 1) || 0;
  const yoyChangePct = prevFullYearReports
    ? Math.round(((latestFullYearReports - prevFullYearReports) / prevFullYearReports) * 1000) / 10
    : 0;
  const peak = reportsByYear.filter(r => !r.partial).reduce((a, b) => (b.count > a.count ? b : a));
  console.log(`data cutoff: ${dataCutoff}  latest full year: ${latestFullYear} (${latestFullYearReports.toLocaleString()}, YoY ${yoyChangePct}%)`);

  // 3. Top reactions database-wide
  const topReactions = (await count('patient.reaction.reactionmeddrapt.exact', 20))
    .map(r => ({ term: r.term, count: r.count }));
  console.log(`top reaction: ${topReactions[0]?.term} (${topReactions[0]?.count.toLocaleString()})`);

  // 4. Serious vs non-serious (serious=1 serious, 2 non-serious)
  const ser = await count('serious');
  const serious = { serious: termOf(ser, 1), nonSerious: termOf(ser, 2) };
  const serDen = serious.serious + serious.nonSerious;
  serious.seriousPct = pct(serious.serious, serDen);
  serious.nonSeriousPct = pct(serious.nonSerious, serDen);

  // 5. Serious outcome flags (term 1 = flag set). % is of ALL reports.
  const [death, hosp, life, disab] = await Promise.all([
    count('seriousnessdeath'), count('seriousnesshospitalization'),
    count('seriousnesslifethreatening'), count('seriousnessdisabling'),
  ]);
  const outcomeFlags = {
    death:            { count: termOf(death, 1), pctOfTotal: pct(termOf(death, 1), totalReports) },
    hospitalization:  { count: termOf(hosp, 1),  pctOfTotal: pct(termOf(hosp, 1), totalReports) },
    lifeThreatening:  { count: termOf(life, 1),  pctOfTotal: pct(termOf(life, 1), totalReports) },
    disabling:        { count: termOf(disab, 1), pctOfTotal: pct(termOf(disab, 1), totalReports) },
  };

  // 6. Sex (1 male, 2 female, 0 unknown). Report as % of KNOWN.
  const sx = await count('patient.patientsex');
  const male = termOf(sx, 1), female = termOf(sx, 2), sexUnknown = termOf(sx, 0);
  const sexKnown = male + female;
  const sex = {
    female, male, unknown: sexUnknown, known: sexKnown,
    knownPctOfTotal: pct(sexKnown, totalReports),
    femalePctOfKnown: pct(female, sexKnown),
    malePctOfKnown: pct(male, sexKnown),
  };

  // 7. Reporter type (primarysource.qualification 1..5). % of known.
  const QUAL = { 1: 'Physician', 2: 'Pharmacist', 3: 'Other health professional', 4: 'Lawyer', 5: 'Consumer or non-health professional' };
  const rq = await count('primarysource.qualification');
  const repKnown = rq.reduce((s, r) => s + r.count, 0);
  const reporter = rq
    .filter(r => QUAL[r.term])
    .sort((a, b) => b.count - a.count)
    .map(r => ({ type: QUAL[r.term], count: r.count, pctOfKnown: pct(r.count, repKnown) }));

  // 8. Most-reported medications (canonicalized + merged, top 15)
  const rawDrugs = await count('patient.drug.openfda.generic_name.exact', 100);
  const merged = new Map();
  for (const { term, count: c } of rawDrugs) {
    const canon = canonicalizeMed(term);
    if (isStopName(canon)) continue;
    // keep highest representative count for a canonical ingredient (matches co-reported logic)
    if (!merged.has(canon) || c > merged.get(canon)) merged.set(canon, c);
  }
  const topDrugs = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([canon, c]) => ({ canonical: canon, count: c })); // display recasing + linking happen at generate time

  const out = {
    fetchedAt: new Date().toISOString(),
    dataCutoff,
    yearFloor: YEAR_FLOOR,
    totalReports,
    latestFullYear,
    latestFullYearReports,
    prevFullYearReports,
    yoyChangePct,
    peakYear: { year: peak.year, count: peak.count },
    reportsByYear,
    topReactions,
    serious,
    outcomeFlags,
    sex,
    reporter,
    topDrugs,
  };

  const outPath = join(__dirname, 'stats-data.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${outPath}`);
}

run().catch(err => { console.error(err); process.exit(1); });
