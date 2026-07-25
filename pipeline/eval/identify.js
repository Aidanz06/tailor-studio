#!/usr/bin/env node
/*
 * AI identification eval harness (docs/DIAGNOSIS-AND-TEST-SUITE.md §B).
 * Scores extractAttributes() against labeled fixtures and reports per-field
 * accuracy + the hard NWT-never-Used rule. Mirrors the clustering-gate style:
 * offline-friendly, JSON output, an optional pass/fail gate.
 *
 * Fixtures: pipeline/fixtures/identification/<case>/
 *   expected.json         ground truth (see the README)
 *   sample_response.json  a canned extractAttributes output (for --dry-run)
 *   *.jpg|*.png|*.webp     the item's photos (used by the LIVE run)
 *
 * Usage:
 *   node pipeline/eval/identify.js --dry-run          # no API key, uses sample_response.json
 *   node pipeline/eval/identify.js                    # LIVE: real extractAttributes (needs ANTHROPIC_API_KEY + real photos)
 *   node pipeline/eval/identify.js --runs=5           # LIVE stability (N runs per case)
 *   node pipeline/eval/identify.js --gate             # exit 1 if the gate fails (for CI-style checks)
 *   node pipeline/eval/identify.js --json             # machine-readable
 *   node pipeline/eval/identify.js --case=nike-dunk-low
 */

const fs = require('fs');
const path = require('path');
const { scoreCase, aggregate, gate } = require('./score');

const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'identification');
const IMG_RE = /\.(jpe?g|png|webp)$/i;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.split('=')[1] : d; };
const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const DO_GATE = has('--gate');
const RUNS = Math.max(1, Number(val('--runs', DRY ? 1 : 1)));
const ONLY = val('--case', null);

function loadCases() {
  if (!fs.existsSync(FIX_DIR)) return [];
  return fs.readdirSync(FIX_DIR)
    .filter((n) => fs.statSync(path.join(FIX_DIR, n)).isDirectory())
    .filter((n) => !ONLY || n === ONLY)
    .map((name) => {
      const dir = path.join(FIX_DIR, name);
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
      const photos = fs.readdirSync(dir).filter((f) => IMG_RE.test(f)).map((f) => path.join(dir, f));
      return { name, dir, expected, photos };
    })
    .filter((c) => c.expected);
}

async function actualFor(c) {
  if (DRY) {
    const p = path.join(c.dir, 'sample_response.json');
    if (!fs.existsSync(p)) throw new Error(`${c.name}: --dry-run needs sample_response.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  if (!c.photos.length) throw new Error(`${c.name}: no photos to run LIVE — add real item photos or use --dry-run`);
  const { extractAttributes } = require('../vision'); // lazy: only LIVE needs the SDK/key
  return extractAttributes(c.photos, { model: process.env.ATTRIBUTE_MODEL });
}

const SYMB = { pass: '✓', fail: '✗', skip: '·' };

async function main() {
  let cases = loadCases();
  if (!cases.length) { console.error(`No fixtures in ${FIX_DIR}`); process.exit(2); }

  // LIVE runs skip fixtures whose committed photos are placeholders (marked
  // `live_skip` in expected.json) — scoring the vision model on a brown
  // placeholder card would poison the accuracy numbers. Dry-run keeps them.
  const skipped = [];
  if (!DRY) {
    cases = cases.filter((c) => {
      if (c.expected.live_skip) { skipped.push(c.name); return false; }
      return true;
    });
    if (skipped.length) console.error(`[live] skipping placeholder-photo case(s): ${skipped.join(', ')}`);
    if (!cases.length) { console.error('No live-runnable fixtures (all placeholders).'); process.exit(2); }
  }

  const results = [];
  // Live-mode cost accounting (review 2026-07-17: model-default changes must be
  // measured, not assumed). extractAttributes attaches __usage/__model
  // non-enumerably; sum them so the run reports real $/item.
  const cost = { model: null, calls: 0, usd: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const c of cases) {
    // For LIVE stability, run each case RUNS times and score every run.
    for (let i = 0; i < RUNS; i++) {
      let actual;
      const t0 = Date.now();
      // Live API calls can hiccup mid-run (rate limit / 529) — retry twice with
      // backoff before giving up, so one transient doesn't discard 70+ paid calls.
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !actual; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt * attempt));
        try { actual = await actualFor(c); }
        catch (e) { lastErr = e; if (DRY) break; console.error(`[${c.name}] run ${i + 1} attempt ${attempt + 1}: ${e.message}`); }
      }
      if (!actual) { console.error(`[${c.name}] run ${i + 1}: ${lastErr.message}`); process.exit(2); }
      const wallMs = Date.now() - t0;
      if (actual.__usage) {
        const { usdFromUsage } = require('../groupingStrategy');
        cost.model = actual.__model || cost.model;
        cost.calls += 1;
        cost.usd += usdFromUsage(actual.__usage, actual.__model);
        cost.in += actual.__usage.input_tokens || 0;
        cost.out += actual.__usage.output_tokens || 0;
        cost.cacheRead += actual.__usage.cache_read_input_tokens || 0;
        cost.cacheWrite += actual.__usage.cache_creation_input_tokens || 0;
      }
      const r = scoreCase(c.expected, actual);
      results.push({ case: c.name, run: i + 1, wallMs, ...r, actual });
      if (!JSON_OUT) {
        const line = Object.entries(r.fields).map(([f, v]) => `${SYMB[v]}${f}`).join(' ');
        const tag = RUNS > 1 ? ` (run ${i + 1})` : '';
        console.log(`\n${c.name}${tag}  ${line}`);
        r.notes.forEach((n) => console.log(`    • ${n}`));
      }
    }
  }

  const agg = aggregate(results);
  const g = gate(agg);

  if (JSON_OUT) {
    // results[] carries per-case fields + wallMs + the raw `actual` attributes —
    // the sweep feeds each model's real output into the downstream comps eval.
    console.log(JSON.stringify({
      mode: DRY ? 'dry-run' : 'live', runs: RUNS,
      agg: { per: agg.per, overall: agg.overall, nwtViolations: agg.nwtViolations },
      gate: g,
      ...(cost.calls ? { cost } : {}),
      ...(skipped.length ? { skippedPlaceholderCases: skipped } : {}),
      results: results.map((r) => ({ case: r.case, run: r.run, wallMs: r.wallMs, fields: r.fields, nwtViolation: r.nwtViolation, notes: r.notes, actual: r.actual })),
    }, null, 2));
  } else {
    console.log('\n──────── summary' + (DRY ? ' (dry-run — sample_response.json, not live)' : ' (live)') + ' ────────');
    for (const f of Object.keys(agg.per)) {
      const r = agg.rate(f);
      console.log(`  ${f.padEnd(13)} ${r == null ? 'n/a' : (r * 100).toFixed(0) + '%'}  (${agg.per[f].pass}/${agg.per[f].evaluated})`);
    }
    console.log(`  overall       ${agg.overall == null ? 'n/a' : (agg.overall * 100).toFixed(0) + '%'}`);
    console.log(`  NWT→Used      ${agg.nwtViolations} violation(s)`);
    if (cost.calls) {
      console.log(
        `  cost (${cost.model})  $${cost.usd.toFixed(4)} total, $${(cost.usd / cost.calls).toFixed(4)}/item ` +
        `(${cost.calls} calls, in=${cost.in} out=${cost.out} cacheRead=${cost.cacheRead} cacheWrite=${cost.cacheWrite})`
      );
    }
    console.log(`\n  GATE: ${g.pass ? 'PASS' : 'FAIL — ' + g.fails.join('; ')}`);
    if (DRY) console.log('  (dry-run uses the canned sample_response.json — some cases fail ON PURPOSE to prove the harness catches the tester bugs. Add real photos + run live for true numbers.)');
  }

  if (DO_GATE && !g.pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
