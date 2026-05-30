/**
 * remove-drugs.js — PillSignal bulk drug removal
 *
 * Reads slugs from scripts/remove-slugs.txt, deletes each drug from Supabase
 * (cascades to adverse_events, demographics, outcomes, trends), and removes
 * its docs/drugs/{slug}/ directory.
 *
 * Usage:
 *   node scripts/remove-drugs.js
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, rmSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DRUGS_DIR = join(ROOT, 'docs', 'drugs');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  const slugsRaw = readFileSync(join(__dirname, 'remove-slugs.txt'), 'utf8');
  const slugs    = slugsRaw.split('\n').map(s => s.trim()).filter(Boolean);

  console.log(`\nPillSignal — Drug Removal`);
  console.log(`Slugs to remove: ${slugs.length}\n`);

  let dbRemoved  = 0;
  let dbMissed   = 0;
  let dirRemoved = 0;
  let errors     = 0;

  // Delete from Supabase in batches of 50 to avoid query size limits
  const BATCH = 50;
  for (let i = 0; i < slugs.length; i += BATCH) {
    const batch = slugs.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('drugs')
      .delete()
      .in('slug', batch)
      .select('slug');

    if (error) {
      console.error(`  [DB ERROR] batch ${Math.floor(i/BATCH)+1}: ${error.message}`);
      errors += batch.length;
    } else {
      dbRemoved += data.length;
      const missed = batch.length - data.length;
      if (missed > 0) dbMissed += missed;
    }

    if ((i / BATCH) % 5 === 0) {
      console.log(`  DB: ${Math.min(i + BATCH, slugs.length)}/${slugs.length} processed...`);
    }
  }

  // Remove static HTML directories
  for (const slug of slugs) {
    const dir = join(DRUGS_DIR, slug);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        dirRemoved++;
      } catch (err) {
        console.error(`  [DIR ERROR] ${slug}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\nRemoval complete.`);
  console.log(`  Removed from DB     : ${dbRemoved}`);
  console.log(`  Not found in DB     : ${dbMissed} (already absent)`);
  console.log(`  HTML dirs removed   : ${dirRemoved}`);
  console.log(`  Errors              : ${errors}`);
  console.log(`\nNext: node scripts/generate-pages.js`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
