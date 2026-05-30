/**
 * categorize-flagged.js — Categorize flagged-drugs.csv into removal groups.
 * Dry-run only: prints counts + Category 2 list. Does NOT delete anything.
 * Run with --execute to perform actual deletion (handled in remove-drugs.js).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH  = join(__dirname, 'flagged-drugs.csv');

// ─── Category 2: Keep these brands even if flagged ───────────────────────────

const KEEP_BRAND_PREFIXES = [
  'tylenol', 'advil', 'motrin', 'aleve', 'tums', 'excedrin', 'midol',
  'pepcid', 'bayer', 'ecotrin', 'bufferin', 'claritin', 'flonase',
  'voltaren', 'alka-seltzer', 'alka seltzer', 'imodium', 'robitussin',
  'feverall', 'panadol', 'humalog', 'proactiv', 'abreva', 'rogaine',
];

// Exact brand_name matches to keep regardless of prefix rule
const KEEP_EXACT = new Set([
  'childrens tylenol',
  'infants tylenol',
]);

// ─── Category 1: Auto-remove criteria ────────────────────────────────────────

const STORE_BRAND_PREFIXES = [
  'equate ', 'cvs ', 'cvs health', 'good sense', 'topcare', 'dg health',
  'good neighbor pharmacy', 'signature care', 'up and up', 'basic care',
  'foster and thrive', 'kirkland', 'members mark', 'leader ', 'careone',
  'careall', 'equaline', 'family wellness', 'dollar general', 'walgreen',
  'meijer', 'kroger', 'heb ', 'rugby', 'cardinal ', 'exchange select',
  'market basket', 'best choice', 'quality choice', 'publix', 'winco',
  'rexall', 'bi-mart', 'guardian ', 'goodsense', 'goodnow',
  'amazon basic care', 'berkley and jensen', 'lil drug store',
  // additional store chains seen in data
  'rite aid', 'right remedies', 'circle k', 'signature select',
  'genexa', 'pediacare', 'medique', 'topcare', 'nobleaid', 'pharbetol',
  'careall', 'dg health', 'gericare', 'sunmark', 'rugby', 'pharbetol',
  'adwe ', 'xpect ', 'gencare', 'rapidol', 'clear choice', 'counteract',
  'kosher meds', 'mommys bliss', 'parents choice', 'wellsley farms',
  'perrigo', 'oh so clean', 'notts ', 'aurophen', 'mapap', 'genexa',
  'good neighbor', 'lil drug', 'walgreens saline', 'sinucleanse',
];

const MISSPELLINGS = [
  'reliver', 'releiver', 'stregth', 'strenght', 'acetaminohpen',
];

const HAIR_REGROWTH_WORDS = [
  'hair regrowth', 'hair growth', 'hair loss', 'minoxidil',
  'regaine', 'regrowth treatment',
];

const SALINE_WORDS = ['saline', 'nasal mist', 'nasal relief'];

const OXYGEN_WORDS = ['oxygen compressed', 'oxygen refrigerated', 'oxygen usp'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startsWithAny(lower, prefixes) {
  return prefixes.find(p => lower.startsWith(p));
}

function containsAny(lower, terms) {
  return terms.find(t => lower.includes(t));
}

function containsAnyWord(lower, words) {
  const tokens = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  return words.find(w => tokens.includes(w));
}

function categorize(drug) {
  const lower  = drug.brand_name.toLowerCase();
  const reason = drug.flag_reason;

  // Category 2 takes priority — check first
  if (KEEP_EXACT.has(lower) || startsWithAny(lower, KEEP_BRAND_PREFIXES)) {
    return { cat: 2, why: 'recognized brand' };
  }

  const cat1reasons = [];

  // All generic words
  if (reason.includes('all generic words')) {
    cat1reasons.push('all generic words');
  }

  // Store brand
  const storeBrandHit = startsWithAny(lower, STORE_BRAND_PREFIXES);
  if (storeBrandHit) cat1reasons.push(`store brand: "${storeBrandHit.trim()}"`);

  // Hair regrowth
  const hairHit = containsAny(lower, HAIR_REGROWTH_WORDS);
  if (hairHit) cat1reasons.push(`hair regrowth variant: "${hairHit}"`);

  // Saline / nasal spray
  const salineHit = containsAny(lower, SALINE_WORDS);
  if (salineHit) cat1reasons.push(`saline/nasal: "${salineHit}"`);

  // Oxygen / compressed gas
  const oxygenHit = containsAny(lower, OXYGEN_WORDS);
  if (oxygenHit) cat1reasons.push(`oxygen/gas: "${oxygenHit}"`);

  // Misspelling
  const spellingHit = containsAnyWord(lower, MISSPELLINGS);
  if (spellingHit) cat1reasons.push(`misspelling: "${spellingHit}"`);

  if (cat1reasons.length > 0) {
    return { cat: 1, why: cat1reasons.join(' | ') };
  }

  return { cat: 3, why: 'flagged, no auto-remove match' };
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const lines = text.trim().split('\n');
  // Skip header
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas inside
    const parts = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        parts.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    parts.push(cur);
    return {
      slug:         parts[0],
      brand_name:   parts[1],
      total_reports: parseInt(parts[2], 10) || 0,
      flag_reason:  parts[3],
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const csv   = readFileSync(CSV_PATH, 'utf8');
const drugs = parseCsv(csv);

const cat1 = [], cat2 = [], cat3 = [];

for (const drug of drugs) {
  const { cat, why } = categorize(drug);
  if (cat === 1) cat1.push({ ...drug, cat_why: why });
  else if (cat === 2) cat2.push({ ...drug, cat_why: why });
  else cat3.push({ ...drug, cat_why: why });
}

console.log('\nPillSignal — Flagged Drug Categorization');
console.log('═'.repeat(60));
console.log(`Total flagged  : ${drugs.length}`);
console.log(`Category 1     : ${cat1.length}  (auto-remove)`);
console.log(`Category 2     : ${cat2.length}  (keep — recognized brands)`);
console.log(`Category 3     : ${cat3.length}  (remove, logged)`);
console.log(`Total to remove: ${cat1.length + cat3.length}`);

console.log('\n── Category 2 (KEEPING these) ──────────────────────────────');
cat2.forEach((d, i) => {
  console.log(`  ${String(i+1).padStart(2)}. ${d.brand_name.padEnd(50)} ${(d.total_reports||0).toLocaleString('en-US').padStart(8)} reports`);
});

// Write removal slugs to a file for remove-drugs.js to consume
const toRemove = [...cat1, ...cat3];
const slugList = toRemove.map(d => d.slug).join('\n');
writeFileSync(join(__dirname, 'remove-slugs.txt'), slugList, 'utf8');

// Write cat3 log
const cat3Csv = ['slug,brand_name,total_reports,flag_reason,cat_why',
  ...cat3.map(d => [d.slug, `"${d.brand_name}"`, d.total_reports, `"${d.flag_reason}"`, `"${d.cat_why}"`].join(','))
].join('\n');
writeFileSync(join(__dirname, 'removed-cat3-log.csv'), cat3Csv, 'utf8');

console.log('\n── Category 3 preview (first 20, full list in removed-cat3-log.csv) ──');
cat3.slice(0, 20).forEach((d, i) => {
  console.log(`  ${String(i+1).padStart(2)}. ${d.brand_name.padEnd(50)} ${(d.total_reports||0).toLocaleString('en-US').padStart(8)} reports`);
});

console.log(`\nremove-slugs.txt written: ${toRemove.length} slugs queued for removal.`);
console.log('Review above, then run: node scripts/remove-drugs.js');
