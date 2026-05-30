/**
 * tweet-daily.js — PillSignal daily drug tweet bot
 *
 * Picks a drug that hasn't been tweeted recently, formats a fact tweet,
 * posts it via X API v2, and logs the slug to scripts/tweeted-log.json.
 *
 * Usage:
 *   node scripts/tweet-daily.js            # post the tweet
 *   node scripts/tweet-daily.js --dry-run  # print tweet without posting
 *
 * Requires: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN,
 *           TWITTER_ACCESS_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient }              from '@supabase/supabase-js';
import { TwitterApi }                from 'twitter-api-v2';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }             from 'url';
import { dirname, join }             from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH  = join(__dirname, 'tweeted-log.json');

// ─── Environment ──────────────────────────────────────────────────────────────

const {
  TWITTER_API_KEY, TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing Supabase env vars.');
  process.exit(1);
}
if (!DRY_RUN && (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET)) {
  console.error('ERROR: Missing Twitter env vars. Use --dry-run to test without credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Tweeted log ──────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_PATH)) return [];
  try { return JSON.parse(readFileSync(LOG_PATH, 'utf8')); }
  catch { return []; }
}

function saveLog(entries) {
  writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// Return slugs tweeted within the last 90 days
function recentSlugs(log) {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return new Set(log.filter(e => new Date(e.tweeted_at).getTime() > cutoff).map(e => e.slug));
}

// ─── Drug selection ───────────────────────────────────────────────────────────

async function pickDrug(excludeSlugs) {
  // Fetch all drugs with decent report counts
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('drugs')
      .select('id, slug, brand_name, generic_name, total_reports')
      .gte('total_reports', 1000)
      .order('slug')
      .range(from, from + 999);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const candidates = all.filter(d => !excludeSlugs.has(d.slug));
  if (candidates.length === 0) {
    // All drugs have been tweeted recently — reset and pick any
    console.warn('All drugs tweeted recently; resetting exclusion list.');
    return all[Math.floor(Math.random() * all.length)];
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchDrugData(drugId) {
  const [eventsRes, demoRes] = await Promise.all([
    supabase
      .from('adverse_events')
      .select('event_name, count')
      .eq('drug_id', drugId)
      .order('count', { ascending: false })
      .limit(3),
    supabase
      .from('demographics')
      .select('value, count')
      .eq('drug_id', drugId)
      .eq('dimension', 'sex'),
  ]);

  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (demoRes.error)   throw new Error(demoRes.error.message);

  return { events: eventsRes.data, sexRows: demoRes.data };
}

// ─── Tweet formatting ─────────────────────────────────────────────────────────

function toHashtag(name) {
  return '#' + name.replace(/[^a-zA-Z0-9]/g, '').replace(/^[0-9]+/, '');
}

function toTitleCase(str) {
  return str.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function formatCount(n) {
  return Number(n).toLocaleString('en-US');
}

function buildTweet(drug, events, sexRows, { includeDemographic = true, eventCount = 3 } = {}) {
  const brand   = toTitleCase(drug.brand_name);
  const generic = drug.generic_name ? ` (${toTitleCase(drug.generic_name)})` : '';
  const total   = formatCount(drug.total_reports);
  const hashtag = toHashtag(brand);
  const url     = `pillsignal.com/drugs/${drug.slug}`;

  const topEvents = events.slice(0, eventCount);
  const eventLines = topEvents
    .map(e => `- ${toTitleCase(e.event_name)} (${formatCount(e.count)})`)
    .join('\n');

  let demoLine = '';
  if (includeDemographic && sexRows.length >= 2) {
    const femaleRow = sexRows.find(r => r.value?.toLowerCase() === 'female');
    const maleRow   = sexRows.find(r => r.value?.toLowerCase() === 'male');
    if (femaleRow && maleRow) {
      const totalSex = femaleRow.count + maleRow.count;
      if (totalSex > 0) {
        const femalePct = Math.round((femaleRow.count / totalSex) * 100);
        demoLine = `\n${femalePct}% of reports came from women.`;
      }
    }
  }

  const body =
    `${brand}${generic} has had ${total} adverse event reports submitted to the FDA.\n\n` +
    `Most commonly reported:\n${eventLines}${demoLine}\n\n` +
    `Full data → ${url}\n\n` +
    `${hashtag} #FDA #SideEffects`;

  return body;
}

function fitTweet(drug, events, sexRows) {
  const LIMIT = 280;

  // Try full version
  let tweet = buildTweet(drug, events, sexRows, { includeDemographic: true, eventCount: 3 });
  if (tweet.length <= LIMIT) return tweet;

  // Drop demographic line
  tweet = buildTweet(drug, events, sexRows, { includeDemographic: false, eventCount: 3 });
  if (tweet.length <= LIMIT) return tweet;

  // Shorten to top 2 events
  tweet = buildTweet(drug, events, sexRows, { includeDemographic: false, eventCount: 2 });
  if (tweet.length <= LIMIT) return tweet;

  // Last resort: top 1 event (edge case for very long names)
  return buildTweet(drug, events, sexRows, { includeDemographic: false, eventCount: 1 });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — Daily Tweet');
  if (DRY_RUN) console.log('Mode: dry-run (no tweet will be posted)\n');

  const log     = loadLog();
  const exclude = recentSlugs(log);
  console.log(`Tweeted-log entries : ${log.length} (${exclude.size} excluded as recently tweeted)`);

  const drug = await pickDrug(exclude);
  console.log(`Selected drug       : ${drug.brand_name} (${drug.slug})`);

  const { events, sexRows } = await fetchDrugData(drug.id);

  if (events.length === 0) {
    console.error('No adverse event data found for this drug. Aborting.');
    process.exit(1);
  }

  const tweet = fitTweet(drug, events, sexRows);

  console.log(`\nTweet (${tweet.length}/280 chars):\n`);
  console.log('─'.repeat(60));
  console.log(tweet);
  console.log('─'.repeat(60));

  if (DRY_RUN) {
    console.log('\nDry-run complete. No tweet posted.');
    return;
  }

  // Post via X API v2
  const client = new TwitterApi({
    appKey:       TWITTER_API_KEY,
    appSecret:    TWITTER_API_SECRET,
    accessToken:  TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_SECRET,
  });

  const { data } = await client.v2.tweet(tweet);
  console.log(`\nPosted! Tweet ID: ${data.id}`);
  console.log(`View: https://x.com/i/web/status/${data.id}`);

  // Update log
  log.push({ slug: drug.slug, brand_name: drug.brand_name, tweeted_at: new Date().toISOString() });
  saveLog(log);
  console.log(`Logged to tweeted-log.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
