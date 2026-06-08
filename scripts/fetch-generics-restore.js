/**
 * fetch-generics-restore.js
 * Temporarily replaces drug-list.json with just the 13 canonical generics,
 * runs fetch-data.js to populate/restore Supabase entries, then restores the list.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIST_PATH  = join(__dirname, 'drug-list.json');
const BACKUP_PATH = join(__dirname, '_drug-list-backup.json');

const TO_FETCH = [
  { brand_name: 'IBUPROFEN',      generic_name: 'ibuprofen',      slug: 'ibuprofen'      },
  { brand_name: 'ACETAMINOPHEN',  generic_name: 'acetaminophen',  slug: 'acetaminophen'  },
  { brand_name: 'ASPIRIN',        generic_name: 'aspirin',        slug: 'aspirin'        },
  { brand_name: 'NAPROXEN',       generic_name: 'naproxen',       slug: 'naproxen'       },
  { brand_name: 'OMEPRAZOLE',     generic_name: 'omeprazole',     slug: 'omeprazole'     },
  { brand_name: 'FAMOTIDINE',     generic_name: 'famotidine',     slug: 'famotidine'     },
  { brand_name: 'DIPHENHYDRAMINE',generic_name: 'diphenhydramine',slug: 'diphenhydramine'},
  { brand_name: 'CETIRIZINE',     generic_name: 'cetirizine',     slug: 'cetirizine'     },
  { brand_name: 'LORATADINE',     generic_name: 'loratadine',     slug: 'loratadine'     },
  { brand_name: 'RANITIDINE',     generic_name: 'ranitidine',     slug: 'ranitidine'     },
  { brand_name: 'FOLIC ACID',     generic_name: 'folic acid',     slug: 'folic-acid'     },
  { brand_name: 'ROGAINE',        generic_name: 'minoxidil',      slug: 'rogaine'        },
];

const original = readFileSync(LIST_PATH, 'utf8');
writeFileSync(BACKUP_PATH, original, 'utf8');
writeFileSync(LIST_PATH, JSON.stringify(TO_FETCH, null, 2), 'utf8');
console.log(`\nFetching ${TO_FETCH.length} generics...\n`);

try {
  execSync('node scripts/fetch-data.js', {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
  });
} finally {
  writeFileSync(LIST_PATH, original, 'utf8');
  console.log('\nRestored drug-list.json');
}
