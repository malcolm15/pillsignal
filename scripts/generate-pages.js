/**
 * generate-pages.js — PillSignal Stage 2
 *
 * Reads all drug data from Supabase and generates:
 *   docs/drugs/{slug}/index.html  — one page per drug (clean URL: /drugs/lexapro)
 *   docs/sitemap.xml              — all drug pages + homepage
 *   docs/robots.txt               — allows all crawlers, points to sitemap
 *
 * Usage:
 *   node scripts/generate-pages.js
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
 */

import 'dotenv/config';
import { createClient }                        from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath }                       from 'url';
import { dirname, join }                       from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DOCS_DIR  = join(ROOT, 'docs');
const SITE_URL  = 'https://pillsignal.com';

// ─── Environment ──────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Read template once at startup — fail early if it's missing
const TEMPLATE = readFileSync(join(ROOT, 'templates', 'drug-page.html'), 'utf8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Prevents </script> from breaking an inline <script> block
function safeJson(data) {
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}

const AGE_ORDER = ['0-17', '18-34', '35-49', '50-64', '65-74', '75+'];

function sortAgeGroups(rows) {
  return AGE_ORDER
    .map(label => rows.find(r => r.value === label))
    .filter(Boolean);
}

function computeDateRange(trends) {
  if (!trends.length) return null;
  const years = trends.map(t => t.year);
  const min   = Math.min(...years);
  const max   = Math.max(...years);
  return min === max ? String(min) : `${min}–${max}`; // en-dash
}

// Keep <title> under 60 chars. Try with generic name first, fall back without.
function buildPageTitle(brandName, genericName) {
  const full = `${brandName} (${genericName}) — Adverse Events | PillSignal`;
  if (full.length <= 60) return full;
  const short = `${brandName} — Adverse Events | PillSignal`;
  if (short.length <= 60) return short;
  return `${brandName} — Adverse Events`;
}

// Keep <meta description> under 160 chars.
function buildMetaDesc(brandName, genericName, totalReports) {
  const reports = totalReports.toLocaleString('en-US');
  const full  = `${brandName} (${genericName}): ${reports} adverse event reports submitted to the FDA.`;
  if (full.length <= 160) return full;
  const short = `${brandName}: ${reports} adverse event reports submitted to the FDA.`;
  return short.length <= 160 ? short : short.slice(0, 157) + '...';
}

// For each drug, find the 5 others whose top adverse events overlap most.
function computeRelatedDrugs(drugs, detailsMap) {
  const aeMap = {};
  for (const drug of drugs) {
    aeMap[drug.id] = new Set(
      (detailsMap[drug.id].adverseEvents || []).map(e => e.event_name.toLowerCase())
    );
  }

  const relatedMap = {};
  for (const drug of drugs) {
    const mine = aeMap[drug.id];
    const scores = [];
    for (const other of drugs) {
      if (other.id === drug.id) continue;
      let overlap = 0;
      for (const ev of mine) {
        if (aeMap[other.id].has(ev)) overlap++;
      }
      if (overlap > 0) scores.push({ drug: other, overlap });
    }
    scores.sort((a, b) => b.overlap - a.overlap);
    relatedMap[drug.id] = scores.slice(0, 5).map(s => s.drug);
  }
  return relatedMap;
}

// Renders the "Related Drugs" card HTML, or empty string if no related drugs.
function renderRelatedDrugsHtml(relatedDrugs) {
  if (!relatedDrugs || !relatedDrugs.length) return '';
  const items = relatedDrugs.map(d =>
    `    <li><a href="/drugs/${d.slug}">${escapeHtml(d.brand_name)}</a>` +
    `<span class="related-count">${d.total_reports.toLocaleString('en-US')} reports</span></li>`
  ).join('\n');
  return `<section class="card" aria-labelledby="related-heading">
  <h2 id="related-heading">Related Drugs</h2>
  <p class="section-note">Other medications with similar adverse event profiles in FDA FAERS reports.</p>
  <ul class="related-list">
${items}
  </ul>
</section>`;
}

function buildOpenFdaUrl(drug) {
  const term = encodeURIComponent(
    `patient.drug.openfda.brand_name.exact:"${drug.brand_name.toUpperCase()}"`
  );
  return `https://api.fda.gov/drug/event.json?search=${term}&limit=10`;
}

function buildJsonLd(drug, canonicalUrl, description) {
  return {
    '@context': 'https://schema.org',
    '@type':    'Dataset',
    name:        `${drug.brand_name} (${drug.generic_name}) — FDA Adverse Event Reports`,
    description,
    url:         canonicalUrl,
    creator: {
      '@type': 'Organization',
      name:    'PillSignal',
      url:     SITE_URL,
    },
    sourceOrganization: {
      '@type': 'Organization',
      name:    'U.S. Food and Drug Administration',
      url:     'https://www.fda.gov',
    },
    license: 'https://open.fda.gov/license/',
  };
}

// ─── Page renderer ────────────────────────────────────────────────────────────

function renderPage(drug, adverseEvents, demographics, outcomes, trends, relatedDrugs = []) {
  const { slug, brand_name: brandName, generic_name: genericName, total_reports: totalReports } = drug;
  const canonicalUrl  = `${SITE_URL}/drugs/${slug}`;
  const dateRange     = computeDateRange(trends) ?? 'data available';
  const generatedDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const pageTitle = buildPageTitle(brandName, genericName);
  const metaDesc  = buildMetaDesc(brandName, genericName, totalReports);

  // Build chart-ready data objects
  const aeData = adverseEvents
    .slice(0, 15)
    .map(e => ({ label: e.event_name, value: e.count }));

  const sexRows  = demographics.filter(d => d.dimension === 'sex').sort((a, b) => b.count - a.count);
  const ageRows  = sortAgeGroups(demographics.filter(d => d.dimension === 'age'));
  const outRows  = [...outcomes].sort((a, b) => b.count - a.count);
  const trendRows = [...trends].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.quarter - b.quarter
  );

  const sexData      = { labels: sexRows.map(d => d.value),      values: sexRows.map(d => d.count) };
  const ageData      = { labels: ageRows.map(d => d.value),      values: ageRows.map(d => d.count) };
  const outcomesData = { labels: outRows.map(o => o.outcome),    values: outRows.map(o => o.count) };
  const trendsData   = {
    labels: trendRows.map(t => `Q${t.quarter} ${t.year}`),
    values: trendRows.map(t => t.count),
  };

  return TEMPLATE
    .replaceAll('{{PAGE_TITLE}}',           escapeHtml(pageTitle))
    .replaceAll('{{META_DESCRIPTION}}',     escapeHtml(metaDesc))
    .replaceAll('{{CANONICAL_URL}}',        canonicalUrl)
    .replaceAll('{{OG_TITLE}}',             escapeHtml(pageTitle))
    .replaceAll('{{OG_DESCRIPTION}}',       escapeHtml(metaDesc))
    .replaceAll('{{OG_URL}}',               canonicalUrl)
    .replaceAll('{{JSON_LD}}',              safeJson(buildJsonLd(drug, canonicalUrl, metaDesc)))
    .replaceAll('{{BRAND_NAME}}',           escapeHtml(brandName))
    .replaceAll('{{GENERIC_NAME}}',         escapeHtml(genericName))
    .replaceAll('{{TOTAL_REPORTS}}',        totalReports.toLocaleString('en-US'))
    .replaceAll('{{DATE_RANGE}}',           escapeHtml(dateRange))
    .replaceAll('{{OPENFDA_URL}}',          buildOpenFdaUrl(drug))
    .replaceAll('{{GENERATED_DATE}}',       generatedDate)
    .replaceAll('{{ADVERSE_EVENTS_JSON}}',  safeJson(aeData))
    .replaceAll('{{SEX_DATA_JSON}}',        safeJson(sexData))
    .replaceAll('{{AGE_DATA_JSON}}',        safeJson(ageData))
    .replaceAll('{{OUTCOMES_JSON}}',        safeJson(outcomesData))
    .replaceAll('{{TRENDS_JSON}}',          safeJson(trendsData))
    .replaceAll('{{RELATED_DRUGS_HTML}}',   renderRelatedDrugsHtml(relatedDrugs));
}

// ─── File writers ─────────────────────────────────────────────────────────────

function writeDrugPage(slug, html) {
  const dir = join(DOCS_DIR, 'drugs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html, 'utf8');
}

function writeSitemap(drugs) {
  const today    = new Date().toISOString().split('T')[0];
  const drugUrls = drugs.map(d =>
    `  <url>\n    <loc>${SITE_URL}/drugs/${d.slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url>\n    <loc>${SITE_URL}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n` +
    drugUrls + `\n</urlset>`;

  writeFileSync(join(DOCS_DIR, 'sitemap.xml'), xml, 'utf8');
  console.log(`  sitemap.xml  — ${drugs.length} drug URLs + homepage`);
}

function writeRobotsTxt() {
  writeFileSync(
    join(DOCS_DIR, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
    'utf8'
  );
  console.log('  robots.txt   — written');
}

function writeDrugIndex(drugs) {
  mkdirSync(join(DOCS_DIR, 'js'), { recursive: true });
  const index = drugs.map(d => ({
    brand_name:   d.brand_name,
    generic_name: d.generic_name,
    slug:         d.slug,
  }));
  writeFileSync(join(DOCS_DIR, 'js', 'drug-index.json'), JSON.stringify(index), 'utf8');
  console.log(`  drug-index.json — ${index.length} drugs`);
}

// ─── Supabase queries ─────────────────────────────────────────────────────────

async function fetchAllDrugs() {
  const { data, error } = await supabase
    .from('drugs')
    .select('*')
    .order('brand_name');
  if (error) throw new Error(`Failed to fetch drugs: ${error.message}`);
  return data;
}

async function fetchDrugDetails(drugId) {
  const [aeRes, demoRes, outRes, trendRes] = await Promise.all([
    supabase.from('adverse_events').select('*').eq('drug_id', drugId).order('count', { ascending: false }),
    supabase.from('demographics').select('*').eq('drug_id', drugId),
    supabase.from('outcomes').select('*').eq('drug_id', drugId),
    supabase.from('trends').select('*').eq('drug_id', drugId).order('year').order('quarter'),
  ]);
  return {
    adverseEvents: aeRes.data  ?? [],
    demographics:  demoRes.data ?? [],
    outcomes:      outRes.data  ?? [],
    trends:        trendRes.data ?? [],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — Stage 2: Generate');

  const drugs = await fetchAllDrugs();
  console.log(`Drugs found: ${drugs.length}\n`);

  mkdirSync(join(DOCS_DIR, 'drugs'), { recursive: true });

  // Phase 1: load all drug details into memory
  console.log('Phase 1: Loading drug details...');
  const detailsMap = {};
  const drugsWithData = [];
  let skipped = 0;

  for (const drug of drugs) {
    const details = await fetchDrugDetails(drug.id);
    if (!drug.total_reports && !details.adverseEvents.length) {
      console.log(`  SKIP  ${drug.brand_name} — no data`);
      skipped++;
      continue;
    }
    detailsMap[drug.id] = details;
    drugsWithData.push(drug);
  }
  console.log(`  ${drugsWithData.length} drugs with data, ${skipped} skipped\n`);

  // Phase 2: compute related drugs via adverse event overlap
  console.log('Phase 2: Computing related drugs...');
  const relatedMap = computeRelatedDrugs(drugsWithData, detailsMap);
  console.log('  Done\n');

  // Phase 3: generate pages
  console.log('Phase 3: Generating pages...');
  let generated = 0;
  const generatedDrugs = [];

  for (const drug of drugsWithData) {
    const details = detailsMap[drug.id];
    const html = renderPage(
      drug,
      details.adverseEvents,
      details.demographics,
      details.outcomes,
      details.trends,
      relatedMap[drug.id] || []
    );

    writeDrugPage(drug.slug, html);
    generatedDrugs.push(drug);
    generated++;

    if (generated % 25 === 0) {
      console.log(`  ${generated}/${drugsWithData.length} pages written...`);
    }
  }

  console.log(`  ${generated}/${drugsWithData.length} pages written\n`);

  writeSitemap(generatedDrugs);
  writeRobotsTxt();
  writeDrugIndex(generatedDrugs);

  console.log(`\nStage 2 complete.`);
  console.log(`  Generated : ${generated} pages`);
  console.log(`  Skipped   : ${skipped} (no data)`);
  console.log(`  Output    : docs/drugs/{slug}/index.html\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
