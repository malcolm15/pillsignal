/**
 * submit-indexnow.js — PillSignal IndexNow submission
 *
 * Reads all drug slugs from Supabase, builds the full URL list (drug pages +
 * static pages), and submits to the IndexNow API. IndexNow notifies Bing,
 * Yandex, and other participating search engines simultaneously.
 *
 * IndexNow accepts up to 10,000 URLs per batch. All 841 drug pages plus
 * static pages fit in a single request.
 *
 * Usage:
 *   node scripts/submit-indexnow.js          # submit all URLs
 *   node scripts/submit-indexnow.js --dry-run # print payload, don't send
 *
 * Requires: INDEXNOW_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ─── Environment ──────────────────────────────────────────────────────────────

const { INDEXNOW_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!INDEXNOW_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing environment variables. Check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SITE_URL    = 'https://pillsignal.com';
const INDEXNOW_EP = 'https://api.indexnow.org/IndexNow';
const BATCH_SIZE  = 10_000;

const STATIC_URLS = [
  `${SITE_URL}/`,
  `${SITE_URL}/drugs/`,
  `${SITE_URL}/about/`,
  `${SITE_URL}/faq/`,
  `${SITE_URL}/contact/`,
  `${SITE_URL}/privacy/`,
  `${SITE_URL}/terms/`,
];

// ─── CLI flag ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function fetchAllSlugs() {
  const all   = [];
  const batch = 1000;
  let   from  = 0;

  while (true) {
    const { data, error } = await supabase
      .from('drugs')
      .select('slug')
      .order('slug')
      .range(from, from + batch - 1);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    all.push(...data.map(d => d.slug));
    if (data.length < batch) break;
    from += batch;
  }

  return all;
}

// ─── IndexNow ─────────────────────────────────────────────────────────────────

async function submitBatch(urls) {
  const payload = {
    host:        'pillsignal.com',
    key:         INDEXNOW_KEY,
    keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
    urlList:     urls,
  };

  if (DRY_RUN) {
    console.log('\n[dry-run] POST', INDEXNOW_EP);
    console.log(JSON.stringify(payload, null, 2));
    return { status: 'dry-run' };
  }

  const res = await fetch(INDEXNOW_EP, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body:    JSON.stringify(payload),
  });

  return { status: res.status, ok: res.ok, body: await res.text().catch(() => '') };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — IndexNow Submission');
  if (DRY_RUN) console.log('Mode: dry-run (no request will be sent)\n');

  const slugs    = await fetchAllSlugs();
  const drugUrls = slugs.map(s => `${SITE_URL}/drugs/${s}/`);
  const allUrls  = [...STATIC_URLS, ...drugUrls];

  console.log(`Static pages : ${STATIC_URLS.length}`);
  console.log(`Drug pages   : ${drugUrls.length}`);
  console.log(`Total URLs   : ${allUrls.length}`);

  // Split into batches (all URLs fit in one batch, but handles future growth)
  for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
    const batch     = allUrls.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const batchTotal = Math.ceil(allUrls.length / BATCH_SIZE);

    console.log(`\nSubmitting batch ${batchNum}/${batchTotal} (${batch.length} URLs)...`);
    const result = await submitBatch(batch);

    if (DRY_RUN) {
      console.log('Dry-run complete.');
    } else if (result.status === 200 || result.status === 202) {
      console.log(`  ✓ Accepted (HTTP ${result.status})`);
    } else if (result.status === 400) {
      console.error(`  ✗ Bad request (HTTP 400) — check key or URL format`);
      if (result.body) console.error('  ', result.body.slice(0, 200));
      process.exit(1);
    } else if (result.status === 403) {
      console.error(`  ✗ Forbidden (HTTP 403) — key verification failed`);
      console.error(`  Ensure https://pillsignal.com/${INDEXNOW_KEY}.txt exists and contains the key`);
      process.exit(1);
    } else if (result.status === 422) {
      console.error(`  ✗ Unprocessable (HTTP 422) — URLs may not match the declared host`);
      process.exit(1);
    } else if (result.status === 429) {
      console.error(`  ✗ Rate limited (HTTP 429) — wait before retrying`);
      process.exit(1);
    } else {
      console.warn(`  ? Unexpected response (HTTP ${result.status})`);
      if (result.body) console.warn('  ', result.body.slice(0, 200));
    }
  }

  if (!DRY_RUN) {
    console.log('\nSubmission complete. Bing and other IndexNow engines will crawl shortly.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
