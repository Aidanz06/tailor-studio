#!/usr/bin/env node
/*
 * Photo-clustering accuracy harness (PRD §5.1 / §8.9).
 *
 * Measures a GroupingStrategy against hand-labeled ground truth:
 *   - pairwise precision / recall / F1   (precision is the headline for a conservative merger)
 *   - Adjusted Rand Index                (chance-corrected; honest on small N)
 *   - homogeneity / completeness         (pure clusters vs fully-recovered items)
 *   - exact-group matches                (predicted groups that equal a truth item exactly)
 *   - WRONG-AUTO-ACCEPT rate             (auto-accepted groups that mix ≥2 truth items — MUST be ~0)
 *   - #groups, auto-accepted, flagged, auto-accept coverage
 *   - wall time + estimated $/batch
 *
 * Two modes:
 *   offline (default) — uses grailed-vision-test/descriptors.fixture.json so the code-side
 *                       deltas (EXIF prior, linkage, thresholds) are measurable with NO API
 *                       calls. Cost is ESTIMATED from image token counts.
 *   --live            — calls the real strategies (Anthropic / Voyage / local CLIP). Descriptors,
 *                       batched assignments and embeddings are cached under .harness-cache/ so
 *                       re-runs don't re-spend. Run this on the Mac (the CI sandbox blocks egress).
 *
 * Usage:
 *   node pipeline/harness.js                        # offline, default strategy set
 *   node pipeline/harness.js --strategies=baseline,descriptor-improved
 *   node pipeline/harness.js --live --strategies=baseline,descriptor-improved,batched-vision,embedding-voyage
 *   node pipeline/harness.js --json                 # machine-readable results to stdout
 *   node pipeline/harness.js --out=results.json     # also write results file
 *   node pipeline/harness.js --gt=grailed-vision-test/ground-truth.shoot-x.json
 *                                                   # score a different labeled shoot (default:
 *                                                   # ground-truth.json). Shoots are evaluated
 *                                                   # separately — real grouping runs one shoot
 *                                                   # per batch, and batched-vision caps ~75
 *                                                   # photos/request, so pools never merge.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const cluster = require('./cluster');
const gs = require('./groupingStrategy');

const GT_FILE = path.join(REPO, 'grailed-vision-test', 'ground-truth.json');
const FIX_FILE = path.join(REPO, 'grailed-vision-test', 'descriptors.fixture.json');
const CACHE_DIR = path.join(REPO, 'grailed-vision-test', '.harness-cache');

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function loadGroundTruth(file = GT_FILE) {
  const gt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = gt.photos.map((p) => p.path);
  const abs = rel.map((r) => path.join(REPO, r));
  const truth = gt.photos.map((p) => p.item);
  return { rel, abs, truth, items: gt.items, raw: gt };
}

function loadFixtures(file = FIX_FILE) {
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  return f.descriptors;
}

// Minimal JPEG dimension reader (SOF0/1/2 markers) — for image-token cost estimates.
function jpegDims(file) {
  try {
    const b = fs.readFileSync(file);
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      }
      o += 2 + b.readUInt16BE(o + 2);
    }
  } catch {}
  return { w: 1024, h: 1024 };
}

// Anthropic resizes so the long edge ≤ 1568px; tokens ≈ (w*h)/750.
function estImageTokens(w, h) {
  const cap = 1568;
  const scale = Math.min(1, cap / Math.max(w, h));
  const rw = Math.round(w * scale), rh = Math.round(h * scale);
  return Math.round((rw * rh) / 750);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function pairIndex(labels) {
  const n = labels.length;
  const same = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) same.push(labels[i] === labels[j]);
  return same;
}
function pairwise(pred, truth) {
  const P = pairIndex(pred), T = pairIndex(truth);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < P.length; i++) {
    if (P[i] && T[i]) tp++;
    else if (P[i] && !T[i]) fp++;
    else if (!P[i] && T[i]) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, tn, mergeErrors: fp, splitErrors: fn };
}

function contingency(pred, truth) {
  const rows = new Map(); // truth -> Map(pred -> count)
  const rowTot = new Map(), colTot = new Map();
  for (let i = 0; i < pred.length; i++) {
    const t = truth[i], p = pred[i];
    if (!rows.has(t)) rows.set(t, new Map());
    rows.get(t).set(p, (rows.get(t).get(p) || 0) + 1);
    rowTot.set(t, (rowTot.get(t) || 0) + 1);
    colTot.set(p, (colTot.get(p) || 0) + 1);
  }
  return { rows, rowTot, colTot, n: pred.length };
}
function comb2(x) { return (x * (x - 1)) / 2; }
function adjustedRand(pred, truth) {
  const { rows, rowTot, colTot, n } = contingency(pred, truth);
  let sumij = 0;
  for (const [, m] of rows) for (const [, c] of m) sumij += comb2(c);
  let sa = 0; for (const [, v] of rowTot) sa += comb2(v);
  let sb = 0; for (const [, v] of colTot) sb += comb2(v);
  const expected = (sa * sb) / comb2(n);
  const max = 0.5 * (sa + sb);
  return max - expected === 0 ? 1 : (sumij - expected) / (max - expected);
}
function entropy(totMap, n) {
  let h = 0;
  for (const [, c] of totMap) { const p = c / n; if (p > 0) h -= p * Math.log(p); }
  return h;
}
function homogeneityCompleteness(pred, truth) {
  const { rows, rowTot, colTot, n } = contingency(pred, truth);
  const Hc = entropy(rowTot, n); // truth entropy
  const Hk = entropy(colTot, n); // pred entropy
  // H(C|K)
  let HcK = 0;
  const predTot = colTot;
  for (const [t, m] of rows) for (const [p, c] of m) {
    const pk = predTot.get(p); if (c > 0) HcK -= (c / n) * Math.log(c / pk);
  }
  // H(K|C)
  let HkC = 0;
  for (const [t, m] of rows) { const ct = rowTot.get(t); for (const [p, c] of m) if (c > 0) HkC -= (c / n) * Math.log(c / ct); }
  const homogeneity = Hc === 0 ? 1 : 1 - HcK / Hc;
  const completeness = Hk === 0 ? 1 : 1 - HkC / Hk;
  const v = homogeneity + completeness ? (2 * homogeneity * completeness) / (homogeneity + completeness) : 0;
  return { homogeneity, completeness, vMeasure: v };
}

// Evaluate a strategy's groups against ground truth.
function evalGrouping(groups, absOrder, truthByAbs) {
  // predicted label per photo (align to absOrder)
  const predByAbs = new Map();
  groups.forEach((g) => g.photos.forEach((p) => predByAbs.set(path.resolve(p), g.groupId)));
  const pred = absOrder.map((a) => predByAbs.get(path.resolve(a)) ?? `__unassigned_${a}`);
  const truth = absOrder.map((a) => truthByAbs.get(path.resolve(a)));

  const pw = pairwise(pred, truth);
  const ari = adjustedRand(pred, truth);
  const hc = homogeneityCompleteness(pred, truth);

  // truth item -> set of abs paths
  const truthSets = new Map();
  absOrder.forEach((a) => {
    const t = truthByAbs.get(path.resolve(a));
    if (!truthSets.has(t)) truthSets.set(t, new Set());
    truthSets.get(t).add(path.resolve(a));
  });
  // purity per predicted group + exact matches
  let exact = 0, autoAccepted = 0, wrongAutoAccept = 0, flagged = 0, coveredPhotos = 0;
  for (const g of groups) {
    const setAbs = new Set(g.photos.map((p) => path.resolve(p)));
    const truthItemsInGroup = new Set([...setAbs].map((p) => truthByAbs.get(p)));
    const pure = truthItemsInGroup.size === 1;
    const t = [...truthItemsInGroup][0];
    const isExact = pure && truthSets.has(t) && truthSets.get(t).size === setAbs.size &&
      [...truthSets.get(t)].every((p) => setAbs.has(p));
    if (isExact) exact++;
    if (g.autoAccept) { autoAccepted++; if (!pure) wrongAutoAccept++; else coveredPhotos += setAbs.size; }
    if (!g.autoAccept || (g.flags && g.flags.length)) flagged++;
  }

  return {
    groups: groups.length,
    truthItems: truthSets.size,
    precision: pw.precision, recall: pw.recall, f1: pw.f1,
    mergeErrors: pw.mergeErrors, splitErrors: pw.splitErrors,
    ari, homogeneity: hc.homogeneity, completeness: hc.completeness, vMeasure: hc.vMeasure,
    exactGroupMatches: exact,
    autoAccepted, wrongAutoAccept,
    autoAcceptCoverage: coveredPhotos / absOrder.length,
    flaggedGroups: flagged,
    _pred: pred, _truth: truth,
  };
}

// ---------------------------------------------------------------------------
// Descriptor cache (live mode) — keyed by file signature + model.
// ---------------------------------------------------------------------------
function ensureCache() { fs.mkdirSync(CACHE_DIR, { recursive: true }); }
function fileSig(file) {
  const s = fs.statSync(file);
  return `${path.basename(file)}:${s.size}:${Math.round(s.mtimeMs)}`;
}
function cachePath(kind, key) {
  const safe = key.replace(/[^a-z0-9]+/gi, '_').slice(0, 180);
  return path.join(CACHE_DIR, `${kind}__${safe}.json`);
}
const CACHE_VERSION = 'v2'; // bump to invalidate old cached descriptors (e.g. after the usage-capture fix)
function cachedDescribe(model) {
  const { describePhoto } = cluster;
  return async (file, opts) => {
    ensureCache();
    const cp = cachePath('descriptor', `${CACHE_VERSION}:${model}:${fileSig(file)}`);
    if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, 'utf8'));
    const d = await describePhoto(file, { ...opts, model });
    fs.writeFileSync(cp, JSON.stringify(d));
    return d;
  };
}

// ---------------------------------------------------------------------------
// Strategy runners
// ---------------------------------------------------------------------------
function fixtureDescriptorsFor(absOrder, relOrder, fixtures) {
  return absOrder.map((abs, i) => {
    const d = fixtures[relOrder[i]];
    if (!d) throw new Error(`No fixture descriptor for ${relOrder[i]}`);
    return { ...d, file_path: abs };
  });
}

// Offline (fixture) runners for the strategies that only depend on descriptors.
async function runOffline(name, ctx) {
  const { absOrder, relOrder, fixtures } = ctx;
  const t0 = Date.now();
  if (name === 'baseline' || name === 'descriptor-baseline') {
    // exact baseline: clusterPhotos on descriptors with mtime timestamps
    const descriptors = fixtureDescriptorsFor(absOrder, relOrder, fixtures).map((d) => ({
      ...d, timestamp: (() => { try { return fs.statSync(d.file_path).mtimeMs; } catch { return 0; } })(),
    }));
    const groups = cluster.clusterPhotos(descriptors);
    return { groups, meta: { strategy: 'baseline', model: 'claude-opus-4-8 (fixture)', wallMs: Date.now() - t0, estBasis: 'per-photo' } };
  }
  // descriptor-improved and ablations
  const cfgByName = {
    'descriptor-improved': {},
    'descriptor-improved-noexif': { useExif: false },
    'descriptor-improved-complete': { linkage: 'complete' },
  };
  const cfg = cfgByName[name];
  if (cfg) {
    const strat = new gs.DescriptorJaccardStrategy({ mode: 'improved', ...cfg });
    const descriptors = fixtureDescriptorsFor(absOrder, relOrder, fixtures);
    const r = await strat.group(absOrder, { descriptors });
    return { groups: r.groups, meta: { ...r.meta, model: `${r.meta.model} (fixture)`, estBasis: 'per-photo' } };
  }
  throw new Error(`Strategy "${name}" needs --live (no offline fixture path).`);
}

async function runLive(name, ctx) {
  const { absOrder } = ctx;
  const opts = {};
  // route descriptor calls through the cache
  if (name.startsWith('descriptor') || name === 'baseline') {
    const model = name.includes('haiku') ? 'claude-haiku-4-5-20251001' : (process.env.CLUSTER_MODEL || 'claude-opus-4-8');
    opts.describe = cachedDescribe(model);
  }
  const stratName = name === 'baseline' ? 'baseline' : name;
  const strat = stratName === 'baseline'
    ? new gs.DescriptorJaccardStrategy({ mode: 'baseline', describe: opts.describe })
    : gs.makeGroupingStrategy(stratName, opts);
  const r = await strat.group(absOrder, opts);
  return { groups: r.groups, meta: r.meta };
}

// Cost estimate for offline per-photo / batched strategies.
function estCost(name, absOrder) {
  const model = name.includes('haiku') ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-8';
  const p = gs.priceFor(model);
  const imgTok = absOrder.map((a) => { const { w, h } = jpegDims(a); return estImageTokens(w, h); });
  if (name.startsWith('batched')) {
    const inTok = imgTok.reduce((s, x) => s + x, 0) + 250;
    const outTok = absOrder.length * 22 + 60;
    return { calls: 1, usd: (inTok / 1e6) * p.in + (outTok / 1e6) * p.out };
  }
  // per-photo descriptor call
  const perIn = (t) => t + 130, outTok = 150;
  const usd = imgTok.reduce((s, t) => s + (perIn(t) / 1e6) * p.in + (outTok / 1e6) * p.out, 0);
  return { calls: absOrder.length, usd };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function fmt(x, d = 3) { return x == null ? '—' : Number(x).toFixed(d); }
function printTable(results) {
  const cols = [
    ['strategy', (r) => r.name, 26],
    ['P', (r) => fmt(r.m.precision, 2), 5],
    ['R', (r) => fmt(r.m.recall, 2), 5],
    ['F1', (r) => fmt(r.m.f1, 2), 5],
    ['ARI', (r) => fmt(r.m.ari, 2), 6],
    ['homog', (r) => fmt(r.m.homogeneity, 2), 6],
    ['compl', (r) => fmt(r.m.completeness, 2), 6],
    ['grps', (r) => `${r.m.groups}/${r.m.truthItems}`, 6],
    ['exact', (r) => `${r.m.exactGroupMatches}/${r.m.truthItems}`, 6],
    ['merge✗', (r) => String(r.m.mergeErrors), 7],
    ['auto', (r) => String(r.m.autoAccepted), 5],
    ['WRONG-AA', (r) => String(r.m.wrongAutoAccept), 9],
    ['ms', (r) => String(r.meta.wallMs ?? '—'), 6],
    ['est$', (r) => r.cost ? `$${r.cost.usd.toFixed(3)}` : '—', 8],
  ];
  const header = cols.map(([h, , w]) => h.padEnd(w)).join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) console.log(cols.map(([, f, w]) => String(f(r)).padEnd(w)).join(' '));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const asJson = args.includes('--json');
  const outArg = args.find((a) => a.startsWith('--out='));
  const stratArg = args.find((a) => a.startsWith('--strategies='));
  const gtArg = args.find((a) => a.startsWith('--gt='));
  const gtFile = gtArg ? (path.isAbsolute(gtArg.split('=')[1]) ? gtArg.split('=')[1] : path.join(REPO, gtArg.split('=')[1])) : GT_FILE;
  const defaultOffline = ['baseline', 'descriptor-improved', 'descriptor-improved-noexif', 'descriptor-improved-complete'];
  const defaultLive = ['baseline', 'descriptor-improved', 'descriptor-haiku', 'batched-vision', 'batched-haiku', 'embedding-voyage'];
  const strategies = stratArg ? stratArg.split('=')[1].split(',') : (live ? defaultLive : defaultOffline);

  const { rel, abs, truth } = loadGroundTruth(gtFile);
  const truthByAbs = new Map(abs.map((a, i) => [path.resolve(a), truth[i]]));
  const ctx = { absOrder: abs, relOrder: rel, fixtures: live ? null : loadFixtures() };

  const results = [];
  for (const name of strategies) {
    try {
      const { groups, meta } = live ? await runLive(name, ctx) : await runOffline(name, ctx);
      const m = evalGrouping(groups, abs, truthByAbs);
      const cost = live ? (meta.estCostUsd != null ? { usd: meta.estCostUsd, calls: meta.calls } : null) : estCost(name, abs);
      results.push({ name, m, meta, cost, groups });
    } catch (e) {
      results.push({ name, error: e.message, m: {}, meta: {}, cost: null });
      console.error(`[skip] ${name}: ${e.message}`);
    }
  }

  const ok = results.filter((r) => !r.error);
  if (asJson) {
    process.stdout.write(JSON.stringify({ mode: live ? 'live' : 'offline', gt: path.relative(REPO, gtFile), results: ok.map((r) => ({ name: r.name, metrics: r.m, meta: r.meta, cost: r.cost, groups: r.groups.map((g) => ({ groupId: g.groupId, photos: g.photos.map((p) => path.relative(REPO, p)), confidence: g.confidence, autoAccept: g.autoAccept, flags: g.flags })) })) }, null, 2) + '\n');
  } else {
    console.log(`\nPhoto-clustering harness — ${live ? 'LIVE' : 'OFFLINE (fixtures)'} — ${abs.length} photos, ${new Set(truth).size} items\n`);
    printTable(ok);
    console.log('\nLegend: P/R/F1 pairwise · merge✗ = false-merge pairs · WRONG-AA = auto-accepted groups mixing ≥2 items (must be 0) · est$ per batch');
  }
  if (outArg) {
    const outFile = path.isAbsolute(outArg.split('=')[1]) ? outArg.split('=')[1] : path.join(REPO, outArg.split('=')[1]);
    fs.writeFileSync(outFile, JSON.stringify({ mode: live ? 'live' : 'offline', gt: path.relative(REPO, gtFile), generatedAt: new Date().toISOString(), results: ok.map((r) => ({ name: r.name, metrics: r.m, meta: r.meta, cost: r.cost })) }, null, 2));
    console.error(`\nWrote ${outFile}`);
  }
}

module.exports = { loadGroundTruth, loadFixtures, pairwise, adjustedRand, homogeneityCompleteness, evalGrouping, estImageTokens, jpegDims };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
