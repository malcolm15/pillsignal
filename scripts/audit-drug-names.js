/**
 * audit-drug-names.js — PillSignal drug name quality audit
 *
 * Reads all drugs from Supabase and flags entries that are likely NOT real
 * drug brand names. Outputs scripts/flagged-drugs.csv for human review.
 * Does NOT delete or modify any data.
 *
 * Usage:
 *   node scripts/audit-drug-names.js
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing environment variables. Check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Heuristic word lists ──────────────────────────────────────────────────────

// H1: Generic symptom / condition words
const SYMPTOM_WORDS = new Set([
  'pain', 'relief', 'allergy', 'allergies', 'allergic', 'cold', 'colds',
  'flu', 'cough', 'coughing', 'headache', 'heartburn', 'arthritis', 'sinus',
  'sleep', 'fever', 'antacid', 'laxative', 'stool', 'softener', 'acid',
  'reflux', 'indigestion', 'gas', 'bloating', 'constipation', 'diarrhea',
  'nausea', 'itch', 'itching', 'itchy', 'rash', 'congestion', 'inflammation',
  'runny', 'mucus', 'immune',
]);

// H2: Dosage / form / variant words
const FORM_WORDS = new Set([
  'mg', 'mcg', 'ml', 'iu', 'tablet', 'tablets', 'capsule', 'capsules',
  'caplet', 'caplets', 'chewable', 'liquid', 'gel', 'gels', 'cream', 'creams',
  'ointment', 'spray', 'sprays', 'drop', 'drops', 'syrup', 'suspension',
  'suppository', 'suppositories', 'patch', 'patches', 'injection', 'injections',
  'solution', 'lotion', 'softgel', 'softgels', 'gummy', 'gummies', 'lozenge',
  'lozenges', 'powder', 'foam', 'film', 'strip', 'strips',
]);

// H3: Retail / strength indicator phrases (substring match on lowercased name)
const RETAIL_PHRASES = [
  'extra strength', 'maximum strength', 'max strength', 'regular strength',
  "children's", 'childrens', "infant's", 'infants', 'nighttime', 'daytime',
  'night time', 'day time',
];

// H3 single-word retail indicators (whole-word match)
const RETAIL_WORDS = new Set([
  'junior', 'nighttime', 'daytime', 'pm', 'am',
]);

// H5: Comprehensive generic-word vocabulary — if ALL words in a name are from
// this set (or are pure numbers), the name has no real brand component.
const GENERIC_VOCAB = new Set([
  // symptom / condition
  'pain', 'relief', 'allergy', 'allergies', 'allergic', 'cold', 'colds', 'flu',
  'cough', 'coughing', 'headache', 'heartburn', 'arthritis', 'sinus', 'sleep',
  'fever', 'antacid', 'laxative', 'stool', 'softener', 'acid', 'reflux',
  'indigestion', 'gas', 'bloating', 'constipation', 'diarrhea', 'nausea',
  'itch', 'itching', 'itchy', 'rash', 'congestion', 'inflammation', 'runny',
  'nose', 'throat', 'mucus', 'immune', 'immunity',
  // form / dosage
  'mg', 'mcg', 'ml', 'iu', 'tablet', 'tablets', 'capsule', 'capsules',
  'caplet', 'caplets', 'chewable', 'liquid', 'liquids', 'gel', 'gels', 'cream',
  'creams', 'ointment', 'spray', 'sprays', 'drop', 'drops', 'syrup',
  'suspension', 'suppository', 'suppositories', 'patch', 'patches', 'injection',
  'injections', 'solution', 'lotion', 'softgel', 'softgels', 'gummy', 'gummies',
  'lozenge', 'lozenges', 'powder', 'foam', 'film', 'strip', 'strips',
  // strength / release type
  'extra', 'maximum', 'max', 'regular', 'strength', 'strong', 'low', 'high',
  'dose', 'doses', 'extended', 'release', 'delayed', 'immediate', 'long',
  'acting', 'slow', 'fast', 'rapid', 'instant', 'quick', 'sustained',
  'controlled', 'modified', 'timed',
  // demographics / timing
  'adult', 'adults', 'children', 'childrens', 'child', 'infant', 'infants',
  'baby', 'babies', 'junior', 'senior', 'seniors', 'nighttime', 'night',
  'daytime', 'day', 'pm', 'am', 'hour', 'hours',
  // descriptors / flavors / retail adjectives
  'advanced', 'complete', 'ultra', 'super', 'original', 'natural', 'herbal',
  'organic', 'pure', 'gentle', 'sensitive', 'mild', 'severe', 'assorted',
  'berry', 'berries', 'cherry', 'grape', 'mint', 'orange', 'vanilla', 'lemon',
  'flavor', 'flavored', 'flavour', 'coated', 'enteric', 'buffered', 'plus',
  'and', 'with', 'for', 'non', 'drowsy', 'new', 'improved', 'value', 'generic',
  // common non-brand drug substance names
  'aspirin', 'ibuprofen', 'acetaminophen', 'naproxen', 'diphenhydramine',
  'pseudoephedrine', 'guaifenesin', 'dextromethorphan', 'loperamide',
  'famotidine', 'omeprazole', 'ranitidine', 'calcium', 'magnesium', 'zinc',
  'sodium', 'bicarbonate', 'simethicone', 'bismuth', 'subsalicylate',
  'docusate', 'senna', 'bisacodyl', 'loratadine', 'cetirizine', 'fexofenadine',
]);

// ─── Audit logic ──────────────────────────────────────────────────────────────

function tokenize(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function isNumeric(w) {
  return /^\d+(\.\d+)?$/.test(w);
}

function auditDrug(drug) {
  const name     = drug.brand_name || '';
  const lower    = name.toLowerCase();
  const words    = tokenize(name);
  const reasons  = [];

  // H1 — symptom / condition words
  const symptomHit = words.find(w => SYMPTOM_WORDS.has(w));
  if (symptomHit) reasons.push(`symptom word: "${symptomHit}"`);

  // H2 — dosage / form words
  const formHit = words.find(w => FORM_WORDS.has(w));
  if (formHit) reasons.push(`form word: "${formHit}"`);

  // H3 — retail phrases (substring) and single retail words (whole-word)
  const phraseHit = RETAIL_PHRASES.find(p => lower.includes(p));
  if (phraseHit) {
    reasons.push(`retail phrase: "${phraseHit}"`);
  } else {
    const retailWordHit = words.find(w => RETAIL_WORDS.has(w));
    if (retailWordHit) reasons.push(`retail word: "${retailWordHit}"`);
  }

  // H4 — more than 4 words
  if (words.length > 4) reasons.push(`long name: ${words.length} words`);

  // H5 — all words are generic (no real brand component)
  if (words.length > 0 && words.every(w => GENERIC_VOCAB.has(w) || isNumeric(w))) {
    reasons.push('all generic words');
  }

  return reasons;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function fetchAllDrugs() {
  const all   = [];
  const batch = 1000;
  let   from  = 0;

  while (true) {
    const { data, error } = await supabase
      .from('drugs')
      .select('id, slug, brand_name, generic_name, total_reports')
      .order('total_reports', { ascending: false })
      .range(from, from + batch - 1);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
  }

  return all;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function csvField(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — Drug Name Audit');
  console.log('Fetching drugs from Supabase...\n');

  const drugs   = await fetchAllDrugs();
  const flagged = [];

  for (const drug of drugs) {
    const reasons = auditDrug(drug);
    if (reasons.length > 0) {
      flagged.push({ ...drug, flag_reason: reasons.join(' | ') });
    }
  }

  // Sort by total_reports descending (already sorted from Supabase, but make explicit)
  flagged.sort((a, b) => (b.total_reports ?? 0) - (a.total_reports ?? 0));

  // Write CSV
  const header = ['slug', 'brand_name', 'total_reports', 'flag_reason'];
  const rows   = flagged.map(d => [
    csvField(d.slug),
    csvField(d.brand_name),
    csvField(d.total_reports ?? 0),
    csvField(d.flag_reason),
  ].join(','));

  const csv    = [header.join(','), ...rows].join('\n');
  const outPath = join(__dirname, 'flagged-drugs.csv');
  writeFileSync(outPath, csv, 'utf8');

  // Summary
  const clean = drugs.length - flagged.length;
  console.log(`Total drugs   : ${drugs.length}`);
  console.log(`Flagged       : ${flagged.length}`);
  console.log(`Clean         : ${clean}`);
  console.log(`\nCSV written to: scripts/flagged-drugs.csv`);
  console.log('\nTop 20 flagged (by report count):');
  flagged.slice(0, 20).forEach((d, i) => {
    const reports = (d.total_reports ?? 0).toLocaleString('en-US');
    console.log(`  ${String(i + 1).padStart(2)}. ${d.brand_name.padEnd(45)} ${reports.padStart(8)} reports — ${d.flag_reason}`);
  });
  console.log('\nReview scripts/flagged-drugs.csv to decide which entries to remove.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
