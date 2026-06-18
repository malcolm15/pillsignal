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

function renderHeader(page = 'default') {
  const navBrowse = `<a href="/drugs/" class="header-link">Browse all</a>`;
  const navSearch = `<a href="/" class="header-link">← Search</a>`;

  const navLinks = page === 'drug'
    ? `${navBrowse}\n        ${navSearch}`
    : page === 'browse'
    ? navSearch
    : navBrowse;

  return `  <div id="disclaimer-banner" role="note" aria-label="Site disclaimer">
    <div class="banner-inner">
      <p>PillSignal presents data from the FDA's voluntary reporting system. This data does not prove that a medication caused any adverse event. Always consult your healthcare provider about your medications.</p>
      <button id="banner-btn" type="button">I understand</button>
    </div>
  </div>

  <header class="site-header">
    <div class="inner">
      <a href="/" class="logo">PillSignal</a>
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
    <p>Data sourced from the <a href="https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems" target="_blank" rel="noopener noreferrer">FDA's Adverse Event Monitoring System (AEMS)</a>, formerly FAERS, via OpenFDA. PillSignal is not affiliated with the FDA.</p>
    <nav class="footer-nav" aria-label="Site links">
      <a href="/guides/">Guides</a>
      <a href="/glossary/">Glossary</a>
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
  const CLAUSE = ' for demographics, outcomes, and trends';
  const base = (g, clause, ev) =>
    `${brandName}${g}: explore ${reports} FDA adverse event reports${clause ? CLAUSE : ''}.${ev}`;

  // Richest first; drop the descriptive clause, then the event, then the generic
  // to stay within 160. The first candidate that fits is the longest that fits.
  const candidates = [
    base(gen, true,  evClause),   // generic + clause + event (target 140-160)
    base(gen, false, evClause),   // drop clause, keep generic + event
    base(gen, true,  ''),         // drop event, keep generic + clause
    base(gen, false, ''),         // generic only
    base('',  true,  evClause),   // drop generic, keep clause + event
    base('',  false, evClause),   // brand + event
    base('',  true,  ''),         // brand + clause
    base('',  false, ''),         // brand only
  ];
  const fit = candidates.find(c => c.length <= 160);
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

function renderShareButtons(brandName, totalReports, canonicalUrl) {
  const reportsFormatted = Number(totalReports).toLocaleString('en-US');
  const shareText  = encodeURIComponent(`${brandName} has had ${reportsFormatted} adverse event reports submitted to the FDA. See the full breakdown on PillSignal.`);
  const shareTitle = encodeURIComponent(`${brandName} — FDA Adverse Event Data | PillSignal`);
  const encUrl     = encodeURIComponent(canonicalUrl);

  const twitterUrl  = `https://x.com/intent/tweet?url=${encUrl}&text=${shareText}`;
  const redditUrl   = `https://reddit.com/submit?url=${encUrl}&title=${shareTitle}`;
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`;
  const blueskyUrl  = `https://bsky.app/intent/compose?text=${encodeURIComponent(`${brandName} has had ${reportsFormatted} adverse event reports submitted to the FDA. See the full breakdown on PillSignal.\n${canonicalUrl}`)}`;
  const emailUrl    = `mailto:?subject=${shareTitle}&body=${shareText}%0A%0A${encUrl}`;

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
    const g = GLOSSARY_BY_KEY.get(String(e.event_name).toUpperCase().trim());
    if (g) {
      const slug = slugifyName(g.display);
      return `        <li class="ae-item"><details class="ae-term">` +
        `<summary><span class="ae-name">${escapeHtml(g.display)}</span> ${count}</summary>` +
        `<div class="ae-def"><p>${escapeHtml(g.definition)}</p>` +
        `<a href="/glossary/#${slug}">Full definition in the glossary →</a></div>` +
        `</details></li>`;
    }
    return `        <li class="ae-item ae-item--plain">` +
      `<span class="ae-name">${escapeHtml(toTitleCase(e.event_name))}</span> ${count}</li>`;
  }).join('\n');
  return `<ul class="ae-list" aria-label="Top reported adverse events for ${escapeHtml(brandName)}">\n${items}\n      </ul>`;
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
    .replaceAll('{{AE_LIST_HTML}}',         renderAeListHtml(adverseEvents, brandName))
    .replaceAll('{{SEX_DATA_JSON}}',        safeJson(sexData))
    .replaceAll('{{AGE_DATA_JSON}}',        safeJson(ageData))
    .replaceAll('{{OUTCOMES_JSON}}',        safeJson(outcomesData))
    .replaceAll('{{TRENDS_JSON}}',          safeJson(trendsData))
    .replaceAll('{{CO_REPORTED_HTML}}',     renderCoReportedHtml(coReported, brandName, resolveLink))
    .replaceAll('{{RELATED_DRUGS_HTML}}',   renderRelatedDrugsHtml(relatedDrugs))
    .replaceAll('{{SHARE_BUTTONS}}',        renderShareButtons(brandName, totalReports, canonicalUrl))
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

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    staticUrls + '\n' + drugUrls + `\n</urlset>`;

  writeFileSync(join(DOCS_DIR, 'sitemap.xml'), xml, 'utf8');
  console.log(`  sitemap.xml  — ${drugs.length} drug URLs + 13 static pages`);
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
      --font: "Source Sans 3", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-heading: "Fraunces", Georgia, serif;
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
    h1, h2, h3 { font-family: var(--font-heading); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: var(--c-surface); } ::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

    /* Banner */
    #disclaimer-banner { background: var(--c-banner-bg); color: var(--c-banner-text); font-size: 0.875rem; line-height: 1.5; }
    .banner-seen #disclaimer-banner { display: none; }
    .banner-inner { max-width: 900px; margin: 0 auto; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .banner-inner p { flex: 1; min-width: 200px; }
    #banner-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--c-banner-border); color: var(--c-banner-text); padding: 0.3rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-family: var(--font); white-space: nowrap; transition: background 0.15s; }
    #banner-btn:hover { background: var(--c-banner-btn-hover); }

    /* Header */
    .site-header { position: sticky; top: 0; z-index: 100; border-bottom: 1px solid var(--c-border); padding: 0.875rem 1rem; background: var(--c-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
    .site-header .inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 1.25rem; font-weight: 600; font-family: var(--font-heading); color: var(--c-primary); letter-spacing: 0; }
    .logo:hover { text-decoration: none; color: var(--c-primary-hover); }
    .header-actions { display: flex; align-items: center; gap: 0.75rem; }
    .header-link { font-size: 0.875rem; color: var(--c-text-muted); }
    .theme-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: none; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; color: var(--c-text-muted); padding: 0; flex-shrink: 0; transition: color 0.15s, border-color 0.15s, background 0.15s; }
    .theme-toggle:hover { color: var(--c-primary); border-color: var(--c-primary); background: var(--c-primary-light); }
    [data-theme="light"] .icon-sun { display: none; }
    [data-theme="dark"]  .icon-moon { display: none; }

    /* Page header */
    .page-header { padding: 2rem 1rem 1.5rem; max-width: 900px; margin: 0 auto; }
    .page-header h1 { font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 600; letter-spacing: 0; margin-bottom: 0.3rem; }
    .page-header p { color: var(--c-text-muted); font-size: 0.95rem; }

    /* Letter nav */
    .lnav { position: sticky; top: 3.75rem; z-index: 90; background: var(--c-bg); border-bottom: 1px solid var(--c-border); padding: 0.5rem 1rem; display: flex; flex-wrap: wrap; gap: 2px; max-width: 100%; }
    .lnav-inner { max-width: 900px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
    .lnav-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; font-size: 0.8rem; font-weight: 600; border-radius: 4px; }
    .lnav-item--on { color: var(--c-primary); } .lnav-item--on:hover { background: var(--c-primary-light); text-decoration: none; }
    .lnav-item--off { color: var(--c-border); cursor: default; }

    /* Browse list */
    main { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .letter-section { margin-bottom: 2rem; }
    .letter-heading { font-size: 1.5rem; font-weight: 600; color: var(--c-primary); letter-spacing: 0; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 2px solid var(--c-primary-light); }
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
    @media (min-width: 640px) { .site-footer { font-size: 0.875rem; } }
    .footer-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem; }
    .footer-x-link { display: inline-flex; align-items: center; justify-content: center; margin-top: 0.6rem; color: var(--c-text-muted); transition: color 0.15s; }
    .footer-x-link:hover { color: var(--c-primary); }

    /* Back to top */
    #back-to-top { position: fixed; bottom: 1.5rem; right: 1.5rem; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--c-border); background: rgba(255,255,255,0.75); color: var(--c-text-muted); font-size: 1.1rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.25s, background 0.15s, color 0.15s; z-index: 100; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    [data-theme="dark"] #back-to-top { background: rgba(30,41,59,0.75); }
    #back-to-top.visible { opacity: 1; pointer-events: auto; }
    #back-to-top:hover { background: var(--c-primary-light); color: var(--c-primary); border-color: var(--c-primary); }
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

  const pageTitle = 'Adverse Event Glossary: Plain-Language Definitions | PillSignal';
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
    :root, [data-theme="light"] {
      --c-bg: #ffffff; --c-surface: #f9fafb; --c-border: #e5e7eb;
      --c-text: #1a1a2e; --c-text-muted: #5a5a6e;
      --c-primary: #00A67E; --c-primary-hover: #008F6B; --c-primary-light: #E6F9F1;
      --c-banner-bg: #FFF9F0; --c-banner-text: #6B4E30;
      --c-banner-border: rgba(107,78,48,0.3); --c-banner-btn-hover: rgba(0,0,0,0.05);
      --font: "Source Sans 3", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-heading: "Fraunces", Georgia, serif;
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
    h1, h2, h3 { font-family: var(--font-heading); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: var(--c-surface); } ::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

    /* Banner */
    #disclaimer-banner { background: var(--c-banner-bg); color: var(--c-banner-text); font-size: 0.875rem; line-height: 1.5; }
    .banner-seen #disclaimer-banner { display: none; }
    .banner-inner { max-width: 900px; margin: 0 auto; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .banner-inner p { flex: 1; min-width: 200px; }
    #banner-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--c-banner-border); color: var(--c-banner-text); padding: 0.3rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-family: var(--font); white-space: nowrap; transition: background 0.15s; }
    #banner-btn:hover { background: var(--c-banner-btn-hover); }

    /* Header */
    .site-header { position: sticky; top: 0; z-index: 100; border-bottom: 1px solid var(--c-border); padding: 0.875rem 1rem; background: var(--c-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
    .site-header .inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 1.25rem; font-weight: 600; font-family: var(--font-heading); color: var(--c-primary); letter-spacing: 0; }
    .logo:hover { text-decoration: none; color: var(--c-primary-hover); }
    .header-actions { display: flex; align-items: center; gap: 0.75rem; }
    .header-link { font-size: 0.875rem; color: var(--c-text-muted); }
    .theme-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: none; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; color: var(--c-text-muted); padding: 0; flex-shrink: 0; transition: color 0.15s, border-color 0.15s, background 0.15s; }
    .theme-toggle:hover { color: var(--c-primary); border-color: var(--c-primary); background: var(--c-primary-light); }
    [data-theme="light"] .icon-sun { display: none; }
    [data-theme="dark"]  .icon-moon { display: none; }

    /* Page header */
    .page-header { padding: 2rem 1rem 1rem; max-width: 760px; margin: 0 auto; }
    .page-header h1 { font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 600; letter-spacing: 0; margin-bottom: 0.3rem; }
    .page-header p { color: var(--c-text-muted); font-size: 0.95rem; }

    /* Caveat */
    .gloss-caveat { max-width: 760px; margin: 0 auto 0.5rem; padding: 0 1rem; }
    .gloss-caveat .card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 1rem 1.25rem; font-size: 0.9rem; color: var(--c-text-muted); }

    /* Letter nav */
    .lnav { position: sticky; top: 3.75rem; z-index: 90; background: var(--c-bg); border-bottom: 1px solid var(--c-border); padding: 0.5rem 1rem; }
    .lnav-inner { max-width: 760px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
    .lnav-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; font-size: 0.8rem; font-weight: 600; border-radius: 4px; }
    .lnav-item--on { color: var(--c-primary); } .lnav-item--on:hover { background: var(--c-primary-light); text-decoration: none; }
    .lnav-item--off { color: var(--c-border); cursor: default; }

    /* Glossary list */
    main { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .gloss-section { margin-bottom: 2rem; }
    .gloss-letter { font-size: 1.5rem; font-weight: 600; color: var(--c-primary); letter-spacing: 0; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 2px solid var(--c-primary-light); scroll-margin-top: 5rem; }
    .gloss-list { margin: 0; }
    .gloss-term { font-weight: 600; font-size: 1.05rem; margin-top: 1rem; scroll-margin-top: 5rem; }
    .gloss-term:target { color: var(--c-primary); }
    .gloss-def { color: var(--c-text); margin: 0.15rem 0 0; padding-bottom: 0.75rem; border-bottom: 1px solid var(--c-border); }

    /* Footer */
    .site-footer { border-top: 1px solid var(--c-border); padding: 1.5rem 1rem; text-align: center; font-size: 0.8rem; color: var(--c-text-muted); background: var(--c-bg); }
    .site-footer a { color: var(--c-text-muted); }
    .site-footer a:hover { color: var(--c-primary); text-decoration: none; }
    @media (min-width: 640px) { .site-footer { font-size: 0.875rem; } }
    .footer-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem; }
    .footer-x-link { display: inline-flex; align-items: center; justify-content: center; margin-top: 0.6rem; color: var(--c-text-muted); transition: color 0.15s; }
    .footer-x-link:hover { color: var(--c-primary); }

    /* Back to top */
    #back-to-top { position: fixed; bottom: 1.5rem; right: 1.5rem; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--c-border); background: rgba(255,255,255,0.75); color: var(--c-text-muted); font-size: 1.1rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.25s, background 0.15s, color 0.15s; z-index: 100; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    [data-theme="dark"] #back-to-top { background: rgba(30,41,59,0.75); }
    #back-to-top.visible { opacity: 1; pointer-events: auto; }
    #back-to-top:hover { background: var(--c-primary-light); color: var(--c-primary); border-color: var(--c-primary); }
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

function writeStaticPages() {
  const staticDir = join(ROOT, 'templates', 'static');
  let count = 0;
  for (const { template, output } of STATIC_PAGES) {
    const src  = readFileSync(join(staticDir, template), 'utf8');
    const page = template.startsWith('guides/') ? 'guide' : 'static';
    const html = src
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
