#!/usr/bin/env node
/*
 * Cost-vs-accuracy sweep orchestrator (owner brief 2026-07-21).
 *
 * Runs the model/strategy matrix over EVERY labeled shoot + fixture pool and
 * aggregates one result object: per-stage accuracy, real $ (from __usage /
 * meta.usage — estimates only where a stage is offline, and labeled "est"),
 * and wall-clock. Ends with the "cheapest configuration that clears every
 * stage's gate" and the diff to adopt it. NEVER flips a production default.
 *
 * Reuses the existing evals as subprocesses (--json) — no metric is
 * reimplemented here:
 *   grouping   pipeline/harness.js --live --json --gt=<shoot>   (per candidate)
 *              + stability (N fresh runs) for batched candidates that survive
 *   attributes pipeline/eval/identify.js --json --runs=N        (per ATTRIBUTE_MODEL)
 *   content    pipeline/eval/content.js --json --model=M        (per CONTENT_MODEL)
 *   pricing    pipeline/eval/comps.js --dry-run --json          (canned gate)
 *              + a per-attribute-model downstream check: each model's REAL
 *                extractAttributes output → live guarded comp lookup, compared
 *                across models (tier reached / exact matches / query built)
 *
 * Caching: whole-subprocess results cached under grailed-vision-test/.sweep-cache
 * keyed by (stage, candidate, input signature) so re-runs don't re-spend.
 * --refresh forces fresh calls. Stability runs are always fresh (that's the point).
 *
 * Usage:
 *   node pipeline/eval/sweep.js --json --out=grailed-vision-test/sweep-results.json
 *   node pipeline/eval/sweep.js --stages=attributes,content     # subset
 *   node pipeline/eval/sweep.js --runs=5 --stability-runs=5     # defaults
 *   node pipeline/eval/sweep.js --skip-stability                # quick pass
 *
 * Also writes docs/COST-ACCURACY-SWEEP.md (the human-readable report).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const GVT = path.join(REPO, 'grailed-vision-test');
const CACHE_DIR = path.join(GVT, '.sweep-cache');
const HARNESS = path.join(REPO, 'pipeline', 'harness.js');
const IDENTIFY = path.join(__dirname, 'identify.js');
const CONTENT = path.join(__dirname, 'content.js');
const COMPS = path.join(__dirname, 'comps.js');
const FIX_ID = path.join(REPO, 'pipeline', 'fixtures', 'identification');
const REPORT_MD = path.join(REPO, 'docs', 'COST-ACCURACY-SWEEP.md');

const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const MODELS = [OPUS, SONNET, HAIKU];
const short = (m) => (m === OPUS ? 'opus' : m === SONNET ? 'sonnet' : m === HAIKU ? 'haiku' : m);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.split('=')[1] : d; };
const JSON_OUT = has('--json');
const REFRESH = has('--refresh');
const OUT = val('--out', 'grailed-vision-test/sweep-results.json');
const RUNS = Number(val('--runs', 5));
const STAB_RUNS = Number(val('--stability-runs', 5));
const SKIP_STAB = has('--skip-stability');
const STAGES = val('--stages', 'grouping,attributes,content,pricing').split(',');

const skipsAndCaveats = []; // everything NOT measured gets said out loud
function caveat(s) { skipsAndCaveats.push(s); console.error(`[caveat] ${s}`); }
function log(s) { console.error(`[sweep] ${s}`); }

// ---------------------------------------------------------------------------
// Subprocess + cache plumbing
// ---------------------------------------------------------------------------
function run(cmdArgs, env = {}, timeoutMs = 45 * 60e3) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, cmdArgs, {
      cwd: REPO, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(cmdArgs[0])} failed: ${err.message}\n${String(stderr).slice(-800)}`));
      resolve({ stdout, stderr });
    });
  });
}
function sig(obj) { return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16); }
function cachePath(stage, key) { return path.join(CACHE_DIR, `sweep__${stage}__${key.replace(/[^a-z0-9.@-]+/gi, '_')}.json`); }
async function cached(stage, key, fn) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cp = cachePath(stage, key);
  if (!REFRESH && fs.existsSync(cp)) return { ...JSON.parse(fs.readFileSync(cp, 'utf8')), _cached: true };
  const v = await fn();
  fs.writeFileSync(cp, JSON.stringify(v, null, 2));
  return v;
}
// Signature of the identification fixture pool (photos + expectations) so the
// attribute/content caches invalidate when fixtures change.
function fixturesSig() {
  const parts = [];
  for (const d of fs.readdirSync(FIX_ID).sort()) {
    const dir = path.join(FIX_ID, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const st = fs.statSync(path.join(dir, f));
      parts.push(`${d}/${f}:${st.size}`);
    }
  }
  return sig(parts);
}

// ---------------------------------------------------------------------------
// Stage 1 — grouping
// ---------------------------------------------------------------------------
function groupingCandidates() {
  const c = [
    { label: 'batched-vision@opus', strategy: 'batched-vision', env: { CLUSTER_MODEL: OPUS }, incumbent: true, model: OPUS },
    { label: 'batched-vision@sonnet', strategy: 'batched-vision', env: { CLUSTER_MODEL: SONNET }, model: SONNET },
    { label: 'batched-haiku', strategy: 'batched-haiku', env: {}, model: HAIKU },
    { label: 'descriptor-improved@opus', strategy: 'descriptor-improved', env: { CLUSTER_MODEL: OPUS }, model: OPUS },
    { label: 'descriptor-haiku', strategy: 'descriptor-haiku', env: {}, model: HAIKU },
    { label: 'embedding-clip', strategy: 'embedding-clip', env: {}, model: 'clip (local, free)' },
  ];
  if (process.env.VOYAGE_API_KEY) c.push({ label: 'embedding-voyage', strategy: 'embedding-voyage', env: {}, model: 'voyage-multimodal-3' });
  else caveat('embedding-voyage skipped: VOYAGE_API_KEY not set in .env.local.');
  return c;
}

function partitionSig(groups) {
  const byPhoto = new Map();
  groups.forEach((g) => g.photos.forEach((p) => byPhoto.set(p, g.groupId)));
  const photos = [...byPhoto.keys()].sort();
  const relabel = new Map(); let next = 0;
  return photos.map((p) => {
    const id = byPhoto.get(p);
    if (!relabel.has(id)) relabel.set(id, next++);
    return relabel.get(id);
  }).join('-');
}

async function harnessRun(cand, gt, fresh = false) {
  const doit = async () => {
    const { stdout } = await run([HARNESS, '--live', '--json', `--gt=${gt}`, `--strategies=${cand.strategy}`], cand.env);
    const parsed = JSON.parse(stdout);
    const r = parsed.results && parsed.results[0];
    if (!r) throw new Error(`no result row for ${cand.strategy}`);
    return { gt, label: cand.label, metrics: r.metrics, meta: r.meta, cost: r.cost, partition: partitionSig(r.groups || []) };
  };
  if (fresh) return doit();
  return cached('grouping', `${cand.label}__${path.basename(gt)}`, doit);
}

async function stageGrouping(gtFiles) {
  const cands = groupingCandidates();
  const rows = [];
  for (const gt of gtFiles) {
    for (const cand of cands) {
      try {
        log(`grouping: ${cand.label} on ${path.basename(gt)} …`);
        const r = await harnessRun(cand, gt);
        rows.push({ ...r, error: null });
        log(`  P=${r.metrics.precision.toFixed(2)} R=${r.metrics.recall.toFixed(2)} exact=${r.metrics.exactGroupMatches}/${r.metrics.truthItems} wrongAA=${r.metrics.wrongAutoAccept} $${r.cost && r.cost.usd != null ? r.cost.usd.toFixed(3) : 'n/a'}${r._cached ? ' (cached)' : ''}`);
      } catch (e) {
        rows.push({ gt, label: cand.label, error: e.message });
        caveat(`grouping ${cand.label} on ${path.basename(gt)} failed: ${e.message.split('\n')[0]}`);
      }
    }
  }

  // Stability: batched candidates whose every single-run had wrong-AA 0.
  // (Descriptor strategies re-use cached per-photo descriptors → deterministic
  // re-runs; embedding-clip is deterministic. Stability is a batched-call risk.)
  const stability = {};
  if (!SKIP_STAB) {
    for (const cand of cands.filter((c) => c.strategy.startsWith('batched'))) {
      const own = rows.filter((r) => r.label === cand.label && !r.error);
      if (!own.length || own.some((r) => r.metrics.wrongAutoAccept > 0)) {
        caveat(`stability skipped for ${cand.label}: single run already violated wrong-AA=0 (or failed).`);
        continue;
      }
      stability[cand.label] = {};
      for (const gt of gtFiles) {
        log(`stability: ${cand.label} × ${STAB_RUNS} on ${path.basename(gt)} (fresh calls)…`);
        const key = `stab__${cand.label}__${path.basename(gt)}__${STAB_RUNS}`;
        const st = await cached('grouping', key, async () => {
          const runs = [];
          for (let i = 0; i < STAB_RUNS; i++) {
            try { runs.push(await harnessRun(cand, gt, true)); }
            catch (e) { runs.push({ error: e.message }); }
          }
          const okRuns = runs.filter((r) => !r.error);
          const parts = new Set(okRuns.map((r) => r.partition));
          return {
            runs: runs.length, okRuns: okRuns.length,
            distinctPartitions: parts.size,
            wrongAARuns: okRuns.filter((r) => r.metrics.wrongAutoAccept > 0).length,
            meanRecall: okRuns.reduce((s, r) => s + r.metrics.recall, 0) / (okRuns.length || 1),
            meanExact: okRuns.reduce((s, r) => s + r.metrics.exactGroupMatches, 0) / (okRuns.length || 1),
            totalUsd: okRuns.reduce((s, r) => s + ((r.cost && r.cost.usd) || 0), 0),
            errors: runs.filter((r) => r.error).map((r) => r.error.split('\n')[0]),
          };
        });
        stability[cand.label][path.basename(gt)] = st;
        log(`  ${st.okRuns}/${st.runs} ok, ${st.distinctPartitions} distinct partition(s), wrong-AA in ${st.wrongAARuns} run(s)`);
      }
    }
  } else caveat('stability runs skipped (--skip-stability) — batched candidates are NOT adoption-eligible without 5/5 stability.');

  return { candidates: cands.map((c) => c.label), rows, stability };
}

// ---------------------------------------------------------------------------
// Stage 2 — attributes
// ---------------------------------------------------------------------------
async function stageAttributes() {
  const fsig = fixturesSig();
  const out = {};
  await Promise.all(MODELS.map(async (m) => {
    log(`attributes: ${short(m)} × ${RUNS} runs (live)…`);
    try {
      const r = await cached('attributes', `${m}__runs${RUNS}__${fsig}`, async () => {
        const { stdout } = await run([IDENTIFY, '--json', `--runs=${RUNS}`], { ATTRIBUTE_MODEL: m });
        return JSON.parse(stdout);
      });
      out[m] = r;
      log(`  ${short(m)}: overall ${(r.agg.overall * 100).toFixed(0)}% · NWT ${r.agg.nwtViolations} · gate ${r.gate.pass ? 'PASS' : 'FAIL'} · $${r.cost ? (r.cost.usd / r.cost.calls).toFixed(4) : '?'}/item${r._cached ? ' (cached)' : ''}`);
    } catch (e) {
      out[m] = { error: e.message };
      caveat(`attributes ${short(m)} failed: ${e.message.split('\n')[0]}`);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3 — content
// ---------------------------------------------------------------------------
async function stageContent() {
  const out = {};
  await Promise.all(MODELS.map(async (m) => {
    log(`content: ${short(m)}…`);
    try {
      // content.js has its own per-case cache keyed by model+attrs.
      const { stdout } = await run([CONTENT, '--json', `--model=${m}`, ...(REFRESH ? ['--refresh'] : [])]);
      out[m] = JSON.parse(stdout);
      const s = out[m].summary;
      log(`  ${short(m)}: rubric ${(s.rubricPassRate * 100).toFixed(0)}% · $${(s.usdPerItem ?? 0).toFixed(4)}/item · ${Math.round(s.msPerItem)} ms/item`);
    } catch (e) {
      out[m] = { error: e.message };
      caveat(`content ${short(m)} failed: ${e.message.split('\n')[0]}`);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 — pricing
// ---------------------------------------------------------------------------
async function stagePricing(attributes) {
  const out = { canned: null, downstream: {} };
  try {
    const { stdout } = await run([COMPS, '--dry-run', '--json']);
    out.canned = JSON.parse(stdout);
    log(`pricing canned gate: ${out.canned.passed}/${out.canned.total} ${out.canned.gate ? 'PASS' : 'FAIL'} (fixture attributes — attribute-model-independent)`);
  } catch (e) { caveat(`canned comps eval failed: ${e.message.split('\n')[0]}`); }
  caveat('True recall@K per attribute model is only measurable for items with BOTH real photos and a known sold listing — none exist yet (the 3 comp fixtures belong to tester items with placeholder photos). Supply known sold URLs for shoot-varied-01 items to close this gap.');

  // Downstream check: each attribute model's REAL run-1 output → guarded live
  // comp lookup. No known-sale ground truth, but tier reached / exact-match
  // count / query built show whether cheaper attributes degrade pricing input.
  if (!process.env.GRAILED_ALGOLIA_KEY) {
    caveat('downstream pricing check skipped: GRAILED_ALGOLIA_KEY not set.');
    return out;
  }
  const { buildNarrowQueryText } = require('../priceProvider');
  const { getCompsTiered, GrailedScrapeProvider } = require('../priceProvider');
  const { GuardedCompProvider } = require('../compGuard');
  const provider = new GuardedCompProvider(new GrailedScrapeProvider());
  for (const m of MODELS) {
    const attr = attributes[m];
    if (!attr || attr.error || !attr.results) continue;
    const firstRun = attr.results.filter((r) => r.run === 1);
    out.downstream[m] = [];
    for (const r of firstRun) {
      try {
        const res = await cached('pricing', `${m}__${r.case}__${sig(r.actual)}`, async () => {
          const t0 = Date.now();
          const x = await getCompsTiered(provider, r.actual);
          return {
            tier: x.tier, narrowQuery: buildNarrowQueryText(r.actual) || null,
            compQuery: r.actual.comp_query || null,
            nComps: (x.comps || []).length,
            exactMatchCount: (x.range && x.range.exactMatchCount) || 0,
            confidence: x.range && x.range.confidence && x.range.confidence.level,
            median: x.range && x.range.median, wallMs: Date.now() - t0,
          };
        });
        out.downstream[m].push({ case: r.case, ...res });
      } catch (e) {
        out.downstream[m].push({ case: r.case, error: e.message.split('\n')[0] });
      }
    }
    log(`pricing downstream ${short(m)}: ${out.downstream[m].filter((x) => !x.error).length}/${firstRun.length} lookups ok`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gates + recommendation
// ---------------------------------------------------------------------------
function decideGrouping(g) {
  const inc = 'batched-vision@opus';
  const byLabel = {};
  for (const r of g.rows.filter((r) => !r.error)) (byLabel[r.label] = byLabel[r.label] || []).push(r);
  const incRows = byLabel[inc] || [];
  const verdicts = {};
  for (const [label, rows] of Object.entries(byLabel)) {
    const reasons = [];
    for (const r of rows) {
      const incR = incRows.find((x) => x.gt === r.gt);
      if (r.metrics.wrongAutoAccept > 0) reasons.push(`wrong-AA=${r.metrics.wrongAutoAccept} on ${path.basename(r.gt)} (must be 0)`);
      if (incR) {
        if (r.metrics.recall < incR.metrics.recall - 0.02) reasons.push(`recall ${r.metrics.recall.toFixed(2)} < incumbent ${incR.metrics.recall.toFixed(2)} on ${path.basename(r.gt)}`);
        if (r.metrics.exactGroupMatches < incR.metrics.exactGroupMatches) reasons.push(`exact ${r.metrics.exactGroupMatches} < incumbent ${incR.metrics.exactGroupMatches} on ${path.basename(r.gt)}`);
      }
    }
    if (label.startsWith('batched')) {
      const st = g.stability[label];
      const incSt = g.stability[inc] || {};
      if (!st) reasons.push('no stability pass (required for batched candidates)');
      else for (const [gtName, s] of Object.entries(st)) {
        if (s.wrongAARuns > 0) reasons.push(`stability: wrong-AA in ${s.wrongAARuns}/${s.okRuns} runs on ${gtName}`);
        // Partition-stability bar is RELATIVE to the incumbent on the same shoot:
        // the no-EXIF shoot shows even opus isn't 1-partition there, so "5/5
        // identical" is only demanded where the incumbent achieves it.
        const incParts = (incSt[gtName] && incSt[gtName].distinctPartitions) || 1;
        if (s.distinctPartitions > incParts) reasons.push(`stability: ${s.distinctPartitions} distinct partitions on ${gtName} (incumbent: ${incParts})`);
        if (s.okRuns < s.runs) reasons.push(`stability: ${s.runs - s.okRuns} run(s) errored on ${gtName}`);
      }
    }
    verdicts[label] = { pass: reasons.length === 0, reasons };
  }
  return verdicts;
}

function decideAttributes(a, pricing) {
  const verdicts = {};
  const incumbent = a[SONNET]; // current code default is sonnet-5
  for (const m of MODELS) {
    const r = a[m];
    if (!r || r.error) { verdicts[m] = { pass: false, reasons: [r ? r.error.split('\n')[0] : 'not run'] }; continue; }
    const reasons = [];
    if (!r.gate.pass) reasons.push(...r.gate.fails);
    if (r.agg.nwtViolations > 0 && !r.gate.fails.some((f) => f.includes('NWT'))) reasons.push(`${r.agg.nwtViolations} NWT violation(s)`);
    // Downstream: did this model's attrs reach a worse comp tier than opus attrs?
    const dsBase = pricing.downstream[OPUS] || [];
    const ds = pricing.downstream[m] || [];
    for (const row of ds) {
      const base = dsBase.find((x) => x.case === row.case);
      if (base && !base.error && !row.error && base.tier === 'narrow' && row.tier !== 'narrow') {
        reasons.push(`downstream: ${row.case} degrades narrow→${row.tier} vs opus attrs`);
      }
    }
    verdicts[m] = { pass: reasons.length === 0, reasons };
  }
  return verdicts;
}

function decideContent(c) {
  const verdicts = {};
  const current = c[HAIKU]; // runtime default (.env.local CONTENT_MODEL) is haiku
  for (const m of MODELS) {
    const r = c[m];
    if (!r || r.error) { verdicts[m] = { pass: false, reasons: [r ? r.error.split('\n')[0] : 'not run'] }; continue; }
    const reasons = [];
    const s = r.summary;
    // Hard floors: the two safety scrubs must never fire, rubric ≥ 95%.
    const unsafe = r.results.filter((x) => !x.checks.no_authenticity || !x.checks.no_measurements);
    if (unsafe.length) reasons.push(`${unsafe.length} case(s) with authenticity/measurement text in the body`);
    if (s.rubricPassRate < 0.95) reasons.push(`rubric ${(s.rubricPassRate * 100).toFixed(0)}% < 95%`);
    if (current && !current.error && s.rubricPassRate < current.summary.rubricPassRate - 0.02) {
      reasons.push(`rubric below the current default (haiku ${(current.summary.rubricPassRate * 100).toFixed(0)}%)`);
    }
    verdicts[m] = { pass: reasons.length === 0, reasons };
  }
  return verdicts;
}

// Cheapest candidate per stage that clears its gate; report blockers.
function recommend(results) {
  const rec = { grouping: null, attributes: null, content: null, blocked: {} };
  const g = results.grouping;
  if (g) {
    const order = ['embedding-clip', 'descriptor-haiku', 'batched-haiku', 'batched-vision@sonnet', 'descriptor-improved@opus', 'batched-vision@opus']; // cheapest→priciest (measured costs refine this in the report)
    const v = results.verdicts.grouping;
    rec.grouping = order.find((l) => v[l] && v[l].pass) || 'batched-vision@opus';
    rec.blocked.grouping = Object.fromEntries(Object.entries(v).filter(([, x]) => !x.pass).map(([k, x]) => [k, x.reasons]));
  }
  if (results.attributes) {
    const v = results.verdicts.attributes;
    rec.attributes = [HAIKU, SONNET, OPUS].find((m) => v[m] && v[m].pass) || SONNET;
    rec.blocked.attributes = Object.fromEntries(Object.entries(v).filter(([, x]) => !x.pass).map(([k, x]) => [short(k), x.reasons]));
  }
  if (results.content) {
    const v = results.verdicts.content;
    rec.content = [HAIKU, SONNET, OPUS].find((m) => v[m] && v[m].pass) || HAIKU;
    rec.blocked.content = Object.fromEntries(Object.entries(v).filter(([, x]) => !x.pass).map(([k, x]) => [short(k), x.reasons]));
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const gtFiles = fs.readdirSync(GVT).filter((f) => /^ground-truth(\..+)?\.json$/.test(f)).map((f) => path.join('grailed-vision-test', f));
  log(`labeled shoots: ${gtFiles.join(', ')}`);
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set — source .env.local first.'); process.exit(1); }

  const results = { generated: null, runs: RUNS, stabilityRuns: STAB_RUNS, gtFiles, verdicts: {} };

  if (STAGES.includes('grouping')) results.grouping = await stageGrouping(gtFiles);
  if (STAGES.includes('attributes')) results.attributes = await stageAttributes();
  if (STAGES.includes('content')) results.content = await stageContent();
  if (STAGES.includes('pricing')) results.pricing = await stagePricing(results.attributes || {});

  if (results.grouping) results.verdicts.grouping = decideGrouping(results.grouping);
  if (results.attributes) results.verdicts.attributes = decideAttributes(results.attributes, results.pricing || { downstream: {} });
  if (results.content) results.verdicts.content = decideContent(results.content);
  results.recommendation = recommend(results);
  results.skipsAndCaveats = skipsAndCaveats;
  results.generated = new Date().toISOString();

  const outFile = path.isAbsolute(OUT) ? OUT : path.join(REPO, OUT);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  log(`wrote ${path.relative(REPO, outFile)}`);

  try {
    const { renderReport } = require('./sweep-report');
    fs.writeFileSync(REPORT_MD, renderReport(results));
    log(`wrote ${path.relative(REPO, REPORT_MD)}`);
  } catch (e) { caveat(`report render failed: ${e.message}`); }

  if (JSON_OUT) process.stdout.write(JSON.stringify(results.recommendation, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
