/**
 * cleanup-clones.js
 * Removes duplicate/junk drug entries from Supabase and docs/drugs/.
 * Run once; idempotent (silent no-ops for already-absent slugs).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { rmSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DRUGS = join(__dirname, '..', 'docs', 'drugs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Remove list ──────────────────────────────────────────────────────────────
// Organized by cluster for auditability. Comments mark decision reason.

const REMOVE = new Set([

  // ── IBUPROFEN cluster: store labels + generic-fallback clones ──────────────
  // Keep: ibuprofen (restored), advil, advil-liqui-gels, advil-migraine,
  //       motrin-ib, motrin-ib-migraine, motrin-infants
  'amazon-basic-care-ibuprofen','assured-ibuprofen','basic-care-ibuprofen',
  'betr-remedies-ibuprofen','care-one-ibuprofen','careall-ibuprofen',
  'careone-ibuprofen','circle-k-ibuprofen','counteract-ib',
  'direct-safety-ibuprofen','dolex-children','dolex-flex','dover-addaprin',
  'dg-health-ibuprofen','dye-free-ibuprofen','dye-free-ibuprofen-200',
  'equaline-ibuprofen','equate-ibuprofen','cvs-ibuprofen',
  'flex-prin','foster-and-thrive-ibuprofen',
  'good-neighbor-pharmacy-ibuprofen','good-sense-ibuprofen',
  'henry-schein-ibuprofen','ibupak','ibuprofen-ca','ibuprofen-caseys-50ct',
  'ibuprofen-circle-k-50ct','ibuprofen-dye-free','ibuprofen-ib',
  'ibuprofen-lil-drug-store','ibuprofen-migraine','ibuprofen-minis',
  'ibuprofen-thompson','ibuwin-forte','kirkland-signature-ibuprofen',
  'kirkland-signature-ibuprofen-ib','kosher-meds','leader-ibuprofen',
  'lil-drug-store-ibuprofen','medique-at-home-iprin','medique-iprin',
  'medi-first-ibuprofen','medi-first-plus-ibuprofen',
  'motrin-ib-cvp-health','motrin-ib-travel-basix',
  'profen-ib','rexall-ibuprofen','signature-care-ibuprofen',
  'topcare-ibuprofen','uline-ibuprofen','unishield-ibuprofen',
  'up-and-up-ibuprofen','valumeds-ibuprofen','xpect-ibuprofen',

  // ── ACETAMINOPHEN cluster: store labels + generic-fallback clones ──────────
  // Keep: acetaminophen (restored), tylenol-extra-strength, tylenol-extra-strength-caplet,
  //       tylenol-8-hr-arthritis-pain, mapap
  'acetaminophen-gelcaps','acetaminophen-red',
  'amazon-basic-care-acetaminophen','amazon-basics-acetaminophen',
  'aphen','atamel-forte','basic-care-acetaminophen',
  'berkley-and-jensen-acetaminophen','careall-acetaminophen',
  'careone-acetaminophen','cetafen','cetafen-extra',
  'crocin-max','cvs-acetaminophen','direct-safety-aspirin-free',
  'dover-aminofen','dover-aminophen','duralgina','easyfast','ed-apap',
  'equaline-acetaminophen','fast-acting-pedia-crae','gesteira','heb',
  'henry-schein-acetaminophen','leader-acetaminophen',
  'llorens-care-children-acetaminophen','major-acetaminophen',
  'mckesson-acetaminophen-325','medi-first-non-aspirin',
  'medique-apap','medique-at-home-apap','mejoralito',
  'mejoralito-children-children','members-mark-acetaminophen',
  'neo-lubrina','onessip-acetaminophen','puregen-labs-acetaminophen',
  'resfriol-ito-children','ringl','robitussin-direct-sore-throat-pain',
  'safetynadol','temp-x','temperal-ito','tylenol-8-hr-muscle-aches-and-pain',
  'tylenol-extra-strength-cvp-health','tylenol-extra-strength-travel-basix',
  'vitapirena','welby-acetaminophen','xpect-acetaminophen',

  // ── ASPIRIN cluster: store labels + generic-fallback clones ────────────────
  // Keep: aspirin (restored), bayer-aspirin-regimen-enteric-coated,
  //       bayer-aspirin-regimen-chewable-low-dose-aspirin-orange,
  //       ecotrin, ecotrin-regular-strength, bufferin-regular-strength-pain-relief
  'aspi-cor','aspirin-50-ct','aspirin-enteric-safety-coated','aspirin-nsaid',
  'aspirin-regimen','basic-care-aspirin','bayer-aspirin-original-cvp-health',
  'bayer-aspirin-original-travel-basix','careall-aspirin',
  'circle-k-aspirin-325','dg-health-aspirin','direct-safety-aspirin',
  'dye-free-aspirin-81','equate-aspirin','foster-and-thrive-aspirin',
  'geritrex-aspirin','good-neighbor-pharmacy-aspirin','good-sense-aspirin',
  'leader-aspirin','mckesson-aspirin','medi-first-aspirin',
  'medi-first-plus-aspirin','medique-at-home-aspirin','medique-products-aspirin',
  'meijer-low-dose-aspirin','physicians-care-aspirin','rapidol-aspirin',
  'rugby-aspirin','sunmark-aspirin','thompson-aspirin','topcare-aspirin',
  'travel-savvy-aspirin','uline-aspirin','unishield-aspirin','wispirin',
  'low-dose-aspiriun', // misspelling in FAERS

  // ── OMEPRAZOLE cluster ──────────────────────────────────────────────────────
  // Keep: omeprazole (restored), prilosec, prilosec-otc
  'amazon-basic-care-omeprazole','basic-care-omeprazole',
  'berkley-and-jensen-omeprazole','care-one-omeprazole',
  'careone-omeprazole','dg-health-omeprazole','dg-health-omperazole',
  'equaline-omeprazole','equate-omeprazole','exchange-select-omeprazole',
  'foster-and-thrive-omeprazole','good-neighbor-pharmacy-omeprazole',
  'good-now-omeprazole','good-sense-omeprazole',
  'kirkland-signature-omeprazole','leader-omeprazole',
  'members-mark-omeprazole','rugby-omeprazole',
  'signature-care-omeprazole','topcare-omeprazole',
  'topcare-omeprazole-delayed-release','up-and-up-omeprazole',

  // ── LANSOPRAZOLE cluster ────────────────────────────────────────────────────
  // Keep: lansoprazole, prevacid, prevacid-solutab, prevacid-24-hr
  'basic-care-lansoprazole','dg-health-lansoprazole',
  'equaline-lansoprazole','equate-lansoprazole',
  'equate-lansoprazole-delayed-release','good-neighbor-pharmacy-lansoprazole',
  'good-sense-lansoprazole','kirkland-signature-lansoprazole',
  'members-mark-lansoprazole','topcare-lansoprazole',
  'up-and-up-lansoprazole',

  // ── ESOMEPRAZOLE cluster ────────────────────────────────────────────────────
  // Keep: esomeprazole, esomeprazole-magnesium, nexium, nexium-24hr
  'basic-care-esomeprazole-magnesium','careone-esomeprazole-magnesium',
  'dg-health-esomeprazole-magnesium','equate-esomeprazole-magnesium',
  'exchange-select-esomeprazole-magnesium',
  'kirkland-signature-esomeprazole-magnesium',
  'leader-esomeprazole-magnesium','members-mark-esomeprazole-magnesium',
  'signature-care-esomeprazole-magnesium',

  // ── FAMOTIDINE cluster ──────────────────────────────────────────────────────
  // Keep: famotidine (restored), pepcid, pepcid-ac, pepcid-ac-original-strength,
  //       pepcid-ac-maximum-strength, zantac-360
  'berkley-and-jensen-famotidine','rugby-famotidine',
  'up-and-up-famotidine','zantac-360-cool-mint',

  // ── MINOXIDIL cluster ───────────────────────────────────────────────────────
  // Keep: minoxidil, rogaine (fetched)
  'aromatica-hair-champu','berkley-and-jensen-minoxidil',
  'bunee-hair-growth-serum','elevate-hair-growth-serum',
  'equate-hair-regrowth-treatment','hair-acondicionador',
  'hair-champu','hair-leave-in','hair-treatment',
  'hims-hair-regrowth-treatment','keeps-minoxidil-topical',
  'kirkland-signature-minoxidil','leader-minoxidil',
  'lilivera-hair-regrowth-kit','melao-hair-growth-mousse',
  'minoxidil-hair-growth-serum','olivita-minoxidil',
  'psalmonica-hair-growth-serum','regenpure-precision',
  'regoxidine-for-men','regoxidine-for-women',
  'solucion-capilar-crecepelo','soti-hair-growth-serum',
  'venanoci-minoxidil',

  // ── SALINE cluster — entire cluster (not drugs) ─────────────────────────────
  'ancient-secrets-breathe-again','aqua-marina','artificial-eyedrop',
  'base-laboratories-saline','burble','equate-sterile-saline-mist',
  'family-care-saline','hydra-neb','hypertonic-saline',
  'licefreee','licefreee-everyday','nat-mur','nat-mur-6x','nasal-rines-salt',
  'nasocalm','natrium-muriaticum-6x','natrum-muriaticum','natrum-muriaticum-6x',
  'natural-liquidground-water-salt','natural-liquidmineral',
  'natural-liquidmineralspray','normal-salt','ohtrust-artifical-eyedrop',
  'oimmal-gentle-eye-wash','quality-choice-saline','resp-ease',
  'rhinomel-manuka','saline-cleaning','sinucleanse-nasal-drip',
  'sinucleanse-sterile-saline-mist','sodium-chloride-hypertonicity-ophthalmic',
  'sterile-saline-mist-meijer','sterile-saline-mist-walgreens',
  'worafy-gentle-eye-wash',

  // ── OXYGEN cluster — entire cluster (not a drug) ───────────────────────────
  'medical-gasseous-oxygen-cylinders','medical-oxygen-compressed',
  'oxygen-64889-0001','oxygen-size-400','oxygen-size-b','oxygen-size-c',
  'oxygen-size-d','oxygen-size-e','oxygen-size-f','oxygen-size-h',
  'oxygen-size-m','oxygen-size-t',

  // ── HOMEOPATHIC potassium / salt clusters ───────────────────────────────────
  'kali-muriaticum','kali-muriaticum-kit-refill','kalium-muriaticum-6x',
  'pokonza','pokonza-potassium-chloride','sore-throat-911',

  // ── FOLATE / MULTIVITAMIN clone clusters ───────────────────────────────────
  // (all pulling folic-acid generic data; folic-acid restored as canonical)
  'aflora','davimet','davimet-m','dexatran','folartex','folaten',
  'folcyteine','folyra','folixia','inflamex','liquical-plus','lunavira',
  'lumavex','multitam','multivitamin','nutralyn','prenatol-m',
  'quiofic','ventrixyl','vitranol','vitramyn','vitrexate',

  // ── CALCIUM CARBONATE / ANTACID cluster ────────────────────────────────────
  // Keep: calcium-carbonate, tums, tums-ex, alka-seltzer brand entries
  //       (alka-seltzer-heartburn-reliefchews 45861, alka-seltzer-heartburn-relief-peppermint 45833,
  //        alka-seltzer-cool-action-extra-strength-reliefchews-mint 45826)
  'alka-seltzer-cool-action-heartburn-relief-mint',
  'alka-seltzer-extra-strength-heartburn-reliefchews',
  'alka-seltzer-heartburn-reliefchews-strawberry-and-orange',
  'alka-seltzer-ultra-strength-heartburn-reliefchews',
  'belmora-melox-agrura','best-choice-assorted-fruit',
  'chooz','d-cal-kids','ki-no-sin','marc-glassman-ultra-strength',
  'medique-alcalak','na-mi-cal',

  // ── TUMS flavor variants (same data as tums canonical) ──────────────────────
  'tums-chewy-bites-peppermint','tums-chewy-bites-raspberry-lemonade',
  'tums-chewy-bites-vanilla-and-mint',

  // ── MELOXICAM obscure brands (keep: mobic, meloxicam) ──────────────────────
  'qamzova','xifyrm','zybic',

  // ── GABAPENTIN obscure brands (keep: gabapentin, neurontin) ────────────────
  'gaba-300-ezs','relgaabi',

  // ── CELECOXIB obscure brands (keep: celecoxib, celebrex, elyxyb-celecoxib) ─
  'vyscoxa',

  // ── ALEVE: packaging/subtitle variants with same data ──────────────────────
  // Keep: aleve, aleve-back-and-muscle-pain, aleve-caplets, naproxen (restored)
  'aleve-caplets-easy-open-arthritis-cap','aleve-easy-open-arthritis',
  'aleve-headache-pain',

  // ── FENTANYL delivery system variant ───────────────────────────────────────
  'fentanyl-system',

  // ── FLONASE marketing-subtitle variants ────────────────────────────────────
  'flonase-allergy-relief','flonase-headache-and-allergy-relief',

  // ── ABREVA marketing subtitle (clean abreva page exists) ───────────────────
  'abreva-rapid-pain-relief',

  // ── SALT-SUFFIX duplicates (clean INN kept) ─────────────────────────────────
  'citalopram-hydrobromide','duloxetine-hydrochloride',
  'escitalopram-oxalate','venlafaxine-hydrochloride',

  // ── NICORETTE flavor clone (same data as nicorette) ────────────────────────
  'nicorette-cherry-peppermint',

  // ── STANDALONE NON-DRUG / RETAILER NAMES ────────────────────────────────────
  'walgreens',    // FAERS entry where "WALGREENS" is the drug name
  'assured',      // Dollar Tree store brand with no drug identity
  'cvs-naturals', // CVS supplement house brand

  // ── HOMEOPATHIC junk 2-member clusters ──────────────────────────────────────
  'bye-zero','detox-toc-toc',        // generic supplement fallback
  'ferrum-metallicum-6x','real-summer', // homeopathic iron
  'ferrum-sulphuricum',              // homeopathic iron (keep ferrous-sulfate)

]);

// ─── KEEP guard (should never appear in REMOVE) ───────────────────────────────
const MUST_KEEP = new Set([
  'advil','advil-liqui-gels','advil-migraine',
  'motrin-ib','motrin-ib-migraine','motrin-infants',
  'tylenol','tylenol-extra-strength','tylenol-extra-strength-caplet',
  'tylenol-8-hr-arthritis-pain',
  'bayer-aspirin-regimen-enteric-coated',
  'bayer-aspirin-regimen-chewable-low-dose-aspirin-orange',
  'ecotrin','ecotrin-regular-strength',
  'bufferin-regular-strength-pain-relief',
  'prilosec','prilosec-otc',
  'nexium','nexium-24hr',
  'prevacid','prevacid-solutab','prevacid-24-hr',
  'pepcid','pepcid-ac','pepcid-ac-original-strength','pepcid-ac-maximum-strength',
  'zantac-360',
  'minoxidil','rogaine',
  'calcium-carbonate','tums','tums-ex',
  'alka-seltzer-heartburn-reliefchews',
  'alka-seltzer-heartburn-relief-peppermint',
  'alka-seltzer-cool-action-extra-strength-reliefchews-mint',
  'mobic','meloxicam','celebrex','celecoxib','elyxyb-celecoxib',
  'neurontin','gabapentin',
  'duragesic','fentanyl',
  'aleve','aleve-back-and-muscle-pain','aleve-caplets',
  'naproxen',
  'flonase','abreva',
  'nicorette','nicorette-mint','nicorette-original','nicorette-peppermint',
  'nicorette-cinnamon-surge',
  'zyrtec','claritin','benadryl',
  // generics being restored
  'ibuprofen','acetaminophen','aspirin','omeprazole','famotidine',
  'diphenhydramine','cetirizine','loratadine','ranitidine','folic-acid',
  // legitimate salt forms (different DB entries)
  'citalopram','escitalopram','venlafaxine','duloxetine',
  'ferrous-sulfate',
]);

// Safety check
for (const slug of MUST_KEEP) {
  if (REMOVE.has(slug)) {
    console.error(`SAFETY ERROR: "${slug}" is in both REMOVE and MUST_KEEP — aborting`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const slugsArr = [...REMOVE];
  console.log(`\nCleanup: removing ${slugsArr.length} slugs from Supabase + docs/drugs/\n`);

  // --- Delete from Supabase in batches of 200 ---
  let dbDeleted = 0;
  const BATCH = 200;
  for (let i = 0; i < slugsArr.length; i += BATCH) {
    const batch = slugsArr.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('drugs')
      .delete()
      .in('slug', batch)
      .select('slug');
    if (error) {
      console.error(`  DB error (batch ${i}): ${error.message}`);
    } else {
      dbDeleted += data.length;
    }
  }
  console.log(`  Supabase: deleted ${dbDeleted} drug rows (cascades to AEs, demographics, outcomes, trends)`);

  // --- Delete docs/drugs/{slug}/ directories ---
  let dirDeleted = 0;
  let dirMissing = 0;
  for (const slug of slugsArr) {
    const dirPath = join(DOCS_DRUGS, slug);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      dirDeleted++;
    } else {
      dirMissing++;
    }
  }
  console.log(`  Directories: deleted ${dirDeleted}, already absent ${dirMissing}`);

  // --- Verify MUST_KEEP pages still exist ---
  const survived = [];
  const missing  = [];
  for (const slug of MUST_KEEP) {
    const p = join(DOCS_DRUGS, slug);
    (existsSync(p) ? survived : missing).push(slug);
  }
  console.log(`\n  Keep-list check: ${survived.length} present, ${missing.length} missing from docs/drugs/`);
  if (missing.length) {
    console.log(`  Missing (will generate): ${missing.join(', ')}`);
  }

  console.log('\nCleanup complete.\n');
})();
