/**
 * generate-tweet-queue.js — Build scripts/tweet-queue.txt with 50 pre-formatted tweets.
 * Usage: node scripts/generate-tweet-queue.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SLUGS = [
  'humira', 'enbrel', 'dupixent', 'revlimid', 'prednisone',
  'neurontin', 'metformin', 'lisinopril', 'gabapentin', 'synthroid',
  'lyrica', 'metoprolol', 'lipitor', 'remicade', 'xanax',
  'simvastatin', 'crestor', 'plavix', 'nexium', 'seroquel',
  'lantus', 'otezla', 'cymbalta', 'effexor', 'lexapro',
  'risperdal', 'abilify', 'prilosec', 'zoloft', 'keytruda',
  'stelara', 'wellbutrin', 'mounjaro', 'trulicity', 'ambien',
  'eliquis', 'jardiance', 'ozempic', 'prozac', 'farxiga',
  'coumadin', 'victoza', 'adderall', 'vyvanse', 'brilinta',
  'invokana', 'concerta', 'wegovy', 'strattera', 'losartan-potassium',
];

function toTitleCase(str) {
  return str.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function toHashtag(name) {
  return '#' + name.replace(/[^a-zA-Z0-9]/g, '').replace(/^[0-9]+/, '');
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function buildTweet(drug, events, femalePct, { includeDemographic, eventCount }) {
  const brand   = toTitleCase(drug.brand_name);
  const generic = drug.generic_name ? ` (${toTitleCase(drug.generic_name)})` : '';
  const total   = fmt(drug.total_reports);
  const hashtag = toHashtag(brand);
  const url     = `pillsignal.com/drugs/${drug.slug}`;

  const topEvents = events.slice(0, eventCount);
  const eventLines = topEvents
    .map(e => `- ${toTitleCase(e.event_name)} (${fmt(e.count)})`)
    .join('\n');

  const demoLine = (includeDemographic && femalePct !== null)
    ? `\n${femalePct}% of reports came from women.`
    : '';

  return (
    `${brand}${generic} has had ${total} adverse event reports submitted to the FDA.\n\n` +
    `Most commonly reported:\n${eventLines}${demoLine}\n\n` +
    `Full data → ${url}\n\n` +
    `${hashtag} #FDA #SideEffects`
  );
}

function fitTweet(drug, events, femalePct) {
  const LIMIT = 280;

  let t = buildTweet(drug, events, femalePct, { includeDemographic: true, eventCount: 3 });
  if (t.length <= LIMIT) return t;

  t = buildTweet(drug, events, femalePct, { includeDemographic: false, eventCount: 3 });
  if (t.length <= LIMIT) return t;

  t = buildTweet(drug, events, femalePct, { includeDemographic: false, eventCount: 2 });
  if (t.length <= LIMIT) return t;

  return buildTweet(drug, events, femalePct, { includeDemographic: false, eventCount: 1 });
}

async function main() {
  const { data: drugs, error } = await supabase
    .from('drugs')
    .select('id, slug, brand_name, generic_name, total_reports')
    .in('slug', SLUGS);

  if (error) throw new Error(error.message);

  // Preserve SLUGS order
  const bySlug = Object.fromEntries(drugs.map(d => [d.slug, d]));
  const orderedDrugs = SLUGS.map(s => bySlug[s]).filter(Boolean);

  const tweets = [];

  for (const drug of orderedDrugs) {
    const [eventsRes, demoRes] = await Promise.all([
      supabase
        .from('adverse_events')
        .select('event_name, count')
        .eq('drug_id', drug.id)
        .order('count', { ascending: false })
        .limit(3),
      supabase
        .from('demographics')
        .select('value, count')
        .eq('drug_id', drug.id)
        .eq('dimension', 'sex'),
    ]);

    const events = eventsRes.data ?? [];
    const sexRows = demoRes.data ?? [];

    let femalePct = null;
    const f = sexRows.find(r => r.value?.toLowerCase() === 'female');
    const m = sexRows.find(r => r.value?.toLowerCase() === 'male');
    if (f && m) {
      const total = f.count + m.count;
      if (total > 0) femalePct = Math.round((f.count / total) * 100);
    }

    const tweet = fitTweet(drug, events, femalePct);
    tweets.push(tweet);

    process.stdout.write(`  [${tweets.length.toString().padStart(2)}/${SLUGS.length}] ${drug.brand_name}\n`);
  }

  const output = tweets.join('\n' + '-'.repeat(10) + '\n');
  const outPath = join(__dirname, 'tweet-queue.txt');
  writeFileSync(outPath, output, 'utf8');

  console.log(`\nWrote ${tweets.length} tweets → ${outPath}`);
  console.log(`Max tweet length: ${Math.max(...tweets.map(t => t.length))} chars`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
