/**
 * duplicate-audit.js — one-shot diagnostic
 * Queries Supabase to produce three reports:
 *   1. Duplicate clusters (same total_reports + same top-3 AE signature)
 *   2. Retailer/non-drug names in current drug list
 *   3. Legitimate generics in the removed-cat3-log.csv worth restoring
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Paginated fetch helper ───────────────────────────────────────────────────

async function fetchAll(table, select, order = null) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (order) q = q.order(order.col, { ascending: order.asc });
    const { data, error } = await q;
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {

  // --- Fetch all drugs ---
  console.error('Fetching drugs...');
  const drugs = await fetchAll('drugs', 'id, slug, brand_name, total_reports', { col: 'total_reports', asc: false });
  console.error(`  ${drugs.length} drugs loaded`);

  // --- Fetch top-3 adverse events per drug ---
  console.error('Fetching adverse_events...');
  const allAEs = await fetchAll('adverse_events', 'drug_id, event_name, count', { col: 'count', asc: false });
  console.error(`  ${allAEs.length} AE rows loaded`);

  // Build top-3 signature per drug_id
  const aeByDrug = {};
  for (const ae of allAEs) {
    if (!aeByDrug[ae.drug_id]) aeByDrug[ae.drug_id] = [];
    aeByDrug[ae.drug_id].push(ae);
  }
  const top3sig = {};
  for (const [drug_id, aes] of Object.entries(aeByDrug)) {
    const sorted = aes.sort((a, b) => b.count - a.count).slice(0, 3);
    top3sig[drug_id] = sorted.map(a => a.event_name.toUpperCase()).join('|');
  }

  // --- Build cluster key: total_reports + top3 signature ---
  const clusters = {};
  for (const drug of drugs) {
    const sig = top3sig[drug.id] || 'NO_AE';
    const key = `${drug.total_reports}::${sig}`;
    if (!clusters[key]) clusters[key] = { total_reports: drug.total_reports, sig, members: [] };
    clusters[key].members.push({ slug: drug.slug, brand_name: drug.brand_name });
  }

  // ─── REPORT 1: Duplicate clusters ──────────────────────────────────────────

  const dupClusters = Object.values(clusters)
    .filter(c => c.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length || b.total_reports - a.total_reports);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('REPORT 1: DUPLICATE CLUSTERS (same total_reports + same top-3 AE)');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`Total clusters with 2+ members: ${dupClusters.length}\n`);

  // Known major brands / generics to flag as canonical
  const CANONICAL_KEYWORDS = [
    'advil','motrin','ibuprofen',
    'tylenol','acetaminophen',
    'aspirin',
    'naproxen','aleve',
    'omeprazole','prilosec',
    'famotidine','pepcid',
    'ranitidine','zantac',
    'cetirizine','zyrtec',
    'diphenhydramine','benadryl',
    'folic acid','folic',
    'loratadine','claritin',
    'calcium carbonate','tums',
    'minoxidil','rogaine',
    'loperamide','imodium',
    'simethicone','gas-x',
    'pseudoephedrine','sudafed',
    'dextromethorphan',
    'guaifenesin','mucinex',
    'docusate','colace',
    'melatonin',
  ];

  function isCanonical(brand_name) {
    const lower = brand_name.toLowerCase();
    return CANONICAL_KEYWORDS.some(k => lower === k || lower.startsWith(k + ' ') || lower.endsWith(' ' + k));
  }

  for (const c of dupClusters) {
    const top3display = c.sig === 'NO_AE' ? '(no AE data)' : c.sig.split('|').map((e,i) => `#${i+1}: ${e}`).join(', ');
    console.log(`── Cluster: ${c.members.length} members | ${c.total_reports.toLocaleString()} reports | Top-3: ${top3display}`);
    for (const m of c.members) {
      const tag = isCanonical(m.brand_name) ? ' ← CANONICAL' : '';
      console.log(`   ${m.slug.padEnd(55)} ${m.brand_name}${tag}`);
    }
    console.log('');
  }

  // ─── REPORT 2: Retailer / non-drug names in current list ───────────────────

  const RETAILER_PATTERNS = [
    /\bwalgreen/i, /\bcvs\b/i, /\bwalmart\b/i, /\btarget\b/i, /\bkroger\b/i,
    /\bcostco\b/i, /\bkirkland\b/i, /\bsam'?s\b/i, /\bamazon\b/i, /\bequate\b/i,
    /\bup\s*&?\s*up\b/i, /\bsignature\s*care\b/i, /\bfoster\s*and\s*thrive\b/i,
    /\bfoster\s*&\s*thrive\b/i, /\bcare\s*one\b/i, /\bcareone\b/i,
    /\bequaline\b/i, /\bgood\s*neighbor\b/i, /\bgood\s*sense\b/i,
    /\bhenry\s*schein\b/i, /\bleader\b/i, /\brexall\b/i, /\btopcare\b/i,
    /\bassured\b/i, /\bbasic\s*care\b/i, /\bbetr\b/i,
    /\bcircle\s*k\b/i, /\b7[- ]?eleven\b/i, /\bcasey'?s\b/i,
    /\bdg\s*health\b/i, /\bdirect\s*safety\b/i,
    /\bmedi[\s-]?first\b/i, /\bvalumeds\b/i, /\bunishield\b/i,
    /\buline\b/i, /\bxpect\b/i, /\bdrx\b/i, /\bpca\b/i,
    /\brite\s*aid\b/i, /\bweis\b/i, /\bshoprite\b/i, /\bpublix\b/i,
    /\bmeijer\b/i, /\bwinn[\s-]?dixie\b/i, /\bhyvee\b/i, /\bhy[\s-]?vee\b/i,
    /\bmckesson\b/i, /\bcardinal\b/i, /\bbergen\b/i,
    // Non-drug generic descriptions
    /\bpain\s*relief\b/i, /\bfever\s*reduc/i, /\bpain\s*reliever\b/i,
    /\bacid\s*reduc/i, /\bacid\s*control/i, /\bantacid\b/i,
    /\bheartburn\b/i, /\ballergy\s*relief\b/i, /\bsleep\s*aid\b/i,
    /\bnasal\s*spray\b/i, /\bsaline\b/i,
  ];

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('REPORT 2: RETAILER / NON-DRUG NAMES IN CURRENT LIVE DRUG LIST');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const retailerMatches = drugs.filter(d => {
    return RETAILER_PATTERNS.some(p => p.test(d.brand_name));
  });

  if (retailerMatches.length === 0) {
    console.log('None found.\n');
  } else {
    console.log(`Found ${retailerMatches.length} entries:\n`);
    const groups = {};
    for (const d of retailerMatches) {
      const matchedPattern = RETAILER_PATTERNS.find(p => p.test(d.brand_name));
      const key = matchedPattern ? matchedPattern.source.replace(/\\b|\\/g,'').split('\\')[0] : 'other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    }
    for (const [key, list] of Object.entries(groups)) {
      for (const d of list) {
        console.log(`  [${d.total_reports.toLocaleString().padStart(8)}]  ${d.slug.padEnd(55)} ${d.brand_name}`);
      }
    }
  }

  // ─── REPORT 3: Legitimate generics in removal log ──────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('REPORT 3: LEGITIMATE GENERICS IN REMOVAL LOG (candidates to restore)');
  console.log('══════════════════════════════════════════════════════════════════\n');

  // Real generic active-ingredient names — single-word or short known compounds
  const REAL_GENERICS = [
    'ibuprofen', 'acetaminophen', 'aspirin', 'naproxen', 'naproxen sodium',
    'omeprazole', 'famotidine', 'ranitidine', 'cimetidine', 'esomeprazole',
    'lansoprazole', 'pantoprazole', 'rabeprazole',
    'cetirizine', 'loratadine', 'fexofenadine', 'diphenhydramine', 'chlorpheniramine',
    'pseudoephedrine', 'phenylephrine', 'oxymetazoline',
    'loperamide', 'simethicone', 'bismuth subsalicylate',
    'docusate', 'polyethylene glycol', 'lactulose', 'sennosides', 'senna',
    'guaifenesin', 'dextromethorphan', 'benzonatate',
    'melatonin', 'doxylamine',
    'calcium carbonate', 'magnesium hydroxide', 'aluminum hydroxide',
    'minoxidil', 'finasteride',
    'folic acid', 'ascorbic acid', 'pyridoxine', 'thiamine', 'riboflavin',
    'zinc', 'iron', 'ferrous sulfate',
    'hydrocortisone', 'clotrimazole', 'miconazole', 'terbinafine',
    'benzoyl peroxide', 'salicylic acid', 'adapalene',
    'lidocaine', 'benzocaine',
    'glycerin', 'petrolatum',
  ];

  const logPath = join(__dirname, 'removed-cat3-log.csv');
  const logLines = readFileSync(logPath, 'utf8').split('\n').slice(1).filter(Boolean);

  const parsed = logLines.map(line => {
    const [slug, ...rest] = line.split(',');
    const brandMatch = rest.join(',').match(/"([^"]+)"/);
    const brand = brandMatch ? brandMatch[1] : '';
    const reportsMatch = line.match(/",(\d+),/);
    const total_reports = reportsMatch ? parseInt(reportsMatch[1], 10) : 0;
    return { slug, brand_name: brand, total_reports };
  });

  const legitimateGenerics = parsed.filter(d => {
    const lower = d.brand_name.toLowerCase();
    return REAL_GENERICS.some(g => lower === g || lower === g + ' sodium' || lower === g + ' hydrochloride');
  });

  if (legitimateGenerics.length === 0) {
    console.log('None found by exact match.\n');
  } else {
    console.log(`Found ${legitimateGenerics.length} entries:\n`);
    for (const d of legitimateGenerics.sort((a, b) => b.total_reports - a.total_reports)) {
      console.log(`  [${d.total_reports.toLocaleString().padStart(9)}]  ${d.slug.padEnd(40)} ${d.brand_name}`);
    }
  }

  console.log('\n── ADDITIONAL CANDIDATES (removed log entries containing generic names) ──\n');
  // Broader scan: removed entries whose brand_name CONTAINS a real generic as a word
  const broaderCandidates = parsed.filter(d => {
    const lower = d.brand_name.toLowerCase();
    const alreadyExact = legitimateGenerics.some(g => g.slug === d.slug);
    return !alreadyExact && REAL_GENERICS.some(g => {
      const words = lower.split(/[\s,/]+/);
      return words.includes(g) || words.includes(g.split(' ')[0]);
    });
  });

  // Dedupe and sort
  const seen = new Set();
  for (const d of broaderCandidates.sort((a, b) => b.total_reports - a.total_reports)) {
    if (!seen.has(d.slug)) {
      seen.add(d.slug);
      console.log(`  [${d.total_reports.toLocaleString().padStart(9)}]  ${d.slug.padEnd(40)} ${d.brand_name}`);
    }
  }

})();
