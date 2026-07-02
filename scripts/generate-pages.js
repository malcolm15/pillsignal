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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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

// Read templates once at startup — fail early if missing
const TEMPLATE          = readFileSync(join(ROOT, 'templates', 'drug-page.html'), 'utf8');
const HOMEPAGE_TEMPLATE = readFileSync(join(ROOT, 'templates', 'homepage.html'),  'utf8');

// Glossary is the single source of truth for adverse event term definitions:
// scripts/glossary.json (authored) powers the /glossary/ page, docs/js/glossary.json
// (the client copy used for inline drug-page definitions), and term matching.
const GLOSSARY = JSON.parse(readFileSync(join(__dirname, 'glossary.json'), 'utf8'));
// Manually-ported FDA label descriptions, keyed by slug. Applied in renderPage as a
// fallback over the Supabase description so a value that the label lookup will not
// reproduce survives a future fetch-data.js run (which would otherwise wipe it). See
// CLAUDE.md "Description Overrides".
const DESCRIPTION_OVERRIDES = JSON.parse(readFileSync(join(__dirname, 'description-overrides.json'), 'utf8'));
// MedDRA key (ALL-CAPS) -> { key, display, definition } for matching adverse_events
// terms to their plain-language definitions at generate time. (Slug is computed at
// render time via slugifyName, which is defined later in this module.)
const GLOSSARY_BY_KEY = new Map(
  GLOSSARY.terms.map(t => [t.key.toUpperCase(), t])
);

// ─── Shared page chrome ───────────────────────────────────────────────────────
// Single source of truth for banner, site-header, and site-footer HTML.
// Injected via {{SITE_HEADER}} / {{SITE_FOOTER}} placeholders in every template
// and called directly in writeBrowsePage(). Change here → all pages update.

// ─── Shared design tokens (single source of truth) ─────────────────────────────
// Injected into every page's <style> via the {{BASE_CSS}} placeholder (templates)
// or ${BASE_CSS} (programmatic pages), so the palette and type scale are defined
// once. Keeps the all-inline-CSS model (no extra render-blocking request).
const BASE_CSS = `    :root, [data-theme="light"] {
      --c-bg: #ffffff; --c-surface: #f9fafb; --c-border: #e5e7eb;
      --c-text: #1a1a2e; --c-text-muted: #5a5a6e;
      --c-primary: #00A67E; --c-primary-hover: #008F6B; --c-primary-light: #E6F9F1;
      --c-notice-bg: #FFF9F0; --c-notice-border: #F0E6D4; --c-notice-text: #6B4E30; --c-notice-link: #008F6B;
      --c-banner-bg: #FFF9F0; --c-banner-text: #6B4E30; --c-banner-border: rgba(107,78,48,0.3); --c-banner-btn-hover: rgba(0,0,0,0.05);
      --c-chart-grid: #f3f4f6; --c-chart-label: #8a8a9a; --c-chart-tooltip-bg: #ffffff; --c-chart-tooltip-border: #e5e7eb; --c-chart-tooltip-title: #1a1a2e; --c-chart-tooltip-body: #5a5a6e;
      --c-input-bg: #ffffff; --c-input-border: #d1d5db; --c-input-focus: #00A67E; --c-result-hover: #F0FBF7;
      --font: "Source Sans 3", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-heading: "Fraunces", Georgia, serif;
      /* Type scale (single source; applied via font-size on existing selectors, no tag changes) */
      --fs-display-lg: clamp(2.25rem, 6vw, 3.25rem);
      --fs-display: clamp(1.9rem, 4.5vw, 2.5rem);
      --fs-stat: 1.5rem;
      --fs-h2: 1.375rem;
      --fs-h3: 1.125rem;
      --fs-body: 1rem;
      --fs-small: 0.875rem;
      --fs-caption: 0.75rem;
      /* Radius scale */
      --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px;
      /* Spacing scale (4px grid) */
      --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem; --space-5: 1.5rem; --space-6: 2rem; --space-7: 3rem;
    }
    [data-theme="dark"] {
      --c-bg: #0f172a; --c-surface: #1e293b; --c-border: #334155;
      --c-text: #f1f5f9; --c-text-muted: #94a3b8;
      --c-primary: #34D1A0; --c-primary-hover: #2BBD8E; --c-primary-light: #0D3D2E;
      --c-notice-bg: #1C1508; --c-notice-border: #3D3520; --c-notice-text: #D4B896; --c-notice-link: #34D1A0;
      --c-banner-bg: #1C1508; --c-banner-text: #D4B896; --c-banner-border: rgba(212,184,150,0.25); --c-banner-btn-hover: rgba(255,255,255,0.06);
      --c-chart-grid: #273344; --c-chart-label: #94a3b8; --c-chart-tooltip-bg: #1e293b; --c-chart-tooltip-border: #334155; --c-chart-tooltip-title: #f1f5f9; --c-chart-tooltip-body: #cbd5e1;
      --c-input-bg: #1e293b; --c-input-border: #475569; --c-input-focus: #34D1A0; --c-result-hover: #0D2A22;
    }
    /* Header nav: never wrap mid-phrase; short labels + comfortable tap targets on small screens */
    .site-header .header-link { white-space: nowrap; display: inline-flex; align-items: center; }
    .hl-short { display: none; }
    @media (max-width: 480px) {
      .site-header .header-actions { gap: var(--space-2); }
      .site-header .header-link { min-height: 44px; padding: 0 var(--space-1); }
      .site-header .theme-toggle { width: 44px; height: 44px; }
      .hl-full { display: none; }
      .hl-short { display: inline; }
    }
    /* Share row (shared by drug pages and guides) */
    .share-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.9rem; position: relative; flex-wrap: wrap; }
    .share-label { font-size: var(--fs-caption); color: var(--c-text-muted); font-weight: 500; margin-right: 0.1rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .share-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: var(--radius-sm); border: 1px solid var(--c-border); color: var(--c-text-muted); background: none; cursor: pointer; padding: 0; text-decoration: none; transition: color 0.15s, border-color 0.15s, background 0.15s; flex-shrink: 0; font-family: inherit; }
    .share-btn:hover, .share-btn.share-copied { color: var(--c-text); border-color: var(--c-text); background: var(--c-surface); text-decoration: none; }
    .share-copy-tip { font-size: var(--fs-caption); color: var(--c-primary); font-weight: 500; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .share-copy-tip.visible { opacity: 1; }
    @media (max-width: 480px) { .share-btn { width: 44px; height: 44px; } }`;

function renderHeader(page = 'default') {
  const navBrowse  = `<a href="/drugs/" class="header-link"><span class="hl-full">Browse all</span><span class="hl-short">Drugs</span></a>`;
  const navSymptom = `<a href="/events/" class="header-link"><span class="hl-full">By symptom</span><span class="hl-short">Symptoms</span></a>`;
  const navSearch  = `<a href="/" class="header-link" aria-label="Back to search"><span class="hl-full">← Search</span><span class="hl-short">←</span></a>`;

  // Never link to the page you are on. Browse surfaces show the sibling browse
  // surface + back-to-search; /drugs/ omits its own link, /events/ omits its own.
  const navLinks = page === 'drug'
    ? `${navBrowse}\n        ${navSymptom}\n        ${navSearch}`
    : page === 'browse'
    ? `${navSymptom}\n        ${navSearch}`
    : page === 'events'
    ? `${navBrowse}\n        ${navSearch}`
    : `${navBrowse}\n        ${navSymptom}`;

  return `  <div id="disclaimer-banner" role="note" aria-label="Site disclaimer">
    <div class="banner-inner">
      <p>PillSignal presents data from the FDA's voluntary reporting system. This data does not prove that a medication caused any adverse event. Always consult your healthcare provider about your medications.</p>
      <button id="banner-btn" type="button">I understand</button>
    </div>
  </div>

  <header class="site-header">
    <div class="inner">
      <a href="/" class="logo" aria-label="PillSignal home" style="display:inline-flex;align-items:center;gap:0.5rem;flex-shrink:0;font-family:var(--font-heading);font-weight:600;font-size:1.25rem;letter-spacing:-0.01em;color:var(--c-text);text-decoration:none;">
        <svg width="40" height="22" viewBox="0 0 44 24" aria-hidden="true" focusable="false" style="display:block;flex-shrink:0;">
          <rect x="1.5" y="3.5" width="41" height="17" rx="8.5" style="fill:var(--c-primary);"/>
          <path d="M6 12 H16 L18 15 L21 5 L24 15 L26 12 H38" style="fill:none;stroke:var(--c-bg);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;"/>
        </svg>
        <span>PillSignal</span>
      </a>
      <div class="header-actions">
        ${navLinks}
        <button id="theme-toggle" class="theme-toggle" aria-label="Toggle dark mode" title="Toggle dark mode">
          <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <line x1="12" y1="2"     x2="12" y2="6"/>
            <line x1="12" y1="18"    x2="12" y2="22"/>
            <line x1="4.93" y1="4.93"   x2="7.76"  y2="7.76"/>
            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
            <line x1="2"  y1="12"    x2="6"  y2="12"/>
            <line x1="18" y1="12"    x2="22" y2="12"/>
            <line x1="4.93" y1="19.07"  x2="7.76"  y2="16.24"/>
            <line x1="16.24" y1="7.76"  x2="19.07" y2="4.93"/>
          </svg>
          <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </button>
      </div>
    </div>
  </header>`;
}

function renderFooter() {
  return `  <footer class="site-footer">
    <span style="font-family:var(--font-heading);font-weight:600;font-size:1.125rem;letter-spacing:-0.01em;color:var(--c-text);display:block;margin-bottom:0.75rem;">PillSignal</span>
    <p>Data sourced from the <a href="https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems" target="_blank" rel="noopener noreferrer">FDA's Adverse Event Monitoring System (AEMS)</a>, formerly FAERS, via OpenFDA. PillSignal is not affiliated with the FDA.</p>
    <nav class="footer-nav" aria-label="Site links">
      <a href="/guides/">Guides</a>
      <a href="/glossary/">Glossary</a>
      <a href="/events/">Browse by symptom</a>
      <a href="/about/">About</a>
      <a href="/faq/">FAQ</a>
      <a href="/privacy/">Privacy Policy</a>
      <a href="/terms/">Terms of Service</a>
      <a href="/contact/">Contact</a>
    </nav>
    <a href="https://x.com/PillSignal" class="footer-x-link" target="_blank" rel="noopener noreferrer" aria-label="PillSignal on X">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
    </a>
  </footer>`;
}

// ─── Fetch metadata ────────────────────────────────────────────────────────────
// Written by fetch-data.js on every run. Falls back to today if not yet created.
const METADATA_PATH = join(__dirname, 'fetch-metadata.json');
let DATA_LAST_UPDATED = 'Unknown';
let DATA_DATE_ISO = new Date().toISOString().slice(0, 10);
if (existsSync(METADATA_PATH)) {
  try {
    const meta = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
    if (meta.lastFetched) {
      const d = new Date(meta.lastFetched);
      DATA_LAST_UPDATED = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      DATA_DATE_ISO = d.toISOString().slice(0, 10);
    }
  } catch {}
}

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

// ─── Drug display names ─────────────────────────────────────────────────────────
// displayName() is the SINGLE SOURCE OF TRUTH for how a drug's brand name is shown
// anywhere on the site (search index, browse, drug-page H1/title, related drugs).
// Plain toTitleCase mangles dosage-form suffixes (XR -> Xr) and intentional internal
// capitals (NuvaRing -> Nuvaring), so this layers two allowlists on top of it. When a
// new drug needs special casing, extend the allowlists HERE, not at any call site.
//
// Rules, in order:
//   1. Whole-name override wins (e.g. "PARAGARD T 380A" -> "ParaGard T 380A").
//   2. A token matching an internal-cap override is replaced (NuvaRing, ProAir, ...),
//      regardless of how the source happens to be cased.
//   3. Names that already contain lowercase letters are trusted as intentionally cased.
//   4. Otherwise (all-caps source) each token is title-cased, except suffix tokens
//      which stay uppercase (XR, ER, HCL, ODT, ...).
const DISPLAY_SUFFIX_TOKENS = new Set([
  'XR', 'ER', 'SR', 'CR', 'DR', 'IR', 'XL', 'XT', 'MR', 'LA', 'CD',
  'HCL', 'HCT', 'ODT', 'DS', 'EC', 'PM', 'HFA', 'DPI', 'MDI', 'SL',
]);
const DISPLAY_TOKEN_OVERRIDES = {
  NUVARING: 'NuvaRing', PARAGARD: 'ParaGard', ANDROGEL: 'AndroGel',
  OXYCONTIN: 'OxyContin', DIABETA: 'DiaBeta', PROAIR: 'ProAir',
};
const DISPLAY_FULLNAME_OVERRIDES = {
  'PARAGARD T 380A': 'ParaGard T 380A',
};

function displayName(raw) {
  if (DISPLAY_FULLNAME_OVERRIDES[raw.toUpperCase()]) {
    return DISPLAY_FULLNAME_OVERRIDES[raw.toUpperCase()];
  }
  const isAllCaps = raw === raw.toUpperCase();
  return raw.split(/\s+/).map(tok => {
    const u = tok.toUpperCase();
    if (DISPLAY_TOKEN_OVERRIDES[u]) return DISPLAY_TOKEN_OVERRIDES[u];
    if (!isAllCaps) return tok;                       // trust already-cased names
    if (DISPLAY_SUFFIX_TOKENS.has(u)) return u;       // keep XR/ER/HCL/ODT uppercase
    return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
  }).join(' ');
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

const TITLE_MAX = 60;

// Brand-first title ladder. The brand name comes first and is NEVER truncated:
// the suffix is dropped progressively to fit TITLE_MAX, and for very long brand
// names we fall back to the brand alone rather than cutting the name. Pipe
// separator, no em-dash.
function buildPageTitle(brandName) {
  const t1 = `${brandName} Adverse Event Reports | PillSignal`;
  if (t1.length <= TITLE_MAX) return t1;
  const t2 = `${brandName} Reports | PillSignal`;
  if (t2.length <= TITLE_MAX) return t2;
  const t3 = `${brandName} | PillSignal`;
  if (t3.length <= TITLE_MAX) return t3;
  return brandName;
}

// Builds a unique, descriptive <meta description> targeting the 140-160 char
// sweet spot from each drug's own data: brand, generic (omitted cleanly when
// empty, no empty parens), total report count, and the single most frequently
// reported event. The top event is framed as co-occurrence ("most frequently
// reported"), never causation, and never ranked by danger. Hard cap 160: when
// brand plus generic runs long, the event clause is dropped first, then the
// generic, to stay in range. No em-dashes.
// Sensitive top events are omitted from the snippet (they read as alarming in
// search results and brush against the no-danger-framing guardrails). These drugs
// fall back to the clean no-event description.
const META_SENSITIVE_EVENTS = new Set([
  'DEATH', 'COMPLETED SUICIDE', 'SUICIDAL IDEATION', 'SUICIDE ATTEMPT', 'INTENTIONAL OVERDOSE',
]);

function buildMetaDesc(brandName, genericName, totalReports, topEvent) {
  const reports = totalReports.toLocaleString('en-US');
  const gen     = genericName ? ` (${genericName})` : '';
  const useEvent = topEvent && !META_SENSITIVE_EVENTS.has(String(topEvent).toUpperCase().trim());
  const evClause = useEvent
    ? ` The most frequently reported was ${String(topEvent).toLowerCase().trim()}.`
    : '';
  // Descriptive clause tiers, longest first. We insert the longest one that keeps
  // the whole string within 160. This adaptive fill avoids the old all-or-nothing
  // drop: a long generic plus a long event name (e.g. Mounjaro / "incorrect dose
  // administered") no longer falls all the way to a bare, too-short description.
  const CLAUSES = [
    ' for demographics, outcomes, and trends',  // A
    ' with demographics and outcomes',          // B
    ' with demographic data',                   // C
    '',                                          // none (last resort)
  ];
  const make = (g, clause, ev) =>
    `${brandName}${g}: explore ${reports} FDA adverse event reports${clause}.${ev}`;
  const bestFit = (g, ev) => {
    for (const cl of CLAUSES) { const s = make(g, cl, ev); if (s.length <= 160) return s; }
    return make(g, '', ev);
  };

  // Prefer generic + event (with the longest clause that fits); then drop the
  // event, then the generic, to stay within 160.
  const tries = [
    bestFit(gen, evClause),   // generic + best-fit clause + event
    bestFit(gen, ''),         // drop event, generic + best-fit clause
    bestFit('',  evClause),   // drop generic, brand + best-fit clause + event
    bestFit('',  ''),         // brand + best-fit clause
  ];
  const fit = tries.find(s => s.length <= 160);
  return fit || (`${brandName}: ${reports} adverse event reports submitted to the FDA.`).slice(0, 160);
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

// Generic share row: takes the raw share text, title, and canonical URL, so any
// page type (drug pages, guides) reuses the same component without a forked variant.
function renderShareButtons(shareText, shareTitle, canonicalUrl) {
  const encText  = encodeURIComponent(shareText);
  const encTitle = encodeURIComponent(shareTitle);
  const encUrl   = encodeURIComponent(canonicalUrl);

  const twitterUrl  = `https://x.com/intent/tweet?url=${encUrl}&text=${encText}`;
  const redditUrl   = `https://reddit.com/submit?url=${encUrl}&title=${encTitle}`;
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`;
  const blueskyUrl  = `https://bsky.app/intent/compose?text=${encodeURIComponent(`${shareText}\n${canonicalUrl}`)}`;
  const emailUrl    = `mailto:?subject=${encTitle}&body=${encText}%0A%0A${encUrl}`;

  // Safe to embed canonicalUrl directly — it's our own constructed value, no user input
  const copyScript = `(function(b){if(!navigator.clipboard)return;navigator.clipboard.writeText('${canonicalUrl}').then(function(){if(typeof gtag==='function')gtag('event','share',{method:'copy_link'});b.classList.add('share-copied');var t=document.getElementById('share-copy-tip');if(t)t.classList.add('visible');setTimeout(function(){b.classList.remove('share-copied');if(t)t.classList.remove('visible');},2000);});})(this)`;

  return `<div class="share-row" aria-label="Share this page">` +
    `<span class="share-label">Share</span>` +
    `<a href="${twitterUrl}" class="share-btn" target="_blank" rel="noopener noreferrer" aria-label="Share on X / Twitter" title="Share on X" onclick="if(typeof gtag==='function')gtag('event','share',{method:'x'})">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>` +
    `</a>` +
    `<a href="${redditUrl}" class="share-btn" target="_blank" rel="noopener noreferrer" aria-label="Share on Reddit" title="Share on Reddit" onclick="if(typeof gtag==='function')gtag('event','share',{method:'reddit'})">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>` +
    `</a>` +
    `<a href="${facebookUrl}" class="share-btn" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook" title="Share on Facebook" onclick="if(typeof gtag==='function')gtag('event','share',{method:'facebook'})">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>` +
    `</a>` +
    `<a href="${blueskyUrl}" class="share-btn" target="_blank" rel="noopener noreferrer" aria-label="Share on Bluesky" title="Share on Bluesky" onclick="if(typeof gtag==='function')gtag('event','share',{method:'bluesky'})">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.204-.659-.3-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z"/></svg>` +
    `</a>` +
    `<a href="${emailUrl}" class="share-btn" aria-label="Share via email" title="Share via email" onclick="if(typeof gtag==='function')gtag('event','share',{method:'email'})">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>` +
    `</a>` +
    `<button class="share-btn" aria-label="Copy link" title="Copy link" onclick="${escapeHtml(copyScript)}">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` +
    `</button>` +
    `<span class="share-copy-tip" id="share-copy-tip" aria-live="polite">Copied!</span>` +
  `</div>`;
}

// ─── Co-reported medications ──────────────────────────────────────────────────
// Internal links are resolved here at generate time (not stored in the DB) against
// the in-memory drug list, matching on slug, brand_name, and generic_name so links
// always point at currently-live pages.

const slugifyName = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildCoReportedLinkIndex(drugs) {
  // Tie-break when several drugs share a name (common now that generic_name is
  // populated, e.g. quetiapine / seroquel / seroquel-xr all -> "quetiapine").
  // Priority: exact slug, then exact brand, then exact generic; within the brand
  // and generic tiers the drug with the highest total_reports wins. Exact slug is
  // first so a co-reported generic links to the page literally named that generic
  // (e.g. "omeprazole" -> /drugs/omeprazole/) and never to an obscure variant
  // (lasix-onyu, seroquel-xr, zyprexa-zydis); the highest-reports tiebreak only
  // applies when no standalone generic-named page exists.
  const bySlug    = new Map();
  const byBrand   = new Map();
  const byGeneric = new Map();
  const better = (cur, d) => (!cur || (d.total_reports || 0) > (cur.total_reports || 0)) ? d : cur;
  for (const d of drugs) {
    bySlug.set(d.slug, d);
    if (d.brand_name)   { const k = d.brand_name.toUpperCase().trim();   byBrand.set(k,   better(byBrand.get(k), d)); }
    if (d.generic_name) { const k = d.generic_name.toUpperCase().trim(); byGeneric.set(k, better(byGeneric.get(k), d)); }
  }
  return name => {
    const key  = String(name).toUpperCase().trim();
    const slug = slugifyName(name);
    if (bySlug.has(slug))    return bySlug.get(slug);     // 1: exact slug
    if (byBrand.has(key))    return byBrand.get(key);     // 2: exact brand (highest reports)
    if (byGeneric.has(key))  return byGeneric.get(key);   // 3: exact generic, 4: highest reports
    return null;
  };
}

// Renders the "Medications commonly reported with X" card, or '' if under 3 co-reports.
// Co-occurrence only: copy must never imply interaction, causation, or combined risk.
function renderCoReportedHtml(coReported, brandName, resolveLink) {
  if (!coReported || coReported.length < 3) return '';
  const items = coReported.map(c => {
    const display = escapeHtml(toTitleCase(c.name));
    const match   = resolveLink(c.name);
    const nameHtml = match ? `<a href="/drugs/${match.slug}/">${display}</a>` : display;
    return `    <li>${nameHtml} <span class="co-reported-count">(${c.count.toLocaleString('en-US')} reports)</span></li>`;
  }).join('\n');

  return `<section class="card" aria-labelledby="co-reported-heading">
  <h2 id="co-reported-heading">Medications commonly reported with ${escapeHtml(brandName)}</h2>
  <p class="section-note">In FDA adverse event reports that mention ${escapeHtml(brandName)}, these medications appeared most often in the same report.</p>
  <ul class="co-reported-list">
${items}
  </ul>
  <p class="chart-caption">This reflects co-occurrence in submitted reports, not evidence of drug interaction or combined risk. People often report several medications taken for the same condition or for unrelated reasons. Talk to a doctor or pharmacist about your specific medications.</p>
</section>`;
}

// Accessible, crawlable list of a drug's top adverse events. Terms with a glossary
// entry expand inline (native <details>, no hover, works on touch) and link to their
// full glossary entry; terms with no entry render as plain text. Mirrors the top 15
// shown in the chart so the same data is available without executing JavaScript.
function renderAeListHtml(adverseEvents, brandName) {
  const top = adverseEvents.slice(0, 15);
  if (!top.length) return '';
  const items = top.map(e => {
    const count = `<span class="ae-count">${Number(e.count).toLocaleString('en-US')} reports</span>`;
    const key = String(e.event_name).toUpperCase().trim();
    const g = GLOSSARY_BY_KEY.get(key);
    if (g) {
      const slug = slugifyName(g.display);
      const evDef = EVENT_BY_KEY.get(key);
      const eventLink = evDef
        ? ` <a href="/events/${evDef.slug}/">See all drugs reporting this event →</a>`
        : '';
      return `        <li class="ae-item"><details class="ae-term">` +
        `<summary><span class="ae-name">${escapeHtml(g.display)}</span> ${count}</summary>` +
        `<div class="ae-def"><p>${escapeHtml(g.definition)}</p>` +
        `<a href="/glossary/#${slug}">Full definition in the glossary →</a>${eventLink}</div>` +
        `</details></li>`;
    }
    return `        <li class="ae-item ae-item--plain">` +
      `<span class="ae-name">${escapeHtml(toTitleCase(e.event_name))}</span> ${count}</li>`;
  }).join('\n');
  // The whole list is wrapped in one collapsed <details> so it does not dominate
  // the page below the chart. It stays in the DOM when collapsed (not lazy-loaded),
  // so crawlers and screen readers still reach the terms. The per-term <details>
  // tap-to-define entries nest inside (valid: details within details).
  return `<details class="ae-list-toggle">\n` +
    `      <summary class="ae-list-summary">Show these terms with plain-language definitions</summary>\n` +
    `      <p class="ae-tap-hint">Tap any term below for a plain-language definition.</p>\n` +
    `      <ul class="ae-list" aria-label="Top reported adverse events for ${escapeHtml(brandName)}">\n${items}\n      </ul>\n` +
    `      </details>`;
}

// Renders the "Related Drugs" card HTML, or empty string if no related drugs.
function renderRelatedDrugsHtml(relatedDrugs) {
  if (!relatedDrugs || !relatedDrugs.length) return '';
  const items = relatedDrugs.map(d =>
    `    <li><a href="/drugs/${d.slug}/">${escapeHtml(displayName(d.brand_name))}</a>` +
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
    dateModified: DATA_DATE_ISO,
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

// ─── Chart data tables (crawlable) ─────────────────────────────────────────────

// Global latest trend period across all drugs (the data cutoff), set in generate()
// before pages render. Used to label the newest year "(partial)" when it is not a
// complete four-quarter year.
let TREND_CUTOFF = { year: 0, quarter: 0 };

// Renders a collapsed <details> data table mirroring a chart's server-side data,
// or '' when there are no rows (so a chart with no data degrades gracefully: the
// table is omitted, never rendered empty). Mirrors the ae-list-toggle pattern.
function renderChartTable(summary, caption, headers, rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map(([label, count]) =>
    `            <tr><th scope="row">${escapeHtml(String(label))}</th>` +
    `<td>${Number(count).toLocaleString('en-US')}</td></tr>`
  ).join('\n');
  return `<details class="chart-table-toggle">\n` +
    `        <summary class="chart-table-summary">${escapeHtml(summary)}</summary>\n` +
    `        <table class="chart-table">\n` +
    `          <caption>${escapeHtml(caption)}</caption>\n` +
    `          <thead><tr><th scope="col">${escapeHtml(headers[0])}</th>` +
    `<th scope="col">${escapeHtml(headers[1])}</th></tr></thead>\n` +
    `          <tbody>\n${body}\n          </tbody>\n` +
    `        </table>\n` +
    `      </details>`;
}

// ─── Page renderer ────────────────────────────────────────────────────────────

function renderPage(drug, adverseEvents, demographics, outcomes, trends, relatedDrugs = [], coReported = [], resolveLink = () => null) {
  const { slug, generic_name: genericName, total_reports: totalReports } = drug;
  const brandName = displayName(drug.brand_name);
  const canonicalUrl  = `${SITE_URL}/drugs/${slug}/`;
  const dateRange     = computeDateRange(trends) ?? 'data available';
  const generatedDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const pageTitle = buildPageTitle(brandName);
  const topEvent  = adverseEvents[0] && adverseEvents[0].event_name;
  const metaDesc  = buildMetaDesc(brandName, genericName, totalReports, topEvent);

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

  // Crawlable data tables (server-rendered, collapsed). Trend is aggregated to
  // yearly totals; the newest year is labeled "(partial)" when the data cutoff
  // falls before Q4 of that year. Canvas charts still read the JS arrays above.
  const yearMap = new Map();
  for (const t of trendRows) yearMap.set(t.year, (yearMap.get(t.year) || 0) + t.count);
  const trendYearRows = [...yearMap.entries()].map(([year, count]) => {
    const partial = year === TREND_CUTOFF.year && TREND_CUTOFF.quarter < 4;
    return [partial ? `${year} (partial)` : String(year), count];
  });
  const trendTable = renderChartTable(
    'View report trend as a table',
    `${brandName} adverse event reports by year`,
    ['Year', 'Reports'], trendYearRows);
  const sexTable = renderChartTable(
    'View reporter sex data as a table',
    `${brandName} adverse event reports by reporter sex`,
    ['Sex', 'Reports'], sexRows.map(d => [d.value, d.count]));
  const ageTable = renderChartTable(
    'View age group data as a table',
    `${brandName} adverse event reports by reporter age group`,
    ['Age group', 'Reports'], ageRows.map(d => [d.value, d.count]));
  const outcomesTable = renderChartTable(
    'View outcome data as a table',
    `${brandName} adverse event reports by reported outcome`,
    ['Outcome', 'Reports'], outRows.map(o => [o.outcome, o.count]));

  return TEMPLATE
    .replaceAll('{{BASE_CSS}}',             BASE_CSS)
    .replaceAll('{{PAGE_TITLE}}',           escapeHtml(pageTitle))
    .replaceAll('{{META_DESCRIPTION}}',     escapeHtml(metaDesc))
    .replaceAll('{{CANONICAL_URL}}',        canonicalUrl)
    .replaceAll('{{OG_TITLE}}',             escapeHtml(pageTitle))
    .replaceAll('{{OG_DESCRIPTION}}',       escapeHtml(metaDesc))
    .replaceAll('{{OG_URL}}',               canonicalUrl)
    .replaceAll('{{JSON_LD}}',              safeJson(buildJsonLd(drug, canonicalUrl, metaDesc)))
    .replaceAll('{{DRUG_DESCRIPTION}}',      renderDrugDescription(DESCRIPTION_OVERRIDES[slug] || drug.description))
    .replaceAll('{{BRAND_NAME}}',           escapeHtml(brandName))
    .replaceAll('{{GENERIC_NAME}}',         escapeHtml(genericName))
    .replaceAll('{{TOTAL_REPORTS}}',        totalReports.toLocaleString('en-US'))
    .replaceAll('{{DATE_RANGE}}',           escapeHtml(dateRange))
    .replaceAll('{{OPENFDA_URL}}',          buildOpenFdaUrl(drug))
    .replaceAll('{{GENERATED_DATE}}',       generatedDate)
    .replaceAll('{{ADVERSE_EVENTS_JSON}}',  safeJson(aeData))
    .replaceAll('{{AE_LIST_HTML}}',         renderAeListHtml(adverseEvents, brandName))
    .replaceAll('{{TREND_TABLE}}',          trendTable)
    .replaceAll('{{SEX_TABLE}}',            sexTable)
    .replaceAll('{{AGE_TABLE}}',            ageTable)
    .replaceAll('{{OUTCOMES_TABLE}}',       outcomesTable)
    .replaceAll('{{SEX_DATA_JSON}}',        safeJson(sexData))
    .replaceAll('{{AGE_DATA_JSON}}',        safeJson(ageData))
    .replaceAll('{{OUTCOMES_JSON}}',        safeJson(outcomesData))
    .replaceAll('{{TRENDS_JSON}}',          safeJson(trendsData))
    .replaceAll('{{CO_REPORTED_HTML}}',     renderCoReportedHtml(coReported, brandName, resolveLink))
    .replaceAll('{{RELATED_DRUGS_HTML}}',   renderRelatedDrugsHtml(relatedDrugs))
    .replaceAll('{{SHARE_BUTTONS}}',        renderShareButtons(
      `${brandName} has had ${Number(totalReports).toLocaleString('en-US')} adverse event reports submitted to the FDA. See the full breakdown on PillSignal.`,
      `${brandName}: FDA Adverse Event Data | PillSignal`,
      canonicalUrl))
    .replaceAll('{{DATA_LAST_UPDATED}}',    escapeHtml(DATA_LAST_UPDATED))
    .replaceAll('{{SITE_HEADER}}',          renderHeader('drug'))
    .replaceAll('{{SITE_FOOTER}}',          renderFooter());
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
    { loc: `${SITE_URL}/events/`,  changefreq: 'weekly',  priority: '0.8' },
    { loc: `${SITE_URL}/guides/`,  changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/glossary/`, changefreq: 'monthly', priority: '0.6' },
    { loc: `${SITE_URL}/guides/how-to-read-fda-adverse-event-reports/`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/guides/what-fda-drug-reports-show/`,            changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/guides/how-to-report-drug-side-effect-fda/`,   changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/guides/what-is-aems/`,                         changefreq: 'monthly', priority: '0.7' },
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

  const eventUrls = EVENT_DEFS.map(e =>
    `  <url>\n    <loc>${SITE_URL}/events/${e.slug}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    staticUrls + '\n' + drugUrls + '\n' + eventUrls + `\n</urlset>`;

  writeFileSync(join(DOCS_DIR, 'sitemap.xml'), xml, 'utf8');
  console.log(`  sitemap.xml  — ${drugs.length} drug URLs + ${EVENT_DEFS.length} event URLs + 14 static pages`);
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
      const brandDisplay = displayName(d.brand_name);
      const generic = d.generic_name
        ? `<span class="browse-generic">${escapeHtml(d.generic_name)}</span>`
        : '';
      const count = d.total_reports
        ? `<span class="browse-count">${d.total_reports.toLocaleString('en-US')} reports</span>`
        : '';
      return `        <li class="browse-item">` +
        `<span class="browse-name-wrap"><a href="/drugs/${d.slug}/" class="browse-brand">${escapeHtml(brandDisplay)}</a>${generic}</span>` +
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
  <title>Browse All Drugs: FDA Adverse Event Reports | PillSignal</title>
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
  <meta property="og:title"       content="Browse All Drugs: FDA Adverse Event Reports | PillSignal">
  <meta property="og:description" content="Alphabetical directory of ${total.toLocaleString('en-US')} drugs tracked by PillSignal.">
  <meta property="og:url"         content="${SITE_URL}/drugs/">
  <meta property="og:site_name"   content="PillSignal">
  <meta property="og:image"       content="${SITE_URL}/og-image.png">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="Browse All Drugs: FDA Adverse Event Reports | PillSignal">
  <meta name="twitter:description" content="Alphabetical directory of ${total.toLocaleString('en-US')} drugs with FDA adverse event data.">
  <meta name="twitter:image"       content="${SITE_URL}/og-image.png">

  <style>
    ${BASE_CSS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); font-size: var(--fs-body); line-height: 1.6; color: var(--c-text); background: var(--c-bg); transition: background 0.2s, color 0.2s; }
    a { color: var(--c-primary); text-decoration: none; }
    a:hover { text-decoration: underline; color: var(--c-primary-hover); }
    h1, h2, h3 { font-family: var(--font-heading); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: var(--c-surface); } ::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

    /* Banner */
    #disclaimer-banner { background: var(--c-banner-bg); color: var(--c-banner-text); font-size: var(--fs-small); line-height: 1.5; }
    .banner-seen #disclaimer-banner { display: none; }
    .banner-inner { max-width: 900px; margin: 0 auto; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .banner-inner p { flex: 1; min-width: 200px; }
    #banner-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--c-banner-border); color: var(--c-banner-text); padding: 0.3rem 1rem; border-radius: 4px; cursor: pointer; font-size: var(--fs-small); font-family: var(--font); white-space: nowrap; transition: background 0.15s; }
    #banner-btn:hover { background: var(--c-banner-btn-hover); }

    /* Header */
    .site-header { position: sticky; top: 0; z-index: 100; border-bottom: 1px solid var(--c-border); padding: 0.875rem 1rem; background: var(--c-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
    .site-header .inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .header-actions { display: flex; align-items: center; gap: 0.75rem; }
    .header-link { font-size: var(--fs-small); color: var(--c-text-muted); }
    .theme-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: none; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; color: var(--c-text-muted); padding: 0; flex-shrink: 0; transition: color 0.15s, border-color 0.15s, background 0.15s; }
    .theme-toggle:hover { color: var(--c-text); border-color: var(--c-text); background: var(--c-surface); }
    [data-theme="light"] .icon-sun { display: none; }
    [data-theme="dark"]  .icon-moon { display: none; }

    /* Page header */
    .page-header { padding: var(--space-6) var(--space-4) var(--space-4); max-width: 900px; margin: 0 auto; }
    .page-header h1 { font-size: var(--fs-display); font-weight: 600; letter-spacing: 0; margin-bottom: 0.3rem; }
    .page-header p { color: var(--c-text-muted); font-size: var(--fs-small); }

    /* Letter nav */
    .lnav { position: sticky; top: 3.75rem; z-index: 90; background: var(--c-bg); border-bottom: 1px solid var(--c-border); padding: 0.5rem 1rem; display: flex; flex-wrap: wrap; gap: 2px; max-width: 100%; }
    .lnav-inner { max-width: 900px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
    .lnav-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; font-size: var(--fs-small); font-weight: 600; border-radius: 4px; }
    .lnav-item--on { color: var(--c-primary); } .lnav-item--on:hover { background: var(--c-primary-light); text-decoration: none; }
    .lnav-item--off { color: var(--c-border); cursor: default; }

    /* Browse list */
    main { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .letter-section { margin-bottom: 2rem; }
    .letter-heading { font-size: 1.5rem; font-weight: 600; color: var(--c-text); letter-spacing: 0; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 2px solid var(--c-border); }
    .browse-list { list-style: none; }
    .browse-item { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding: 0.35rem 0; border-bottom: 1px solid var(--c-border); min-width: 0; }
    .browse-item:last-child { border-bottom: none; }
    .browse-name-wrap { display: flex; align-items: baseline; gap: 0.4rem; flex: 1; min-width: 0; flex-wrap: wrap; }
    .browse-brand { font-weight: 600; font-size: var(--fs-small); overflow-wrap: break-word; word-break: break-word; min-width: 0; }
    .browse-generic { font-size: var(--fs-small); color: var(--c-text-muted); min-width: 0; overflow-wrap: break-word; }
    .browse-count { font-size: var(--fs-caption); color: var(--c-text-muted); white-space: nowrap; flex-shrink: 0; }
    @media (max-width: 480px) {
      .browse-item { flex-direction: column; align-items: flex-start; gap: 0.1rem; }
      .browse-count { font-size: 0.7rem; margin-top: 0.05rem; }
    }

    /* Footer */
    .site-footer { border-top: 1px solid var(--c-border); padding: 1.5rem 1rem; text-align: center; font-size: var(--fs-small); color: var(--c-text-muted); background: var(--c-bg); }
    .site-footer a { color: var(--c-text-muted); }
    .site-footer a:hover { color: var(--c-primary); text-decoration: none; }
    @media (min-width: 640px) { .site-footer { font-size: var(--fs-small); } }
    .footer-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem; }
    .footer-x-link { display: inline-flex; align-items: center; justify-content: center; margin-top: 0.6rem; color: var(--c-text-muted); transition: color 0.15s; }
    .footer-x-link:hover { color: var(--c-primary); }

    /* Back to top */
    #back-to-top { position: fixed; bottom: 1.5rem; right: 1.5rem; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--c-border); background: rgba(255,255,255,0.75); color: var(--c-text-muted); font-size: 1.1rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.25s, background 0.15s, color 0.15s; z-index: 100; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    [data-theme="dark"] #back-to-top { background: rgba(30,41,59,0.75); }
    #back-to-top.visible { opacity: 1; pointer-events: auto; }
    #back-to-top:hover { background: var(--c-surface); color: var(--c-text); border-color: var(--c-text); }
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

${renderHeader('browse')}

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

  <button id="back-to-top" aria-label="Back to top" title="Back to top">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2,10 7,4 12,10"/></svg>
  </button>

${renderFooter()}

  <script>
    document.getElementById('banner-btn').addEventListener('click', function () {
      localStorage.setItem('pillsignal_disclaimer_dismissed', '1');
      document.documentElement.classList.add('banner-seen');
    });
    (function () {
      var btn = document.getElementById('back-to-top');
      window.addEventListener('scroll', function () {
        if (window.scrollY > 500) { btn.classList.add('visible'); }
        else { btn.classList.remove('visible'); }
      }, { passive: true });
      btn.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }());
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

function formatReportTotal(n) {
  if (n >= 1_000_000_000) return `${Math.floor(n / 1_000_000_000)}B+`;
  if (n >= 1_000_000)     return `${Math.floor(n / 1_000_000)}M+`;
  if (n >= 1_000)         return `${Math.floor(n / 1_000)}K+`;
  return n.toLocaleString('en-US');
}

async function fetchYearRange() {
  const [minRes, maxRes] = await Promise.all([
    supabase.from('trends').select('year').order('year', { ascending: true  }).limit(1),
    supabase.from('trends').select('year').order('year', { ascending: false }).limit(1),
  ]);
  const minYear = minRes.data?.[0]?.year ?? new Date().getFullYear();
  const maxYear = maxRes.data?.[0]?.year ?? new Date().getFullYear();
  return { minYear, maxYear };
}

function writeHomepage(drugs, minYear, maxYear) {
  const totalReports = drugs.reduce((s, d) => s + (d.total_reports || 0), 0);
  const drugCount    = drugs.length.toLocaleString('en-US');
  const reportFmt    = formatReportTotal(totalReports);
  const coverage     = `${minYear}–${maxYear}`;
  const lastUpdated  = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const statsBarHtml =
`  <!-- ─── Stats bar ────────────────────────────────────────────────────────── -->
  <div class="stats-bar" aria-label="PillSignal dataset summary">
    <div class="inner">
      <div class="stat-item">
        <div class="stat-value">${reportFmt}</div>
        <div class="stat-label">Total FAERS Reports</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${drugCount}</div>
        <div class="stat-label">Drugs Indexed</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${coverage}</div>
        <div class="stat-label">Data Coverage</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${lastUpdated}</div>
        <div class="stat-label">Last Updated</div>
      </div>
    </div>
  </div>`;

  const html = HOMEPAGE_TEMPLATE
    .replace('{{BASE_CSS}}',     BASE_CSS)
    .replace('{{STATS_BAR}}',    statsBarHtml)
    .replace('{{SITE_HEADER}}',  renderHeader('home'))
    .replace('{{SITE_FOOTER}}',  renderFooter());
  writeFileSync(join(DOCS_DIR, 'index.html'), html, 'utf8');
  console.log(`  index.html   — stats: ${reportFmt} reports, ${drugCount} drugs, ${coverage}`);
}

const STATIC_PAGES = [
  { template: 'about.html',                                       output: 'about/index.html'                                       },
  { template: 'faq.html',                                         output: 'faq/index.html'                                         },
  { template: 'contact.html',                                     output: 'contact/index.html'                                     },
  { template: 'privacy.html',                                     output: 'privacy/index.html'                                     },
  { template: 'terms.html',                                       output: 'terms/index.html'                                       },
  { template: 'guides/index.html',                                output: 'guides/index.html'                                      },
  { template: 'guides/how-to-read-fda-adverse-event-reports.html', output: 'guides/how-to-read-fda-adverse-event-reports/index.html' },
  { template: 'guides/what-fda-drug-reports-show.html',           output: 'guides/what-fda-drug-reports-show/index.html'           },
  { template: 'guides/how-to-report-drug-side-effect-fda.html',   output: 'guides/how-to-report-drug-side-effect-fda/index.html'   },
  { template: 'guides/what-is-aems.html',                         output: 'guides/what-is-aems/index.html'                         },
];

// Writes the client-side copy of the glossary used for inline drug-page definitions.
function writeGlossaryData() {
  mkdirSync(join(DOCS_DIR, 'js'), { recursive: true });
  writeFileSync(join(DOCS_DIR, 'js', 'glossary.json'), JSON.stringify(GLOSSARY), 'utf8');
  console.log(`  glossary.json — ${GLOSSARY.terms.length} terms`);
}

// Standalone /glossary/ page, generated from GLOSSARY (single source of truth).
function writeGlossaryPage() {
  const terms = [...GLOSSARY.terms].sort((a, b) =>
    a.display.toLowerCase().localeCompare(b.display.toLowerCase()));

  // Group alphabetically by first letter of the display name.
  const groups = {};
  for (const t of terms) {
    const first = t.display[0].toUpperCase();
    const bucket = /[A-Z]/.test(first) ? first : '#';
    (groups[bucket] ||= []).push(t);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const usedKeys = Object.keys(groups).sort();

  const letterNav = alphabet.map(l =>
    groups[l]
      ? `<a href="#letter-${l}" class="lnav-item lnav-item--on">${l}</a>`
      : `<span class="lnav-item lnav-item--off">${l}</span>`
  ).join('');

  const sections = usedKeys.map(letter => {
    const items = groups[letter].map(t => {
      const id = slugifyName(t.display);
      return `      <dt id="${id}" class="gloss-term">${escapeHtml(t.display)}</dt>\n` +
             `      <dd class="gloss-def">${escapeHtml(t.definition)}</dd>`;
    }).join('\n');
    return `    <section class="gloss-section">` +
      `<h2 id="letter-${letter}" class="gloss-letter">${letter === '#' ? 'Other' : letter}</h2>` +
      `<dl class="gloss-list">\n${items}\n      </dl></section>`;
  }).join('\n\n');

  const pageTitle = 'Adverse Event Glossary | PillSignal';
  const metaDesc  = `Plain-language definitions of ${terms.length} common terms used in FDA adverse event reports, from nausea and fatigue to medical terms like dyspnoea and pyrexia.`;
  const canonical = `${SITE_URL}/glossary/`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
  <title>${pageTitle}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${canonical}">

  <!-- Favicon & PWA -->
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#00A67E">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(metaDesc)}">
  <meta property="og:url"         content="${canonical}">
  <meta property="og:site_name"   content="PillSignal">
  <meta property="og:image"       content="${SITE_URL}/og-image.png">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(metaDesc)}">
  <meta name="twitter:image"       content="${SITE_URL}/og-image.png">

  <style>
    ${BASE_CSS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); font-size: var(--fs-body); line-height: 1.6; color: var(--c-text); background: var(--c-bg); transition: background 0.2s, color 0.2s; }
    a { color: var(--c-primary); text-decoration: none; }
    a:hover { text-decoration: underline; color: var(--c-primary-hover); }
    h1, h2, h3 { font-family: var(--font-heading); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: var(--c-surface); } ::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

    /* Banner */
    #disclaimer-banner { background: var(--c-banner-bg); color: var(--c-banner-text); font-size: var(--fs-small); line-height: 1.5; }
    .banner-seen #disclaimer-banner { display: none; }
    .banner-inner { max-width: 900px; margin: 0 auto; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .banner-inner p { flex: 1; min-width: 200px; }
    #banner-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--c-banner-border); color: var(--c-banner-text); padding: 0.3rem 1rem; border-radius: 4px; cursor: pointer; font-size: var(--fs-small); font-family: var(--font); white-space: nowrap; transition: background 0.15s; }
    #banner-btn:hover { background: var(--c-banner-btn-hover); }

    /* Header */
    .site-header { position: sticky; top: 0; z-index: 100; border-bottom: 1px solid var(--c-border); padding: 0.875rem 1rem; background: var(--c-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
    .site-header .inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .header-actions { display: flex; align-items: center; gap: 0.75rem; }
    .header-link { font-size: var(--fs-small); color: var(--c-text-muted); }
    .theme-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: none; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; color: var(--c-text-muted); padding: 0; flex-shrink: 0; transition: color 0.15s, border-color 0.15s, background 0.15s; }
    .theme-toggle:hover { color: var(--c-text); border-color: var(--c-text); background: var(--c-surface); }
    [data-theme="light"] .icon-sun { display: none; }
    [data-theme="dark"]  .icon-moon { display: none; }

    /* Page header */
    .page-header { padding: var(--space-6) var(--space-4) var(--space-4); max-width: 720px; margin: 0 auto; }
    .page-header h1 { font-size: var(--fs-display); font-weight: 600; letter-spacing: 0; margin-bottom: 0.3rem; }
    .page-header p { color: var(--c-text-muted); font-size: var(--fs-small); }

    /* Caveat */
    .gloss-caveat { max-width: 720px; margin: 0 auto var(--space-2); padding: 0 1rem; }
    .gloss-caveat .card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); padding: 1rem 1.25rem; font-size: var(--fs-small); color: var(--c-text-muted); }

    /* Letter nav */
    .lnav { position: sticky; top: 3.75rem; z-index: 90; background: var(--c-bg); border-bottom: 1px solid var(--c-border); padding: 0.5rem 1rem; }
    .lnav-inner { max-width: 720px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
    .lnav-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; font-size: var(--fs-small); font-weight: 600; border-radius: 4px; }
    .lnav-item--on { color: var(--c-primary); } .lnav-item--on:hover { background: var(--c-primary-light); text-decoration: none; }
    .lnav-item--off { color: var(--c-border); cursor: default; }

    /* Glossary list */
    main { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .gloss-section { margin-bottom: var(--space-6); }
    .gloss-letter { font-size: 1.5rem; font-weight: 600; color: var(--c-text); letter-spacing: 0; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 2px solid var(--c-border); scroll-margin-top: 5rem; }
    .gloss-list { margin: 0; }
    .gloss-term { font-weight: 600; font-size: var(--fs-h3); margin-top: 1rem; scroll-margin-top: 5rem; color: var(--c-text); }
    .gloss-term:target { text-decoration: underline; }
    .gloss-def { color: var(--c-text-muted); margin: 0.15rem 0 0; padding-bottom: 0.75rem; border-bottom: 1px solid var(--c-border); }

    /* Footer */
    .site-footer { border-top: 1px solid var(--c-border); padding: 1.5rem 1rem; text-align: center; font-size: var(--fs-small); color: var(--c-text-muted); background: var(--c-bg); }
    .site-footer a { color: var(--c-text-muted); }
    .site-footer a:hover { color: var(--c-primary); text-decoration: none; }
    @media (min-width: 640px) { .site-footer { font-size: var(--fs-small); } }
    .footer-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem; }
    .footer-x-link { display: inline-flex; align-items: center; justify-content: center; margin-top: 0.6rem; color: var(--c-text-muted); transition: color 0.15s; }
    .footer-x-link:hover { color: var(--c-primary); }

    /* Back to top */
    #back-to-top { position: fixed; bottom: 1.5rem; right: 1.5rem; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--c-border); background: rgba(255,255,255,0.75); color: var(--c-text-muted); font-size: 1.1rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.25s, background 0.15s, color 0.15s; z-index: 100; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    [data-theme="dark"] #back-to-top { background: rgba(30,41,59,0.75); }
    #back-to-top.visible { opacity: 1; pointer-events: auto; }
    #back-to-top:hover { background: var(--c-surface); color: var(--c-text); border-color: var(--c-text); }
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

${renderHeader('glossary')}

  <div class="page-header">
    <h1>Adverse Event Glossary</h1>
    <p>Plain-language definitions of the most common terms in FDA adverse event reports.</p>
  </div>

  <div class="gloss-caveat"><div class="card">${escapeHtml(GLOSSARY.caveat)}</div></div>

  <nav class="lnav" aria-label="Jump to letter">
    <div class="lnav-inner">${letterNav}</div>
  </nav>

  <main>
${sections}
  </main>

  <button id="back-to-top" aria-label="Back to top" title="Back to top">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2,10 7,4 12,10"/></svg>
  </button>

${renderFooter()}

  <script>
    document.getElementById('banner-btn').addEventListener('click', function () {
      localStorage.setItem('pillsignal_disclaimer_dismissed', '1');
      document.documentElement.classList.add('banner-seen');
    });
    (function () {
      var btn = document.getElementById('back-to-top');
      window.addEventListener('scroll', function () {
        if (window.scrollY > 500) { btn.classList.add('visible'); }
        else { btn.classList.remove('visible'); }
      }, { passive: true });
      btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }());
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

  mkdirSync(join(DOCS_DIR, 'glossary'), { recursive: true });
  writeFileSync(join(DOCS_DIR, 'glossary', 'index.html'), html, 'utf8');
  console.log(`  glossary/index.html — ${terms.length} terms across ${usedKeys.length} letter sections`);
}

// ─── Event (reverse-index) pages ────────────────────────────────────────────
// v1 event pages: MedDRA key (matches adverse_events + glossary), consumer slug,
// and common-name alias (null when the MedDRA display is already the lay term).

const EVENT_DEFS = [
  { key: 'NAUSEA', slug: 'nausea', common: null },
  { key: 'VOMITING', slug: 'vomiting', common: null },
  { key: 'DIARRHOEA', slug: 'diarrhea', common: 'Diarrhea' },
  { key: 'ABDOMINAL PAIN', slug: 'abdominal-pain', common: null },
  { key: 'CONSTIPATION', slug: 'constipation', common: null },
  { key: 'GASTROOESOPHAGEAL REFLUX DISEASE', slug: 'acid-reflux', common: 'Acid Reflux' },
  { key: 'DYSPEPSIA', slug: 'indigestion', common: 'Indigestion' },
  { key: 'ABDOMINAL DISTENSION', slug: 'bloating', common: 'Bloating' },
  { key: 'FATIGUE', slug: 'fatigue', common: null },
  { key: 'PYREXIA', slug: 'fever', common: 'Fever' },
  { key: 'WEIGHT DECREASED', slug: 'weight-loss', common: 'Weight Loss' },
  { key: 'DECREASED APPETITE', slug: 'loss-of-appetite', common: 'Loss of Appetite' },
  { key: 'WEIGHT INCREASED', slug: 'weight-gain', common: 'Weight Gain' },
  { key: 'HYPERHIDROSIS', slug: 'excessive-sweating', common: 'Excessive Sweating' },
  { key: 'HOT FLUSH', slug: 'hot-flashes', common: 'Hot Flashes' },
  { key: 'DRY MOUTH', slug: 'dry-mouth', common: null },
  { key: 'HEADACHE', slug: 'headache', common: null },
  { key: 'DIZZINESS', slug: 'dizziness', common: null },
  { key: 'ANXIETY', slug: 'anxiety', common: null },
  { key: 'INSOMNIA', slug: 'insomnia', common: null },
  { key: 'DEPRESSION', slug: 'depression', common: null },
  { key: 'SOMNOLENCE', slug: 'drowsiness', common: 'Drowsiness' },
  { key: 'TREMOR', slug: 'tremor', common: null },
  { key: 'HYPOAESTHESIA', slug: 'numbness', common: 'Numbness' },
  { key: 'MEMORY IMPAIRMENT', slug: 'memory-loss', common: 'Memory Loss' },
  { key: 'PARAESTHESIA', slug: 'tingling', common: 'Tingling' },
  { key: 'MIGRAINE', slug: 'migraine', common: null },
  { key: 'RASH', slug: 'rash', common: null },
  { key: 'PRURITUS', slug: 'itching', common: 'Itching' },
  { key: 'ALOPECIA', slug: 'hair-loss', common: 'Hair Loss' },
  { key: 'URTICARIA', slug: 'hives', common: 'Hives' },
  { key: 'DRY SKIN', slug: 'dry-skin', common: null },
  { key: 'ACNE', slug: 'acne', common: null },
  { key: 'HYPERTENSION', slug: 'high-blood-pressure', common: 'High Blood Pressure' },
  { key: 'HYPOTENSION', slug: 'low-blood-pressure', common: 'Low Blood Pressure' },
  { key: 'CHEST PAIN', slug: 'chest-pain', common: null },
  { key: 'PALPITATIONS', slug: 'palpitations', common: null },
  { key: 'TACHYCARDIA', slug: 'fast-heartbeat', common: 'Fast Heartbeat' },
  { key: 'ARTHRALGIA', slug: 'joint-pain', common: 'Joint Pain' },
  { key: 'BACK PAIN', slug: 'back-pain', common: null },
  { key: 'MUSCLE SPASMS', slug: 'muscle-spasms', common: null },
  { key: 'MYALGIA', slug: 'muscle-pain', common: 'Muscle Pain' },
  { key: 'DYSPNOEA', slug: 'shortness-of-breath', common: 'Shortness of Breath' },
  { key: 'COUGH', slug: 'cough', common: null },
  { key: 'EPISTAXIS', slug: 'nosebleed', common: 'Nosebleed' },
  { key: 'ANAEMIA', slug: 'anemia', common: 'Anemia' },
  { key: 'PERIPHERAL SWELLING', slug: 'swelling', common: 'Swelling' },
  { key: 'URINARY TRACT INFECTION', slug: 'urinary-tract-infection', common: 'UTI' },
  { key: 'VISION BLURRED', slug: 'blurred-vision', common: 'Blurred Vision' },
  { key: 'ERECTILE DYSFUNCTION', slug: 'erectile-dysfunction', common: null },
];
const EVENT_BY_KEY = new Map(EVENT_DEFS.map(e => [e.key, e]));

// Event-page-only enriched intros for terms whose glossary definition is thin.
// These do NOT touch glossary.json; renderEventPage falls back to the glossary
// definition when a key is absent here. Assigned onto EVENT_DEFS as `.intro`.
const EVENT_INTROS = {
  HYPERHIDROSIS: `Excessive sweating beyond what the body needs for temperature control. It can affect the whole body or specific areas like the palms, feet, or underarms, and can occur during the day or at night. In adverse event reports, it covers sweating that patients or clinicians considered unusual or disruptive.`,
  ALOPECIA: `The medical term for hair loss, which can range from mild thinning to losing hair in patches or across the whole scalp. It can develop gradually or come on quickly, and it may be temporary or longer lasting. In adverse event reports, it covers any degree of reported hair loss or thinning.`,
  ARTHRALGIA: `The medical term for joint pain, which can affect one joint or several, including the knees, hips, hands, or shoulders. It ranges from mild stiffness or aching to pain that limits daily movement. In adverse event reports, it covers joint pain of any severity, with or without visible swelling.`,
  'WEIGHT DECREASED': `Losing body weight without deliberately trying to. It can happen gradually or quickly, and reports range from modest changes to significant unintended loss. In adverse event reports, it reflects weight loss the patient or clinician considered noteworthy.`,
  'WEIGHT INCREASED': `Gaining body weight without intending to. Reports range from gradual changes over months to more rapid gains, and can involve fluid retention as well as body mass. In adverse event reports, it reflects weight gain the patient or clinician considered noteworthy.`,
  'MEMORY IMPAIRMENT': `Difficulty remembering things, such as forgetting recent conversations, appointments, or where items were placed. It can be occasional and mild or frequent enough to interfere with daily life. In adverse event reports, it covers reported memory problems of any degree.`,
  HYPERTENSION: `High blood pressure, meaning the force of blood against artery walls is consistently higher than normal. It usually has no symptoms and is often found during routine measurement. In adverse event reports, it covers both newly reported high readings and worsening of existing high blood pressure.`,
  HYPOTENSION: `Low blood pressure, which can cause dizziness, lightheadedness, or fainting, especially when standing up quickly. Some people have naturally low readings without symptoms, while sudden drops can be more noticeable. In adverse event reports, it covers reported low readings and symptoms attributed to them.`,
  'DECREASED APPETITE': `A reduced desire to eat, ranging from mild disinterest in food to eating substantially less than usual. Over time it can lead to weight loss or reduced energy. In adverse event reports, it covers any reported reduction in appetite.`,
  SOMNOLENCE: `Drowsiness or strong sleepiness during waking hours, beyond ordinary tiredness. It can make it hard to stay alert during activities like working, reading, or driving. In adverse event reports, it covers reported daytime sleepiness of any degree.`,
  PRURITUS: `The medical term for itching of the skin, with or without a visible rash. It can affect one area or the whole body, and ranges from a mild annoyance to itching intense enough to disrupt sleep. In adverse event reports, it covers reported itching of any severity.`,
  MYALGIA: `The medical term for muscle pain or aches, which can affect one muscle group or the whole body. It ranges from mild soreness to pain that limits movement or daily activity. In adverse event reports, it covers reported muscle pain of any degree.`,
  'BACK PAIN': `Pain anywhere along the back, from the neck down to the lower spine, with the lower back being the most common site. It can be a dull ache, sharp pain, or stiffness, and can be brief or long lasting. In adverse event reports, it covers reported back pain of any location or severity.`,
  INSOMNIA: `Difficulty falling asleep, staying asleep, or waking too early and being unable to return to sleep. Over time it can lead to daytime tiredness, irritability, and trouble concentrating. In adverse event reports, it covers reported sleep difficulty of any pattern.`,
  TACHYCARDIA: `A faster than normal heart rate, typically over 100 beats per minute at rest. It can feel like a racing, pounding, or fluttering heartbeat, or it may be noticed only during a medical exam. In adverse event reports, it covers reported episodes of elevated heart rate.`,
  EPISTAXIS: `The medical term for a nosebleed. Reports range from occasional minor bleeding to frequent or heavy nosebleeds that are hard to stop. In adverse event reports, it covers nosebleeds of any frequency or severity.`,
  'ERECTILE DYSFUNCTION': `Difficulty getting or keeping an erection firm enough for sexual activity. It can happen occasionally or become a persistent pattern, and it can affect quality of life and relationships. In adverse event reports, it covers reported erectile difficulty of any degree.`,
  VOMITING: `Throwing up the contents of the stomach. It can be a single episode or repeated, and persistent vomiting can lead to dehydration. In adverse event reports, it covers reported vomiting of any frequency or severity.`,
  'ABDOMINAL PAIN': `Pain in the belly or stomach area, anywhere between the chest and the pelvis. It can be cramping, aching, sharp, or dull, and constant or coming in waves. In adverse event reports, it covers reported abdominal pain of any type or location.`,
  'ABDOMINAL DISTENSION': `A swelling or bloating of the belly, which can feel tight, full, or visibly enlarged. It can result from gas, fluid, or other factors, and can be brief or persistent. In adverse event reports, it covers reported bloating or visible abdominal swelling.`,
  'CHEST PAIN': `Pain or discomfort anywhere in the chest, which can feel sharp, dull, tight, or like pressure. It can stem from the heart, lungs, muscles, or digestive system, and it is always worth taking seriously and discussing with a doctor. In adverse event reports, it covers reported chest pain of any type or severity.`,
  HEADACHE: `Pain in the head or upper neck, ranging from a dull ache to sharp or throbbing pain. Headaches vary widely in how long they last and how often they occur. In adverse event reports, it covers reported headaches of any type, including tension-type and others not classified as migraine.`,
  ANXIETY: `A feeling of worry, nervousness, or unease that can range from occasional mild worry to persistent anxiety that interferes with daily life. Physical signs can include restlessness, a racing heart, or trouble concentrating. In adverse event reports, it covers reported anxiety of any degree.`,
  TREMOR: `Involuntary shaking or trembling, most often in the hands, but sometimes affecting the arms, head, voice, or legs. It can be subtle or pronounced, constant or occasional. In adverse event reports, it covers reported shaking or trembling of any pattern.`,
  RASH: `An area of irritated, red, or bumpy skin, which can be flat or raised, itchy or painless, and localized or widespread. Rashes vary widely in appearance and duration. In adverse event reports, it covers reported skin eruptions not classified under a more specific term.`,
  COUGH: `A reflex that clears the throat or airways, which can be dry or produce mucus. A cough can be brief or persist for weeks, and frequent coughing can disrupt sleep and daily activity. In adverse event reports, it covers reported coughing of any pattern or duration.`,
};
for (const d of EVENT_DEFS) if (EVENT_INTROS[d.key]) d.intro = EVENT_INTROS[d.key];

const EVENT_MIN_COUNT = 25;  // a drug needs at least this many reports of the event
const EVENT_CAP       = 100; // list at most this many drugs (by report count)

const eventDisplay = def => (GLOSSARY_BY_KEY.get(def.key)?.display) || toTitleCase(def.key);
const eventLabel   = def => { const d = eventDisplay(def); return def.common ? `${def.common} (${d})` : d; };
// lay term for prose; keep all-caps abbreviations (UTI) as-is, else lowercase
const eventTerm    = def => { const t = def.common || eventDisplay(def); return /^[A-Z]{2,}$/.test(t) ? t : t.toLowerCase(); };

// event -> qualifying drug rows [{drug, count}] (count >= EVENT_MIN_COUNT), sorted desc
function buildEventIndex(drugsWithData, detailsMap) {
  const idx = new Map();
  for (const key of EVENT_BY_KEY.keys()) idx.set(key, []);
  for (const drug of drugsWithData) {
    for (const ae of detailsMap[drug.id].adverseEvents) {
      if (!EVENT_BY_KEY.has(ae.event_name) || ae.count < EVENT_MIN_COUNT) continue;
      idx.get(ae.event_name).push({ drug, count: ae.count });
    }
  }
  for (const list of idx.values()) list.sort((a, b) => b.count - a.count);
  return idx;
}

// Shared page shell (head + chrome + scripts), mirroring the glossary/browse pages.
function renderEventShell({ title, metaDesc, canonical, jsonLd, body, page = 'default' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${canonical}">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#00A67E">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(metaDesc)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:site_name" content="PillSignal">
  <meta property="og:image" content="${SITE_URL}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(metaDesc)}">
  <meta name="twitter:image" content="${SITE_URL}/og-image.png">
  <script type="application/ld+json">${safeJson(jsonLd)}</script>
  <style>
    ${BASE_CSS}
    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:var(--font); font-size: var(--fs-body); line-height:1.6; color:var(--c-text); background:var(--c-bg); transition:background 0.2s,color 0.2s; }
    a { color:var(--c-primary); text-decoration:none; } a:hover { text-decoration:underline; color:var(--c-primary-hover); }
    h1,h2,h3 { font-family:var(--font-heading); }
    #disclaimer-banner { background:var(--c-banner-bg); color:var(--c-banner-text); font-size: var(--fs-small); line-height:1.5; }
    .banner-seen #disclaimer-banner { display:none; }
    .banner-inner { max-width:900px; margin:0 auto; padding:0.75rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
    .banner-inner p { flex:1; min-width:200px; }
    #banner-btn { flex-shrink:0; background:transparent; border:1px solid var(--c-banner-border); color:var(--c-banner-text); padding:0.3rem 1rem; border-radius:4px; cursor:pointer; font-size: var(--fs-small); font-family:var(--font); white-space:nowrap; }
    #banner-btn:hover { background:var(--c-banner-btn-hover); }
    .site-header { position:sticky; top:0; z-index:100; border-bottom:1px solid var(--c-border); padding:0.875rem 1rem; background:var(--c-bg); box-shadow:0 2px 4px rgba(0,0,0,0.06); }
    .site-header .inner { max-width:900px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; }
    .header-actions { display:flex; align-items:center; gap:0.75rem; }
    .header-link { font-size: var(--fs-small); color:var(--c-text-muted); }
    .theme-toggle { display:flex; align-items:center; justify-content:center; width:32px; height:32px; background:none; border:1px solid var(--c-border); border-radius:6px; cursor:pointer; color:var(--c-text-muted); padding:0; flex-shrink:0; }
    .theme-toggle:hover { color: var(--c-text); border-color: var(--c-text); background: var(--c-surface); }
    [data-theme="light"] .icon-sun { display:none; } [data-theme="dark"] .icon-moon { display:none; }
    .page-header { padding:var(--space-6) var(--space-4) var(--space-4); max-width:900px; margin:0 auto; }
    .page-header h1 { font-size:clamp(1.4rem,4vw,1.9rem); font-weight:600; margin-bottom:0.3rem; }
    .page-header p { color:var(--c-text-muted); font-size: var(--fs-small); }
    main { max-width:900px; margin:0 auto; padding:1rem 1rem 4rem; }
    .event-caveat { max-width:900px; margin:0 auto var(--space-2); padding:0 1rem; }
    .event-caveat .card { background:var(--c-surface); border:1px solid var(--c-border); border-left:3px solid var(--c-primary); border-radius:var(--radius-md); padding:1rem 1.25rem; font-size:var(--fs-small); color:var(--c-text-muted); }
    .event-intro { font-size: var(--fs-small); margin:0 0 var(--space-4); }
    .event-trim { font-size: var(--fs-small); color:var(--c-text-muted); margin:0 0 0.5rem; }
    .event-table { width:100%; border-collapse:collapse; font-size: var(--fs-small); }
    .event-table caption { text-align:left; font-weight:600; color:var(--c-text-muted); font-size: var(--fs-small); padding:0 0 0.5rem; }
    .event-table th, .event-table td { padding:0.5rem 0.5rem; border-bottom:1px solid var(--c-border); }
    .event-table thead th { text-align:left; color:var(--c-text-muted); font-size: var(--fs-small); font-weight:600; }
    .event-table thead th:nth-child(2), .event-table thead th:nth-child(3) { text-align:right; }
    .event-table tbody th { text-align:left; font-weight:600; }
    .event-table tbody td { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .event-table tbody tr:nth-child(even) { background:rgba(127,127,127,0.05); }
    .event-back { margin-top:var(--space-4); font-size: var(--fs-small); }
    .event-index { list-style:none; margin:0; padding:0; columns:2; column-gap:2rem; }
    @media (max-width:560px) { .event-index { columns:1; } }
    .event-index li { break-inside:avoid; padding:0.4rem 0; border-bottom:1px solid var(--c-border); display:flex; justify-content:space-between; gap:0.75rem; align-items:baseline; }
    .event-idx-count { font-size: var(--fs-small); color:var(--c-text-muted); white-space:nowrap; flex-shrink:0; }
    .site-footer { border-top:1px solid var(--c-border); padding:1.5rem 1rem; text-align:center; font-size: var(--fs-small); color:var(--c-text-muted); background:var(--c-bg); }
    .site-footer a { color:var(--c-text-muted); } .site-footer a:hover { color:var(--c-primary); text-decoration:none; }
    .footer-nav { display:flex; gap:1.25rem; flex-wrap:wrap; justify-content:center; margin-top:0.5rem; }
    .footer-x-link { display:inline-flex; align-items:center; justify-content:center; margin-top:0.6rem; color:var(--c-text-muted); }
    .footer-x-link:hover { color:var(--c-primary); }
  </style>
  <script>
    (function () {
      var saved = localStorage.getItem('pillsignal_theme');
      var dark  = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', saved || (dark ? 'dark' : 'light'));
      if (localStorage.getItem('pillsignal_disclaimer_dismissed')) document.documentElement.classList.add('banner-seen');
    }());
  </script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-C5ZEDB8Z5P"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-C5ZEDB8Z5P');
  </script>
</head>
<body>

${renderHeader(page)}
${body}
${renderFooter()}

  <script>
    document.getElementById('banner-btn').addEventListener('click', function () {
      localStorage.setItem('pillsignal_disclaimer_dismissed', '1');
      document.documentElement.classList.add('banner-seen');
    });
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('pillsignal_theme', next);
      if (typeof gtag === 'function') gtag('event', 'dark_mode_toggle', { new_theme: next });
    });
  </script>
</body>
</html>`;
}

function renderEventPage(def, list) {
  const display   = eventDisplay(def);
  const label     = eventLabel(def);
  const term      = eventTerm(def);
  const anchor    = slugifyName(display);
  const gloss     = GLOSSARY_BY_KEY.get(def.key);
  const canonical = `${SITE_URL}/events/${def.slug}/`;
  const title     = `${label}: Drugs With FDA Adverse Event Reports | PillSignal`;
  const h1        = `${label}: Drugs With FDA Adverse Event Reports`;
  const total     = list.length;
  const shown     = list.slice(0, EVENT_CAP);
  const metaDesc  = `Medications with FDA adverse event reports of ${term}: report counts by drug, each shown as a share of that drug's total reports. Report counts reflect reporting volume, not medical risk.`;

  const caveat = `These are medications for which ${term} appears among the most-reported events in FDA adverse event reports. A report does not mean the drug caused the event. Report counts largely reflect how widely a drug is used and how often events are reported; they cannot be used to compare or rank drugs by risk. This list shows drugs where this event is among their top reported reactions, not every drug ever associated with it. This information is not medical advice. Do not stop or change a medication based on this data; discuss any concerns with your healthcare provider.`;

  const rows = shown.map(x => {
    const pct = (x.count / x.drug.total_reports * 100).toFixed(1);
    return `        <tr><th scope="row"><a href="/drugs/${x.drug.slug}/">${escapeHtml(displayName(x.drug.brand_name))}</a></th>` +
      `<td>${x.count.toLocaleString('en-US')}</td><td>${pct}%</td></tr>`;
  }).join('\n');

  const trimNote = total > EVENT_CAP
    ? `    <p class="event-trim">${total.toLocaleString('en-US')} drugs meet the threshold; showing the ${EVENT_CAP} most-reported.</p>\n`
    : '';
  const introText = def.intro || (gloss && gloss.definition);
  const intro = introText
    ? `    <p class="event-intro">${escapeHtml(introText)} <a href="/glossary/#${anchor}">Full definition in the glossary →</a></p>\n`
    : '';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: h1, description: metaDesc, url: canonical,
    isPartOf: { '@type': 'WebSite', name: 'PillSignal', url: SITE_URL },
  };

  const body = `
  <div class="page-header">
    <h1>${escapeHtml(h1)}</h1>
    <p>${total.toLocaleString('en-US')} medications where ${escapeHtml(term)} is among the most-reported events, ranked by number of reports.</p>
  </div>

  <div class="event-caveat"><div class="card">${escapeHtml(caveat)} Data from the <a href="https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems" target="_blank" rel="noopener noreferrer">FDA Adverse Event Monitoring System (AEMS)</a>, formerly FAERS, via OpenFDA.</div></div>

  <main>
${intro}${trimNote}    <table class="event-table">
      <caption>Medications with FDA adverse event reports of ${escapeHtml(term)}, by report count</caption>
      <thead><tr><th scope="col">Drug</th><th scope="col">Reports of this event</th><th scope="col">% of drug's total reports</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="event-back"><a href="/events/">← All adverse event pages</a></p>
  </main>`;

  return renderEventShell({ title, metaDesc, canonical, jsonLd, body });
}

function writeEventsIndexPage(idx) {
  const items = EVENT_DEFS
    .map(def => ({ def, label: eventLabel(def), count: (idx.get(def.key) || []).length }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(x => `      <li><a href="/events/${x.def.slug}/">${escapeHtml(x.label)}</a> <span class="event-idx-count">${x.count.toLocaleString('en-US')} drugs</span></li>`)
    .join('\n');
  const title     = 'Adverse Events A to Z: FDA Reports by Drug | PillSignal';
  const metaDesc  = `Browse ${EVENT_DEFS.length} common adverse events, from hair loss to insomnia, and see which drugs have the most FDA adverse event reports for each. Report counts, not causation.`;
  const canonical = `${SITE_URL}/events/`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description: metaDesc, url: canonical };
  const body = `
  <div class="page-header">
    <h1>Adverse Events by Drug</h1>
    <p>For each common adverse event, the medications with the most FDA adverse event reports. Report counts reflect reporting volume, not causation or risk.</p>
  </div>
  <main>
    <ul class="event-index">
${items}
    </ul>
  </main>`;
  const html = renderEventShell({ title, metaDesc, canonical, jsonLd, body, page: 'events' });
  mkdirSync(join(DOCS_DIR, 'events'), { recursive: true });
  writeFileSync(join(DOCS_DIR, 'events', 'index.html'), html, 'utf8');
  console.log(`  events/index.html — ${EVENT_DEFS.length} event pages listed`);
}

function writeEventPages(idx) {
  let n = 0;
  for (const def of EVENT_DEFS) {
    const html = renderEventPage(def, idx.get(def.key) || []);
    mkdirSync(join(DOCS_DIR, 'events', def.slug), { recursive: true });
    writeFileSync(join(DOCS_DIR, 'events', def.slug, 'index.html'), html, 'utf8');
    n++;
  }
  writeEventsIndexPage(idx);
  console.log(`  ${n} event pages written`);
}

function writeStaticPages() {
  const staticDir = join(ROOT, 'templates', 'static');
  let count = 0;
  for (const { template, output } of STATIC_PAGES) {
    const src  = readFileSync(join(staticDir, template), 'utf8');
    const page = template.startsWith('guides/') ? 'guide' : 'static';
    // Guide pages reuse the shared share row, with the guide's own title/description
    // and canonical URL (derived from the output path).
    let shareHtml = '';
    if (src.includes('{{SHARE_BUTTONS}}')) {
      const canonical = `${SITE_URL}/${output.replace(/index\.html$/, '')}`;
      const title = (src.match(/<title>([^<]*)<\/title>/) || [])[1] || 'PillSignal';
      const desc  = (src.match(/<meta name="description" content="([^"]*)"/) || [])[1] || title;
      shareHtml = renderShareButtons(desc, title, canonical);
    }
    const html = src
      .replace('{{BASE_CSS}}', BASE_CSS)
      .replace('{{SHARE_BUTTONS}}', shareHtml)
      .replace('{{SITE_HEADER}}', renderHeader(page))
      .replace('{{SITE_FOOTER}}', renderFooter());
    const dest = join(DOCS_DIR, output);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, html, 'utf8');
    count++;
  }
  console.log(`  static pages — ${count} pages written`);
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
    brand_name:   displayName(d.brand_name),
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
  const [aeRes, demoRes, outRes, trendRes, coRes] = await Promise.all([
    supabase.from('adverse_events').select('*').eq('drug_id', drugId).order('count', { ascending: false }),
    supabase.from('demographics').select('*').eq('drug_id', drugId),
    supabase.from('outcomes').select('*').eq('drug_id', drugId),
    supabase.from('trends').select('*').eq('drug_id', drugId).order('year').order('quarter'),
    supabase.from('co_reported_drugs').select('*').eq('drug_id', drugId).order('count', { ascending: false }),
  ]);
  return {
    adverseEvents: aeRes.data  ?? [],
    demographics:  demoRes.data ?? [],
    outcomes:      outRes.data  ?? [],
    trends:        trendRes.data ?? [],
    coReported:    coRes.data   ?? [],
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

  // Determine the global latest trend period (data cutoff), uniform across drugs,
  // so the yearly trend table can label the newest year "(partial)" when it is
  // not yet a complete four-quarter year.
  for (const drug of drugsWithData) {
    for (const t of detailsMap[drug.id].trends) {
      if (t.year > TREND_CUTOFF.year ||
          (t.year === TREND_CUTOFF.year && t.quarter > TREND_CUTOFF.quarter)) {
        TREND_CUTOFF = { year: t.year, quarter: t.quarter };
      }
    }
  }
  console.log(`  Trend data cutoff: ${TREND_CUTOFF.year} Q${TREND_CUTOFF.quarter}\n`);

  // Build the event -> drugs reverse index (for /events/ pages) from loaded data.
  const eventIndex = buildEventIndex(drugsWithData, detailsMap);

  // STEP 1 preview: write only /events/hair-loss/ + /events/ index, print one
  // drug page's reverse-linked AE block, then stop (no drug pages, no sitemap).
  if (process.argv.includes('--preview-events')) {
    console.log('PREVIEW MODE: writing /events/hair-loss/ and /events/ index only\n');
    const def = EVENT_BY_KEY.get('ALOPECIA');
    mkdirSync(join(DOCS_DIR, 'events', def.slug), { recursive: true });
    writeFileSync(join(DOCS_DIR, 'events', def.slug, 'index.html'),
      renderEventPage(def, eventIndex.get('ALOPECIA') || []), 'utf8');
    writeEventsIndexPage(eventIndex);
    const acc = drugsWithData.find(d => d.slug === 'accutane');
    if (acc) {
      console.log('\n----- accutane AE list block (with reverse links) -----');
      console.log(renderAeListHtml(detailsMap[acc.id].adverseEvents, displayName(acc.brand_name)));
    }
    return;
  }

  // Phase 2: compute related drugs via adverse event overlap
  console.log('Phase 2: Computing related drugs...');
  const relatedMap = computeRelatedDrugs(drugsWithData, detailsMap);
  const resolveCoReportedLink = buildCoReportedLinkIndex(drugsWithData);
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
      relatedMap[drug.id] || [],
      details.coReported,
      resolveCoReportedLink
    );

    writeDrugPage(drug.slug, html);
    generatedDrugs.push(drug);
    generated++;

    if (generated % 25 === 0) {
      console.log(`  ${generated}/${drugsWithData.length} pages written...`);
    }
  }

  console.log(`  ${generated}/${drugsWithData.length} pages written\n`);

  const { minYear, maxYear } = await fetchYearRange();

  writeBrowsePage(generatedDrugs);
  writeSitemap(generatedDrugs);
  writeRobotsTxt();
  writeDrugIndex(generatedDrugs);
  writeHomepage(generatedDrugs, minYear, maxYear);
  writeStaticPages();
  writeEventPages(eventIndex);
  writeGlossaryData();
  writeGlossaryPage();

  console.log(`\nStage 2 complete.`);
  console.log(`  Generated : ${generated} pages`);
  console.log(`  Skipped   : ${skipped} (no data)`);
  console.log(`  Output    : docs/drugs/{slug}/index.html\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
