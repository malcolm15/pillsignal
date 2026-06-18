/**
 * clean-generic-names.mjs: one-time / maintenance cleaner for drugs.generic_name.
 *
 * Re-cleans every stored generic_name with the canonical salt + form-word rules and
 * writes the result to BOTH Supabase and scripts/drug-list.json (the canonical source,
 * so a future fetch will not overwrite this work). Run after extending the strip lists
 * or after adding drugs:  node scripts/clean-generic-names.mjs
 *
 * It operates on the already-stored generic (does not re-infer from OpenFDA): the
 * generic-name population already inferred each drug's generic; this strips salt and
 * form/route suffixes that slipped through.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY in .env.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Counter-ion salts and hydrate-state words. The editorial standard is the bare
// ingredient, so these trailing tokens are stripped (escitalopram oxalate ->
// escitalopram, clopidogrel bisulfate -> clopidogrel).
const SALT = new Set([
  'OXALATE','BESYLATE','HYDROCHLORIDE','HCL','HYDROBROMIDE','HBR','MALEATE','MESYLATE',
  'TARTRATE','BITARTRATE','SUCCINATE','FUMARATE','HEMIFUMARATE','SODIUM','POTASSIUM',
  'CALCIUM','MAGNESIUM','ZINC','PHOSPHATE','SULFATE','SULPHATE','BISULFATE','ACETATE',
  'GLUCONATE','LACTATE','CITRATE','BROMIDE','CHLORIDE','NITRATE','BENZOATE','MALATE',
  'HYCLATE','DIMESYLATE','VALERATE','DECANOATE','PAMOATE','EMBONATE','PROPIONATE',
  'DIPROPIONATE','FUROATE','XINAFOATE','ENANTHATE','ANHYDROUS','DIHYDRATE','MONOHYDRATE',
]);

// Dosage-form and route words. Also stripped to leave the bare ingredient
// (metformin er -> metformin, estradiol transdermal -> estradiol).
const FORM = new Set([
  'EXTENDED','DELAYED','SUSTAINED','IMMEDIATE','CONTROLLED','PROLONGED','MODIFIED','RELEASE',
  'EXTENDED-RELEASE','DELAYED-RELEASE','ER','XR','SR','CR','IR','ODT',
  'TABLET','TABLETS','CAPSULE','CAPSULES','CAPLET','CAPLETS','ORAL','SOLUTION','SUSPENSION',
  'INHALATION','INJECTION','INJECTABLE','TRANSDERMAL','TOPICAL','VAGINAL','SUPPOSITORY',
  'CREAM','GEL','OINTMENT','SPRAY','DISPERSIBLE','CHEWABLE','SOLUBLE','FOR',
]);

// PRESERVE: trailing tokens that are part of the ingredient's IDENTITY and must NEVER
// be stripped, even if a future edit accidentally adds one of them to SALT or FORM.
// Checked before any stripping. These are: insulin analogs (glargine/lispro/aspart/
// detemir/human/isophane), acids (ascorbic/zoledronic/etc. ACID), biologic suffixes
// (alfa/beta-1a/pegol), prodrug esters that define the drug (cilexetil/medoxomil/
// etexilate/disoproxil/acetonide/mofetil), and compounds where the anion is the name
// (calcium CARBONATE, sodium OXYBATE, nicotine POLACRILEX, polyethylene GLYCOL,
// conjugated ESTROGENS, fish OIL, isosorbide MONONITRATE, vitamin C). Stripping any of
// these would collapse distinct drugs (e.g. all insulins into "insulin").
const PRESERVE = new Set([
  'GLARGINE','LISPRO','ASPART','DETEMIR','HUMAN','ISOPHANE',
  'ACID','ALFA','ALFA-2A','ALFA-2B','BETA-1A','BETA-1B','PEGOL',
  'CILEXETIL','MEDOXOMIL','ETEXILATE','DISOPROXIL','ACETONIDE','MOFETIL',
  'CARBONATE','OXYBATE','POLACRILEX','GLYCOL','ESTROGENS','OIL','MONONITRATE',
  'SALTS','ESTERS','C',
]);

const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function ingredientClean(part) {
  let s = String(part).toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(MG|MCG|UG|G|ML|IU|UNITS?|MEQ)\b/g, ' ')
    .replace(/\d+(\.\d+)?\s*%/g, ' ')
    .replace(/[.,;()]/g, ' ')
    .replace(/\b\d+(\.\d+)?\b/g, ' ')
    .replace(/\bAND\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  let t = s.split(' ').filter(Boolean);
  // Strip trailing salt/form tokens, but NEVER a PRESERVE (identity) token.
  while (t.length > 1 && (SALT.has(t[t.length - 1]) || FORM.has(t[t.length - 1])) && !PRESERVE.has(t[t.length - 1])) {
    t.pop();
  }
  return t.join(' ');
}

// Clean a stored generic (handles combinations joined with " + ") and lowercase it.
function cleanGeneric(stored) {
  if (!stored || !stored.trim()) return '';
  if (stored.includes('+')) {
    return stored.split('+').map(p => ingredientClean(p)).filter(Boolean).join(' + ').toLowerCase();
  }
  return ingredientClean(stored).toLowerCase();
}

async function main() {
  const all = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from('drugs').select('id,slug,brand_name,generic_name').range(from, from + 999);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const result = {}; // slug -> new generic
  const changes = [];
  for (const d of all) {
    let cleaned = cleanGeneric(d.generic_name);
    // Redundancy: if the cleaned generic equals the cleaned brand, drop it (no subtitle).
    if (cleaned && norm(cleaned) === norm(ingredientClean(d.brand_name).toLowerCase())) cleaned = '';
    result[d.slug] = cleaned;
    if ((d.generic_name || '') !== cleaned) changes.push({ slug: d.slug, before: d.generic_name || '', after: cleaned });
  }

  // Write Supabase (concurrency 20).
  let wrote = 0;
  const ids = all.map(d => ({ id: d.id, slug: d.slug }));
  for (let k = 0; k < ids.length; k += 20) {
    await Promise.all(ids.slice(k, k + 20).map(async e => {
      const { error } = await sb.from('drugs').update({ generic_name: result[e.slug] }).eq('id', e.id);
      if (error) console.log('  ERR', e.slug, error.message); else wrote++;
    }));
  }

  // Write drug-list.json (canonical source).
  const listPath = join(__dirname, 'drug-list.json');
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  for (const entry of list) if (entry.slug in result) entry.generic_name = result[entry.slug];
  writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');

  console.log(`Supabase rows updated: ${wrote} | generic_name values changed: ${changes.length}`);
  console.log('\nChanged values:');
  changes.forEach(c => console.log(`  ${c.slug.padEnd(26)} ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`));
}

main();
