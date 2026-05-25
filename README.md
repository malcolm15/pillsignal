# PillSignal

**FDA adverse event reports, made accessible.**

PillSignal makes data from the FDA's Adverse Event Reporting System (FAERS) understandable to regular people. Search any medication and see what patients and healthcare professionals have actually reported to the FDA — reactions, outcomes, demographics, and trends over time — presented in plain English with clear visualizations.

This is different from what WebMD or Drugs.com provide. Those sites show drug label information. PillSignal shows real-world reported events from the public FAERS database.

## Important Disclaimer

PillSignal presents voluntary reports submitted to the FDA. **A report does not mean a medication caused any adverse event.** This data may be incomplete or contain errors. PillSignal is not a substitute for professional medical advice. Always consult your healthcare provider about your medications.

## Status

Under active development. Not yet live.

## Tech Stack

- **Data:** [OpenFDA FAERS API](https://open.fda.gov/apis/drug/event/)
- **Database:** Supabase (Postgres)
- **Build scripts:** Node.js
- **Frontend:** Vanilla HTML, CSS, JavaScript — no frameworks
- **Hosting:** GitHub Pages + Cloudflare

## How It Works

1. A Node.js script pulls adverse event data from the OpenFDA API and stores aggregated summaries in Supabase.
2. A second script reads from Supabase and generates static HTML pages — one per drug.
3. Static files are served from the `/docs` directory via GitHub Pages.

## Data Source

All data is sourced from the [FDA Adverse Event Reporting System (FAERS)](https://www.fda.gov/drugs/questions-and-answers-fdas-adverse-event-reporting-system-faers/fda-adverse-event-reporting-system-faers-public-dashboard) via the [OpenFDA API](https://open.fda.gov/). PillSignal is not affiliated with the FDA.
