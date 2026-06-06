import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function fetchAll(table, select, filters = []) {
  let from = 0, chunk = 1000, rows = [];
  while (true) {
    let q = sb.from(table).select(select).range(from, from + chunk - 1);
    for (const [col, op, val] of filters) {
      if (op === 'eq') q = q.eq(col, val);
      if (op === 'lte') q = q.lte(col, val);
    }
    const { data, error } = await q;
    if (error) { console.error(`Error on ${table}:`, error.message); break; }
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < chunk) break;
    from += chunk;
  }
  return rows;
}

async function run() {
  // 1. Total scope — paginate drugs
  console.log('\n=== 1. TOTAL SCOPE ===');
  const drugs = await fetchAll('drugs', 'brand_name,total_reports,first_report_date');
  const totalReports = drugs.reduce((s, r) => s + (r.total_reports || 0), 0);
  const dates = drugs.map(r => r.first_report_date).filter(Boolean).sort();
  console.log(`Total drugs: ${drugs.length}`);
  console.log(`Sum of total_reports: ${totalReports.toLocaleString()}`);
  console.log(`Earliest first_report_date: ${dates[0] ?? 'n/a'}`);
  console.log(`Latest first_report_date: ${dates[dates.length - 1] ?? 'n/a'}`);

  // 2. Top 15 drugs by report count
  console.log('\n=== 2. TOP 15 DRUGS BY REPORT COUNT ===');
  const sorted = [...drugs].sort((a, b) => (b.total_reports || 0) - (a.total_reports || 0));
  sorted.slice(0, 15).forEach((d, i) =>
    console.log(`${i + 1}. ${d.brand_name}: ${(d.total_reports || 0).toLocaleString()}`));

  // 3. Concentration
  console.log('\n=== 3. CONCENTRATION ===');
  const grand = totalReports;
  const top10sum = sorted.slice(0, 10).reduce((s, r) => s + (r.total_reports || 0), 0);
  const top50sum = sorted.slice(0, 50).reduce((s, r) => s + (r.total_reports || 0), 0);
  console.log(`Top 10 share: ${((top10sum / grand) * 100).toFixed(1)}%  (${top10sum.toLocaleString()} / ${grand.toLocaleString()})`);
  console.log(`Top 50 share: ${((top50sum / grand) * 100).toFixed(1)}%  (${top50sum.toLocaleString()} / ${grand.toLocaleString()})`);

  // 4. Top 20 adverse events site-wide
  console.log('\n=== 4. TOP 20 ADVERSE EVENTS SITE-WIDE ===');
  const aeRows = await fetchAll('adverse_events', 'event_name,count');
  const evTotals = {};
  for (const r of aeRows) evTotals[r.event_name] = (evTotals[r.event_name] || 0) + (r.count || 0);
  Object.entries(evTotals).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([name, count], i) =>
    console.log(`${i + 1}. ${name}: ${count.toLocaleString()}`));

  // 5. Drugs with "Drug Ineffective" in top 3 by count (no rank col — compute per drug)
  console.log('\n=== 5. DRUGS WITH "DRUG INEFFECTIVE" IN TOP 3 ===');
  // Group all AE rows by drug_id, rank by count desc, check if DI is in top 3
  const { data: drugIdMap } = await sb.from('drugs').select('id,slug');
  const aeWithId = await fetchAll('adverse_events', 'drug_id,event_name,count');
  const byDrug = {};
  for (const r of aeWithId) {
    if (!byDrug[r.drug_id]) byDrug[r.drug_id] = [];
    byDrug[r.drug_id].push(r);
  }
  let diCount = 0;
  for (const [did, events] of Object.entries(byDrug)) {
    const top3 = events.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 3);
    if (top3.some(e => e.event_name.toUpperCase() === 'DRUG INEFFECTIVE')) diCount++;
  }
  console.log(`Count: ${diCount}`);
  console.log(`Percentage: ${((diCount / drugs.length) * 100).toFixed(1)}%`);

  // 6. Sex demographics aggregate — column is "value" not "dimension_value"
  console.log('\n=== 6. SEX DEMOGRAPHICS (AGGREGATE) ===');
  const sexRows = await fetchAll('demographics', 'value,count', [['dimension', 'eq', 'sex']]);
  const bySex = {};
  for (const r of sexRows) bySex[r.value] = (bySex[r.value] || 0) + (r.count || 0);
  const sexTotal = Object.values(bySex).reduce((s, v) => s + v, 0);
  Object.entries(bySex).sort((a, b) => b[1] - a[1]).forEach(([val, count]) =>
    console.log(`${val}: ${count.toLocaleString()} (${((count / sexTotal) * 100).toFixed(1)}%)`));
  console.log(`Total: ${sexTotal.toLocaleString()}`);

  // 7. Age demographics aggregate
  console.log('\n=== 7. AGE DEMOGRAPHICS (AGGREGATE) ===');
  const ageRows = await fetchAll('demographics', 'value,count', [['dimension', 'eq', 'age']]);
  const byAge = {};
  for (const r of ageRows) byAge[r.value] = (byAge[r.value] || 0) + (r.count || 0);
  const ageTotal = Object.values(byAge).reduce((s, v) => s + v, 0);
  const ageOrder = ['0-17', '18-29', '30-44', '45-59', '60-74', '75+', 'Unknown'];
  const ageKeys = ageOrder.filter(k => byAge[k])
    .concat(Object.keys(byAge).filter(k => !ageOrder.includes(k)).sort());
  ageKeys.forEach(val => {
    const count = byAge[val] || 0;
    console.log(`${val}: ${count.toLocaleString()} (${((count / ageTotal) * 100).toFixed(1)}%)`);
  });
  console.log(`Total: ${ageTotal.toLocaleString()}`);

  // 8. Outcomes aggregate — column is "outcome" not "outcome_type"
  console.log('\n=== 8. OUTCOMES (AGGREGATE) ===');
  const outcomeRows = await fetchAll('outcomes', 'outcome,count');
  const byOutcome = {};
  for (const r of outcomeRows) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + (r.count || 0);
  const outcomeTotal = Object.values(byOutcome).reduce((s, v) => s + v, 0);
  Object.entries(byOutcome).sort((a, b) => b[1] - a[1]).forEach(([type, count]) =>
    console.log(`${type}: ${count.toLocaleString()} (${((count / outcomeTotal) * 100).toFixed(1)}%)`));
  console.log(`Total outcome records: ${outcomeTotal.toLocaleString()}`);

  // 9. Report volume by year — columns: year, quarter, count
  console.log('\n=== 9. REPORT VOLUME BY YEAR ===');
  const trendRows = await fetchAll('trends', 'year,count');
  const byYear = {};
  for (const r of trendRows) {
    const yr = r.year?.toString() ?? 'Unknown';
    byYear[yr] = (byYear[yr] || 0) + (r.count || 0);
  }
  Object.entries(byYear).sort((a, b) => a[0].localeCompare(b[0])).forEach(([year, count]) =>
    console.log(`${year}: ${count.toLocaleString()}`));

  console.log('\n=== DONE ===');
}

run().catch(console.error);
