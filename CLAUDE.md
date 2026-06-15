# CLAUDE.md — PillSignal

## Project Overview

PillSignal (pillsignal.com) is a consumer-facing website that makes FDA adverse event data accessible and understandable to regular people. When someone searches for a medication, they can see what real people have actually reported to the FDA — side effects, reactions, outcomes, demographics, and trends over time — presented in clean visualizations with plain-English context.

The data source is the OpenFDA AEMS/FAERS (FDA's Adverse Event Monitoring System, formerly the FDA Adverse Event Reporting System) API. PillSignal does not use drug label data (which is what WebMD, Drugs.com, and RxList already cover). PillSignal surfaces real-world reported events, which is a fundamentally different and underserved data set.

The goal is to become a top search result for queries like "[drug name] side effects reported," "[drug name] reactions," and "[drug name] adverse events" and monetize through Google AdSense display advertising.

## Writing Conventions

- **No em-dashes** in any PillSignal content (copy, captions, section notes, guide text, UI labels). Use a comma, a period, or restructure the sentence instead. Em-dashes include `—` (U+2014) and `–` (U+2013). Code comments are exempt.

## Legal Requirements — READ THIS FIRST

These are non-negotiable and must be followed in every piece of code, copy, and content generated for this project:

1. **Every page** must include this disclaimer (or a close variation): *"This data reflects voluntary reports submitted to the FDA's Adverse Event Monitoring System (AEMS), formerly the FDA Adverse Event Reporting System (FAERS). A report does not mean the medication caused the event. Data may be incomplete or contain errors."*
2. **Never editorialize on drug data pages.** Drug pages present numbers only — no voice, no interpretation, no commentary. The data speaks for itself. In `/guides/` editorial content, an original first-hand voice is encouraged — but only ever anchored to factual findings. "The most-reported reaction was X" is a finding and is allowed. The governing line is **judgment vs. finding**: findings, data analysis, and an editorial voice built on them are permitted in guides; but safety judgments ("dangerous," "risky," "safe," "concerning"), comparative rankings ("most dangerous"), and causation language ("caused by," "side effect of") remain strictly forbidden everywhere, including in editorial content.
3. **Never rank drugs** as "most dangerous," "worst side effects," or any comparative safety framing.
4. **Never imply causation.** Use language like "reported with," "associated reports," "events reported by patients taking," not "caused by" or "side effects of."
5. **Always link to the FDA source.** Every drug page should link to the corresponding OpenFDA query or FDA drug page so users can verify the data themselves.
6. **No medical advice.** Include a standard notice that PillSignal is not a substitute for professional medical advice and users should consult their healthcare provider.
7. **First-visit disclaimer banner.** Display a non-blocking, dismissible banner at the top of the site on first visit. Text: "PillSignal presents data from the FDA's voluntary reporting system. This data does not prove that a medication caused any adverse event. Always consult your healthcare provider about your medications." Include an "I understand" button. Use localStorage to remember dismissal so it only shows once. This must NOT be a blocking modal or interstitial — it must not prevent page content from being visible to users or search engine crawlers.
8. **Co-occurrence is never interaction.** The "Medications commonly reported with [Drug]" section shows medications named in the same reports. Never describe this as a drug interaction, a combination risk, or causation. See the Co-Reported Medications section for the fixed framing copy and rules.

## Tech Stack

- **Data source:** OpenFDA AEMS/FAERS API (https://open.fda.gov/apis/drug/event/) — FAERS became AEMS in March 2026; see Terminology section
- **Database:** Supabase (Postgres) — stores processed/aggregated data pulled from OpenFDA
- **Build scripts:** Node.js — two-stage pipeline (fetch → database, database → static HTML)
- **Frontend:** Vanilla HTML, CSS, JavaScript — no frameworks, no bundler, no build tools for the frontend
- **Typography:** Fraunces (weight 600, serif) for all headings via `--font-heading`; Source Sans 3 (weights 400 + 600, sans-serif) for body via `--font`. Loaded via Google Fonts with preconnect + `font-display:swap`. System stacks as fallback. Heading `letter-spacing` stays near 0 (not negative) to suit Fraunces's optical character. Do not use `font-weight: 800` or tight negative tracking on headings — it crushes the serif.
- **Hosting:** GitHub Pages (static files served from `/docs` directory)
- **CDN/DNS:** Cloudflare (domain: pillsignal.com, DNSSEC enabled, proxy on)
- **Email:** Cloudflare Email Routing (hello@pillsignal.com, contact@pillsignal.com)
- **Analytics:** Google Analytics (to be configured)
- **Monetization:** Google AdSense (to be added once traffic warrants)

## Architecture

### Data Pipeline

**Stage 1: Fetch (Node.js script → Supabase)**
- Script queries OpenFDA FAERS API for each drug in our drug list
- Aggregates raw event data into processed summaries: top adverse events with counts, demographic breakdowns (age, gender), outcome severity distribution, quarterly trend data
- Stores aggregated data in Supabase tables
- Designed to be run manually or on a schedule; not user-facing
- Must respect OpenFDA rate limits: 240 requests/minute with API key

**Stage 2: Generate (Supabase → static HTML)**
- Script reads processed data from Supabase
- Generates individual static HTML pages for each drug
- Generates index/listing pages, sitemap.xml, and any aggregate pages
- Output goes to `/docs` directory for GitHub Pages serving
- Each generated page is a complete, standalone HTML file with full SEO markup
- Also regenerates all static pages (about, faq, guides, contact, privacy, terms) from `templates/static/`

### Why This Architecture

- Supabase decouples data fetching from page generation — builds are fast and don't depend on FDA API availability
- Static HTML means every page is instantly indexable by search engines — no JavaScript rendering required
- GitHub Pages + Cloudflare is free, fast, and battle-tested
- Scaling from 200 drugs to 13,000+ only requires running the fetch script longer — no architectural changes

### Folder Structure

**IMPORTANT — source vs. output:**
- `templates/` is the **source of truth** for all page content. Edit files here.
- `docs/` is **build output only** — every file is overwritten by `generate-pages.js`. Never hand-edit files in `docs/` directly; changes will be lost on the next generate run.
- Static pages and guides live in `templates/static/` and are edited there.

```
pillsignal/
├── CLAUDE.md
├── .gitignore
├── .env.example                    # Template for required env vars
├── package.json
├── scripts/
│   ├── fetch-data.js               # Stage 1: OpenFDA API → Supabase
│   ├── generate-pages.js           # Stage 2: Supabase + templates → docs/
│   ├── drug-list.json              # Canonical list of 848 drugs (matches Supabase exactly)
│   ├── drug-list-removed.json      # Reference list of removed slugs (not fetched)
│   └── fetch-metadata.json         # Written by fetch-data.js; read by generate-pages.js
├── templates/
│   ├── drug-page.html              # Template for all 848 drug pages ({{SITE_HEADER}}, {{SITE_FOOTER}})
│   ├── homepage.html               # Homepage template ({{SITE_HEADER}}, {{SITE_FOOTER}}, {{STATS_BAR}})
│   └── static/                     # Source for all static/guide pages — edit these, not docs/
│       ├── about.html
│       ├── faq.html
│       ├── contact.html
│       ├── privacy.html
│       ├── terms.html
│       └── guides/
│           ├── index.html
│           ├── how-to-read-fda-adverse-event-reports.html
│           ├── what-fda-drug-reports-show.html
│           ├── how-to-report-drug-side-effect-fda.html
│           └── what-is-aems.html
├── docs/                           # BUILD OUTPUT — do not hand-edit
│   ├── index.html                  # ← generated from templates/homepage.html
│   ├── about/index.html            # ← generated from templates/static/about.html
│   ├── guides/                     # ← generated from templates/static/guides/
│   ├── drugs/                      # ← generated, one subdir per drug
│   ├── js/drug-index.json          # ← generated
│   ├── sitemap.xml                 # ← generated
│   └── robots.txt                  # ← generated
└── sql/
    └── schema.sql        # Supabase table definitions
```

## SEO Requirements

SEO is the primary growth channel. Every decision should consider search indexability.

- **Every drug page** gets a unique `<title>` tag: "[Drug Name] — Reported Side Effects & Adverse Events | PillSignal"
- **Every drug page** gets a unique `<meta name="description">` summarizing that drug's key data
- **JSON-LD structured data** on every page (Article or Dataset schema as appropriate)
- **Open Graph and Twitter Card meta tags** on every page
- **Canonical URLs** on every page
- **sitemap.xml** auto-generated by the build script, submitted to Google Search Console and Bing Webmaster Tools
- **robots.txt** allowing all crawlers
- **Internal cross-linking** between related drugs (same drug class, similar adverse event profiles)
- **Clean URLs:** `/drugs/lexapro` not `/drugs/lexapro.html` (configure via Cloudflare or .nojekyll + directory structure)
- **Fast page load:** minimal CSS, no heavy JS frameworks, optimized for Core Web Vitals
- **Mobile-first:** responsive design, passes Google's mobile-friendly test

## Drug Page Content (Per Drug)

Each drug page should include:

1. **Drug name** (brand and generic) as H1
2. **Summary line** — e.g., "12,847 adverse event reports submitted to the FDA since [year]"
3. **Top reported adverse events** — bar chart or table showing the most frequently reported events with counts
4. **Demographic breakdown** — who is reporting (age groups, gender distribution)
5. **Outcome severity** — pie or donut chart showing distribution of outcomes (hospitalization, life-threatening, death, other serious, non-serious)
6. **Trend over time** — line chart showing report volume by quarter/year
7. **FDA disclaimer** — prominently displayed
8. **Source link** — direct link to the OpenFDA API query for this drug
9. **Related drugs** — links to other drugs in the same therapeutic class

## MVP Scope

**Phase 1 (MVP):**
- Top 200 most commonly prescribed drugs in the US
- Homepage with search functionality
- Individual drug pages with all content sections above
- Full SEO markup on every page
- Mobile-responsive design
- Dark mode support
- Legal disclaimer on every page
- robots.txt and sitemap.xml
- Google Analytics configured

**Phase 2 (Post-launch):**
- Expand to all 13,000+ drugs
- Blog/content section with data-driven articles
- Drug comparison feature (side by side, factual data only — no safety judgments)
- Email alerts for new safety signals on drugs users follow
- Google AdSense integration
- FAQ page with JSON-LD FAQPage schema

## Environment Variables

```
OPENFDA_API_KEY=         # OpenFDA API key for higher rate limits
SUPABASE_URL=            # Supabase project URL
SUPABASE_SERVICE_KEY=    # Supabase secret key (sb_secret_..., never expose client-side)
```

## Development Principles

- **Think first, build second.** Do not scaffold, generate, or create files without explicit instruction. Ask before acting.
- **No frameworks on the frontend.** Vanilla HTML, CSS, and JS only. No React, no Vue, no Tailwind, no build tools.
- **Every page is a real HTML file.** No SPA routing, no client-side rendering of main content. Search engines must be able to read all content without executing JavaScript.
- **Mobile-first responsive design.** CSS should be written mobile-first with breakpoints scaling up.
- **Dark mode from the start.** Use CSS custom properties and `prefers-color-scheme` media query, with a manual toggle and localStorage persistence.
- **Accessibility matters.** Semantic HTML, proper heading hierarchy, alt text, ARIA labels where needed, sufficient color contrast.
- **Security basics.** Never commit secrets. Use .env for all keys. Parameterized queries for any database interaction. No user-generated content in the MVP.

## Terminology: FAERS / AEMS

In March 2026, the FDA replaced FAERS (FDA Adverse Event Reporting System) with AEMS (Adverse Event Monitoring System). The underlying data and voluntary reporting process are unchanged; only the system name and infrastructure changed.

**Rules for any new copy or code:**

- **Establish the relationship once per page** using the two shared strings below — the disclaimer/notice and the footer data-source line. After those fire, do not repeat "(formerly FAERS)" anywhere else on the same page.
- **Shared disclaimer/notice:** "This data reflects voluntary reports submitted to the FDA's Adverse Event Monitoring System (AEMS), formerly the FDA Adverse Event Reporting System (FAERS). A report does not mean the medication caused the event. Data may be incomplete or contain errors." Link: `https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems` — link text "Learn more about AEMS."
- **Shared footer data-source line:** "Data sourced from the [FDA's Adverse Event Monitoring System (AEMS)](https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems), formerly FAERS, via OpenFDA."
- **Historical/data-accurate references:** Keep FAERS when accurately naming the legacy system or the historical data (e.g., "FAERS reports from 2003–2026," "the FAERS database"). These references are correct as-is.
- **Drug page data captions:** Keep FAERS in section-note text (e.g., "in the FAERS database," "FAERS reports") — it accurately describes the data we hold and preserves the search term.
- **SEO elements:** Keep FAERS in titles, meta descriptions, OG/Twitter tags, and JSON-LD — it is the established search term. AEMS is new and has lower search volume.
- **External FDA links:** Use `https://www.fda.gov/safety/fda-adverse-event-monitoring-system-aems` (the old FAERS surveillance page 301-redirects to AEMS). Always open in new tab with `rel="noopener noreferrer"`.
- **OpenFDA API endpoints** (`api.fda.gov/drug/event.json`, `open.fda.gov/apis/drug/event/`): leave as-is — they are stable working endpoints, not branded URLs.

## GA4 Event Schema

All `gtag('event', ...)` calls use a shared generic param naming convention. Do not introduce `drug_*` param names — use the generic equivalents below.

| Event | Where fired | Key params |
|---|---|---|
| `search_result_click` | Homepage search dropdown | `item_name`, `item_slug` |
| `search_query` | Homepage search (debounced) | `search_term` |
| `related_item_click` | Drug page → related drugs section | `source_item` (current drug), `target_item` (clicked drug) |
| `fda_source_click` | Drug page → FDA/OpenFDA links | `item_name`, `destination_url` |
| `dark_mode_toggle` | Any page theme toggle | `new_theme` |
| `browse_letter_click` | Browse A–Z page letter nav | `letter` |
| `faq_open` | FAQ page → expanding a `<details>` item | `question_text` (first 50 chars of the question) |
| `share` | Drug page → any share button | `method` — one of: `x`, `reddit`, `facebook`, `bluesky`, `email`, `copy_link` |

## Shared Header and Footer

The site header (banner + nav + dark-mode toggle) and footer (AEMS data source, footer nav, X link) are defined once in `renderHeader(page)` and `renderFooter()` in `scripts/generate-pages.js`. Every page type — drug pages, browse, homepage, and all 10 static pages — receives its header and footer from these functions via `{{SITE_HEADER}}` / `{{SITE_FOOTER}}` placeholders in the templates.

**To change the header or footer:** edit the functions in `generate-pages.js`, then run `node scripts/generate-pages.js`. All 860+ pages update in one run.

`renderHeader(page)` nav variants:
- `'drug'` — Browse all + ← Search (drug detail pages)
- `'browse'` — ← Search only (browse listing page)
- `'home'` or any static/guide page — Browse all only

## Drug Name Display

`displayName()` in `scripts/generate-pages.js` is the **single source of truth** for how a drug's brand name is displayed anywhere on the site: the homepage search index (`drug-index.json`), the browse page, the drug-page H1 and `<title>`, and the related-drugs and co-reported lists. Do not title-case brand names at any individual call site; always route through `displayName()` so search, browse, and drug pages render an identical name for the same drug.

Plain title-casing mangles two things, so `displayName()` layers allowlists on top of it:
- **Suffix tokens** kept uppercase (`XR`, `ER`, `SR`, `CR`, `DR`, `IR`, `XL`, `XT`, `MR`, `LA`, `CD`, `HCL`, `HCT`, `ODT`, `DS`, `EC`, `PM`, `HFA`, `DPI`, `MDI`, `SL`) so `ADDERALL XR` renders `Adderall XR`, not `Adderall Xr`.
- **Internal-capital brand overrides** (`NuvaRing`, `ParaGard`, `AndroGel`, `OxyContin`, `DiaBeta`, `ProAir`), plus whole-name overrides (e.g. `PARAGARD T 380A` to `ParaGard T 380A`) so intentional capitals survive.

Both allowlists live in `displayName()`. **When a new drug needs special casing (a new dosage suffix, an internal-capital brand, or a model-code name), extend the allowlists there**, not at the call sites. Names that already contain lowercase letters are trusted as intentionally cased and left alone.

## Co-Reported Medications

Each drug page can show a "Medications commonly reported with [Drug]" section: the medications most frequently named in the same FAERS/AEMS reports as the drug, by normalized openfda generic name.

**Framing rule (non-negotiable, legal):** this is **co-occurrence only**. Copy must never imply drug interaction, causation, combined risk, or that any combination is unsafe. The section presents which medications appeared in the same reports, nothing more. The lead sentence, list, and caption are fixed editorial copy in `renderCoReportedHtml()`; do not reword them to add interpretation. This sits under the same guardrails as the rest of the site (see Legal Requirements: no causation, no ranking, no medical advice).

**Data source:** `&count=patient.drug.openfda.generic_name.exact` scoped to the drug's resolved FAERS search (same brand-first, generic-fallback construction the other fetchers use). This field is chosen over `medicinalproduct` because it uses normalized generic vocabulary that matches our internal pages, but it is fragmented into dose/form/salt variants and must be canonicalized.

**Storage:** `co_reported_drugs` table (`drug_id`, `name`, `count`), one row per stored co-reported medication, up to 5 per drug. Written by `fetch-data.js` (cleared and re-inserted on every fetch, same as the other detail tables). The stored `name` is already canonicalized; `count` is the representative report count.

**Canonicalization (in `fetch-data.js`, `canonicalizeMed()`):** collapses dose/form/salt variants of the same ingredient to one plain, patient-recognizable name. It strips dosage tokens (`200MG`, `81 MG`), release abbreviations (`ER`, `XR`, `SR`, etc.), dosage-form words (`TABLET`, `CAPSULE`, `ORAL`, `FILM-COATED`, `EXTENDED RELEASE`, etc.), and **salt/ester suffixes** (`SODIUM`, `MAGNESIUM`, `SULFATE`, `HYDROCHLORIDE`, `OXALATE`, `PROPIONATE`, etc.) so `albuterol sulfate` becomes `albuterol` and `omeprazole magnesium` becomes `omeprazole`. Variants that collapse to the same canonical name are merged, keeping the **highest count** as the representative. Misspellings of OTHER drugs that survive canonicalization (e.g. a stray `ibupfrofen` on an unrelated page) fall through to plain text, we do not fuzzy-match co-reported names against the full drug list. Misspellings of the drug's OWN name are caught by fuzzy self-exclusion (see below).

**Stoplist:** non-drug descriptors are dropped entirely: `pain reliever`, `vitamin`, `multivitamin`, `supplement`, `herbal`, `unknown`, and any purely numeric entry.

**Self-exclusion:** the drug's own generic must never appear in its own co-reported list, including misspellings of it. Three layers:
- **Exact match.** Seed from the brand name and list generic, plus any generic appearing in **≥50% of the drug's own reports** (that is the drug itself, e.g. Mirena → levonorgestrel). A **≥90% of reports** cutoff is the fallback guard. (The ≥50%/≥90% count thresholds are intentionally untouched.)
- **Fuzzy match (own-name misspellings).** Tokens from the **brand and generic only** seed a fuzzy set; any candidate within Levenshtein distance **≤ 2** of a self-alias token is excluded, guarded so it cannot drop a different-but-similar drug: candidate length must be within **20%** of the alias token, and alias tokens shorter than **5** characters are not fuzzy-matched. This is what drops Lexapro's `ESCITSLOPRAM` (distance 1 from `escitalopram`).
- **Why only brand/generic seed the fuzzy set.** The ≥50% count-capture can grab a *different* drug that merely co-occurs in most reports (e.g. another PPI in Nexium reports). Those go to exact self-exclusion only, never the fuzzy set, or they would fuzzily drop legitimate neighbors (lansoprazole capture dropping pantoprazole). Populating `generic_name` for brand-only drugs would extend fuzzy protection to them (see Backlog).

**Noise floor:** a co-reported medication qualifies only if its count is at least `max(25, 1% of the drug's total_reports)`. A drug must have **at least 3** qualifying medications or the section is **omitted entirely** for that drug. The 1% relative floor is intentional: high-volume drugs with diffuse co-reporting (e.g. Mirena) are omitted rather than padded with weak, thin-looking entries.

**Internal links:** resolved at **generate time** (not stored in the DB) against the in-memory drug list, matching on `slug`, `brand_name`, and `generic_name`. A co-reported medication links to its page when we have one and renders as plain text when we do not. The list uses a dedicated `.co-reported-list` class (not `.related-list`) so it does not fire the `related_item_click` GA event.

## Data Refresh Procedure

Run this checklist in order every time the dataset is refreshed. Deviating from the order can create drift between the list, the database, and the live pages.

1. **Verify the list is canonical.** `scripts/drug-list.json` must contain exactly the drugs you want live — no more, no less. The list and Supabase are the same set after reconciliation (June 2026). Before adding new drugs, add them to `drug-list.json`. Removed slugs go to `scripts/drug-list-removed.json` for reference.

2. **Fetch.** `node scripts/fetch-data.js` — queries OpenFDA for every entry in `drug-list.json` and upserts results into Supabase. Watch for `⚠ GENERIC FALLBACK` warnings in the output; any drug that matches only via `generic_name` will produce a duplicate-content page and should be removed from `drug-list.json` unless it is a true canonical generic (ibuprofen, acetaminophen, etc.). Fetch writes `scripts/fetch-metadata.json` automatically with the timestamp.

3. **Generate.** `node scripts/generate-pages.js` — reads Supabase and writes all static HTML to `docs/`. Reads `scripts/fetch-metadata.json` to inject "Data last updated: [Month YYYY]" into every drug page and set `dateModified` in JSON-LD. Run immediately after fetch.

4. **Re-pull aggregate stats for guides.** After a refresh, the figures in `docs/guides/what-fda-drug-reports-show/index.html` and the homepage stats bar will be stale. Run `node scripts/aggregate-stats.js` to get fresh totals and update the guide manually. Key figures to check: total reports, Drug Ineffective count and %, sex split, age distribution, outcome distribution, and per-year trend data.

5. **Commit and push.** Stage and commit all changes under `docs/`, `scripts/drug-list.json`, `scripts/drug-list-removed.json`, and `scripts/fetch-metadata.json`. Never commit `.env`. Push to `main`; GitHub Pages serves automatically.

## Deployment

- Commit and push to `main` branch
- GitHub Pages serves from the `/docs` directory
- After deployment, purge Cloudflare cache if needed
- Verify new/updated pages in Google Search Console

## Backlog

- **Populate `generic_name` for brand-only drugs (deferred, needs a dedicated session).** 645 of the drugs have no stored generic, which limits fuzzy self-exclusion for them (only brand seeds the fuzzy set). An assessment querying OpenFDA found the data is only ~50% cleanly inferable: about 324 have a clean dominant generic (≤3 tokens, ≥50% share), but the rest are fragmented (correct generic under 50% share, e.g. Abraxane → paclitaxel at 39%), genuine combination products (Adderall XR), biosimilar-suffix noise (`adalimumab-aaty`, `erenumab-aooe`), or brand==generic redundancies (`acetaminophen`). Safe population needs per-case rules (collapse fragments, handle combinations, strip biosimilar suffixes, skip brand==generic), not a blind top-term write to the canonical `drug-list.json`. Do this in its own session, then a full re-fetch.
- **Title-separator em-dashes (site-wide pass).** `<title>`, `og:title`, `twitter:title`, and the homepage/guides sr-only `<h1>` still use the `PillSignal — ...` em-dash separator, and every drug-page title uses `Brand — Adverse Events | PillSignal`. These were intentionally left during the homepage/guides em-dash sweep because changing them piecemeal would be inconsistent. A future pass should decide on a consistent separator (and update `buildPageTitle()` in `generate-pages.js` plus the static title tags) site-wide in one commit.
