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

function toTitleCase(str) {
  return str.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
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

const TITLE_MAX = 65;

function buildPageTitle(brandName) {
  const t1 = `${brandName} — Adverse Events | PillSignal`;
  if (t1.length <= TITLE_MAX) return t1;
  const t2 = `${brandName} — Adverse Events`;
  if (t2.length <= TITLE_MAX) return t2;
  const t3 = `${brandName} — FDA Reports`;
  if (t3.length <= TITLE_MAX) return t3;
  // Truncate brand name to fit "… — FDA Reports" within TITLE_MAX
  const suffix = '… — FDA Reports';
  return brandName.slice(0, TITLE_MAX - suffix.length) + suffix;
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

// Renders the FDA label description, or empty string if null/empty.
function renderDrugDescription(description) {
  if (!description) return '';
  return `<p class="drug-description"><strong>According to the FDA label:</strong> ${escapeHtml(description)}</p>`;
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

  const pageTitle = buildPageTitle(brandName);
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
    .replaceAll('{{DRUG_DESCRIPTION}}',      renderDrugDescription(drug.description))
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
  const today = new Date().toISOString().split('T')[0];

  const staticUrls = [
    { loc: `${SITE_URL}/`,         changefreq: 'weekly',  priority: '1.0' },
    { loc: `${SITE_URL}/drugs/`,   changefreq: 'weekly',  priority: '0.9' },
    { loc: `${SITE_URL}/about/`,   changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_URL}/faq/`,     changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_URL}/contact/`, changefreq: 'monthly', priority: '0.4' },
    { loc: `${SITE_URL}/privacy/`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${SITE_URL}/terms/`,   changefreq: 'monthly', priority: '0.3' },
  ].map(({ loc, changefreq, priority }) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
  ).join('\n');

  const drugUrls = drugs.map(d =>
    `  <url>\n    <loc>${SITE_URL}/drugs/${d.slug}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    staticUrls + '\n' + drugUrls + `\n</urlset>`;

  writeFileSync(join(DOCS_DIR, 'sitemap.xml'), xml, 'utf8');
  console.log(`  sitemap.xml  — ${drugs.length} drug URLs + 7 static pages`);
}

function writeBrowsePage(drugs) {
  // Group alphabetically; non-A-Z names go under '#'
  const groups = {};
  for (const drug of drugs) {
    const first  = drug.brand_name[0].toUpperCase();
    const bucket = /[A-Z]/.test(first) ? first : '#';
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(drug);
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const usedKeys = Object.keys(groups).sort();

  const letterNav = alphabet.map(l => {
    if (groups[l]) {
      return `<a href="#section-${l}" class="lnav-item lnav-item--on" onclick="if(typeof gtag==='function')gtag('event','browse_letter_click',{letter:'${l}'})">${l}</a>`;
    }
    return `<span class="lnav-item lnav-item--off">${l}</span>`;
  }).join('');

  const sections = usedKeys.map(letter => {
    const items = groups[letter].map(d => {
      const displayName = toTitleCase(d.brand_name);
      const generic = d.generic_name
        ? `<span class="browse-generic">${escapeHtml(d.generic_name)}</span>`
        : '';
      const count = d.total_reports
        ? `<span class="browse-count">${d.total_reports.toLocaleString('en-US')} reports</span>`
        : '';
      return `        <li class="browse-item">` +
        `<span class="browse-name-wrap"><a href="/drugs/${d.slug}/" class="browse-brand">${escapeHtml(displayName)}</a>${generic}</span>` +
        count + `</li>`;
    }).join('\n');

    const heading = letter === '#' ? 'Other' : letter;
    return `      <section id="section-${letter}" class="letter-section">` +
      `<h2 class="letter-heading">${heading}</h2>` +
      `<ul class="browse-list">\n${items}\n      </ul></section>`;
  }).join('\n\n');

  const total = drugs.length;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browse All Drugs — FDA Adverse Event Reports | PillSignal</title>
  <meta name="description" content="Browse all ${total.toLocaleString('en-US')} drugs tracked by PillSignal. Alphabetical directory of FDA adverse event report data for prescription medications.">
  <link rel="canonical" href="${SITE_URL}/drugs/">

  <!-- Favicon & PWA -->
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#00A67E">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="Browse All Drugs — FDA Adverse Event Reports | PillSignal">
  <meta property="og:description" content="Alphabetical directory of ${total.toLocaleString('en-US')} drugs tracked by PillSignal.">
  <meta property="og:url"         content="${SITE_URL}/drugs/">
  <meta property="og:site_name"   content="PillSignal">
  <meta property="og:image"       content="${SITE_URL}/og-image.png">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="Browse All Drugs — FDA Adverse Event Reports | PillSignal">
  <meta name="twitter:description" content="Alphabetical directory of ${total.toLocaleString('en-US')} drugs with FDA adverse event data.">
  <meta name="twitter:image"       content="${SITE_URL}/og-image.png">

  <style>
    :root, [data-theme="light"] {
      --c-bg: #ffffff; --c-surface: #f9fafb; --c-border: #e5e7eb;
      --c-text: #1a1a2e; --c-text-muted: #5a5a6e;
      --c-primary: #00A67E; --c-primary-hover: #008F6B; --c-primary-light: #E6F9F1;
      --c-banner-bg: #FFF9F0; --c-banner-text: #6B4E30;
      --c-banner-border: rgba(107,78,48,0.3); --c-banner-btn-hover: rgba(0,0,0,0.05);
      --font: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    [data-theme="dark"] {
      --c-bg: #0f172a; --c-surface: #1e293b; --c-border: #334155;
      --c-text: #f1f5f9; --c-text-muted: #94a3b8;
      --c-primary: #34D1A0; --c-primary-hover: #2BBD8E; --c-primary-light: #0D3D2E;
      --c-banner-bg: #1C1508; --c-banner-text: #D4B896;
      --c-banner-border: rgba(212,184,150,0.25); --c-banner-btn-hover: rgba(255,255,255,0.06);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); font-size: 1rem; line-height: 1.6; color: var(--c-text); background: var(--c-bg); transition: background 0.2s, color 0.2s; }
    a { color: var(--c-primary); text-decoration: none; }
    a:hover { text-decoration: underline; color: var(--c-primary-hover); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: var(--c-surface); } ::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

    /* Banner */
    #disclaimer-banner { background: var(--c-banner-bg); color: var(--c-banner-text); font-size: 0.875rem; line-height: 1.5; }
    .banner-seen #disclaimer-banner { display: none; }
    .banner-inner { max-width: 900px; margin: 0 auto; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .banner-inner p { flex: 1; min-width: 200px; }
    #banner-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--c-banner-border); color: var(--c-banner-text); padding: 0.3rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-family: var(--font); white-space: nowrap; transition: background 0.15s; }
    #banner-btn:hover { background: var(--c-banner-btn-hover); }

    /* Header */
    .site-header { border-bottom: 1px solid var(--c-border); padding: 0.875rem 1rem; background: var(--c-bg); }
    .site-header .inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 1.1rem; font-weight: 700; color: var(--c-primary); letter-spacing: -0.02em; }
    .logo:hover { text-decoration: none; color: var(--c-primary-hover); }
    .header-actions { display: flex; align-items: center; gap: 0.75rem; }
    .header-link { font-size: 0.875rem; color: var(--c-text-muted); }
    .theme-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: none; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; color: var(--c-text-muted); padding: 0; flex-shrink: 0; transition: color 0.15s, border-color 0.15s, background 0.15s; }
    .theme-toggle:hover { color: var(--c-primary); border-color: var(--c-primary); background: var(--c-primary-light); }
    [data-theme="light"] .icon-sun { display: none; }
    [data-theme="dark"]  .icon-moon { display: none; }

    /* Page header */
    .page-header { padding: 2rem 1rem 1.5rem; max-width: 900px; margin: 0 auto; }
    .page-header h1 { font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 800; letter-spacing: -0.03em; margin-bottom: 0.3rem; }
    .page-header p { color: var(--c-text-muted); font-size: 0.95rem; }

    /* Letter nav */
    .lnav { position: sticky; top: 0; z-index: 10; background: var(--c-bg); border-bottom: 1px solid var(--c-border); padding: 0.5rem 1rem; display: flex; flex-wrap: wrap; gap: 2px; max-width: 100%; }
    .lnav-inner { max-width: 900px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
    .lnav-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; font-size: 0.8rem; font-weight: 600; border-radius: 4px; }
    .lnav-item--on { color: var(--c-primary); } .lnav-item--on:hover { background: var(--c-primary-light); text-decoration: none; }
    .lnav-item--off { color: var(--c-border); cursor: default; }

    /* Browse list */
    main { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .letter-section { margin-bottom: 2rem; }
    .letter-heading { font-size: 1.5rem; font-weight: 800; color: var(--c-primary); letter-spacing: -0.02em; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 2px solid var(--c-primary-light); }
    .browse-list { list-style: none; }
    .browse-item { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding: 0.35rem 0; border-bottom: 1px solid var(--c-border); min-width: 0; }
    .browse-item:last-child { border-bottom: none; }
    .browse-name-wrap { display: flex; align-items: baseline; gap: 0.4rem; flex: 1; min-width: 0; flex-wrap: wrap; }
    .browse-brand { font-weight: 600; font-size: 0.95rem; overflow-wrap: break-word; word-break: break-word; min-width: 0; }
    .browse-generic { font-size: 0.8rem; color: var(--c-text-muted); min-width: 0; overflow-wrap: break-word; }
    .browse-count { font-size: 0.75rem; color: var(--c-text-muted); white-space: nowrap; flex-shrink: 0; }
    @media (max-width: 480px) {
      .browse-item { flex-direction: column; align-items: flex-start; gap: 0.1rem; }
      .browse-count { font-size: 0.7rem; margin-top: 0.05rem; }
    }

    /* Footer */
    .site-footer { border-top: 1px solid var(--c-border); padding: 1.5rem 1rem; text-align: center; font-size: 0.8rem; color: var(--c-text-muted); background: var(--c-bg); }
    .site-footer a { color: var(--c-text-muted); }
    .site-footer a:hover { color: var(--c-primary); text-decoration: none; }
    .footer-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem; }
  </style>

  <script>
    (function () {
      var saved = localStorage.getItem('pillsignal_theme');
      var dark  = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', saved || (dark ? 'dark' : 'light'));
      if (localStorage.getItem('pillsignal_disclaimer_dismissed')) {
        document.documentElement.classList.add('banner-seen');
      }
    }());
  </script>

  <!-- Google Analytics 4 -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-C5ZEDB8Z5P"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-C5ZEDB8Z5P');
  </script>
</head>
<body>

  <div id="disclaimer-banner" role="note" aria-label="Site disclaimer">
    <div class="banner-inner">
      <p>PillSignal presents data from the FDA's voluntary reporting system. This data does not prove that a medication caused any adverse event. Always consult your healthcare provider about your medications.</p>
      <button id="banner-btn" type="button">I understand</button>
    </div>
  </div>

  <header class="site-header">
    <div class="inner">
      <a href="/" class="logo">PillSignal</a>
      <div class="header-actions">
        <button id="theme-toggle" class="theme-toggle" aria-label="Toggle dark mode" title="Toggle dark mode">
          <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
            <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
          </svg>
          <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </button>
        <a href="/" class="header-link">← Search drugs</a>
      </div>
    </div>
  </header>

  <div class="page-header">
    <h1>Browse All Drugs</h1>
    <p>${total.toLocaleString('en-US')} medications with FDA adverse event data &mdash; page generated ${today}</p>
  </div>

  <nav class="lnav" aria-label="Jump to letter">
    <div class="lnav-inner">${letterNav}</div>
  </nav>

  <main>
${sections}
  </main>

  <footer class="site-footer">
    <p>Data sourced from <a href="https://open.fda.gov/" target="_blank" rel="noopener noreferrer">OpenFDA</a>. PillSignal is not affiliated with the FDA.</p>
    <nav class="footer-nav" aria-label="Site links">
      <a href="/about">About</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/contact">Contact</a>
    </nav>
  </footer>

  <script>
    document.getElementById('banner-btn').addEventListener('click', function () {
      localStorage.setItem('pillsignal_disclaimer_dismissed', '1');
      document.documentElement.classList.add('banner-seen');
    });
    (function () {
      document.getElementById('theme-toggle').addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('pillsignal_theme', next);
        if (typeof gtag === 'function') gtag('event', 'dark_mode_toggle', { new_theme: next });
      });
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
          if (!localStorage.getItem('pillsignal_theme')) {
            document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
          }
        });
      }
    }());
  </script>

</body>
</html>`;

  writeFileSync(join(DOCS_DIR, 'drugs', 'index.html'), html, 'utf8');
  console.log(`  drugs/index.html — ${total} drugs across ${usedKeys.length} letter sections`);
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
  const all   = [];
  const batch = 1000;
  let   from  = 0;

  while (true) {
    const { data, error } = await supabase
      .from('drugs')
      .select('*')
      .order('brand_name')
      .range(from, from + batch - 1);
    if (error) throw new Error(`Failed to fetch drugs: ${error.message}`);
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
  }

  return all;
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

  writeBrowsePage(generatedDrugs);
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
