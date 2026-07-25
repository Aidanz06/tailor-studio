#!/usr/bin/env node
/*
 * Comp-recall eval (docs/DIAGNOSIS-AND-TEST-SUITE.md §C) — the direct test for
 * the tester's "an identical Isoknock/designer-tee sold on Grailed but the comp
 * didn't find it." For each fixture with a KNOWN real sold listing, run the
 * tiered comp lookup and assert:
 *   recall@K  — the known listing (or a near-identical, by the exact-match
 *               tier) appears in the top K returned comps
 *   price     — the recommended price (range.median) is within tolerance of
 *               the known sale (skippable per fixture where one sale isn't
 *               representative, e.g. colorway-heavy sneaker models)
 *   tier      — optionally, which tier was expected to win
 *
 * Fixtures: pipeline/fixtures/comps/<case>.json (see that folder's README).
 * The dry-run replays REAL cached Algolia responses committed in the fixture
 * (`canned.narrow` / `canned.broad`) — fully offline, zero requests. The LIVE
 * run goes through GuardedCompProvider (cache + rate-limit + §8.1 circuit
 * breaker — never bypassed).
 *
 * Usage:
 *   node pipeline/eval/comps.js --dry-run          # offline, canned real comps
 *   node pipeline/eval/comps.js                    # LIVE (needs GRAILED_ALGOLIA_KEY)
 *   node pipeline/eval/comps.js --case=isoknock-brown-hoodie
 *   node pipeline/eval/comps.js --json --gate
 *   node pipeline/eval/comps.js --attrs=out.json   # override each case's attributes with a
 *                                                  # real extractAttributes output (JSON map
 *                                                  # case→attributes) — the sweep's downstream
 *                                                  # check that a cheaper ATTRIBUTE_MODEL didn't
 *                                                  # silently tank comp recall. In --dry-run the
 *                                                  # canned responses replay what the FIXTURE's
 *                                                  # original queries returned, so each result
 *                                                  # reports queryMatchesFixture — false means
 *                                                  # the replay is approximate for that row.
 */

const fs = require('fs');
const path = require('path');
const { getCompsTiered, buildNarrowQueryText } = require('../priceProvider');
const { computeRange, exactMatchTier } = require('../range');

const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'comps');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.split('=')[1] : d; };
const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const DO_GATE = has('--gate');
const ONLY = val('--case', null);
const ATTRS_FILE = val('--attrs', null);

const DEFAULT_RECALL_K = 10;
const DEFAULT_PRICE_TOL_PCT = 30;

function loadCases() {
  if (!fs.existsSync(FIX_DIR)) return [];
  return fs.readdirSync(FIX_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ name: n.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(FIX_DIR, n), 'utf8')) }))
    .filter((c) => !ONLY || c.name === ONLY);
}

// Replays the fixture's committed (real, previously fetched) Algolia responses —
// same shape the guarded provider returns, zero network.
class CannedProvider {
  constructor(fx) { this.fx = fx; }
  async getComps(attributes) {
    const canned = this.fx.canned || {};
    const comps = (attributes._narrowQuery ? canned.narrow : canned.broad) || [];
    return { comps, range: computeRange(comps, attributes) };
  }
}

function liveProvider() {
  const { GrailedScrapeProvider } = require('../priceProvider');
  const { GuardedCompProvider } = require('../compGuard');
  return new GuardedCompProvider(new GrailedScrapeProvider());
}

const idOf = (u) => { const m = String(u || '').match(/listings\/(\d+)/); return m ? m[1] : null; };

function scoreCase(fx, res) {
  const notes = [];
  const K = fx.recallK ?? DEFAULT_RECALL_K;
  const comps = res.comps || [];
  const knownId = idOf(fx.known && fx.known.url);

  const directRank = comps.findIndex((c) => knownId && idOf(c.url) === knownId) + 1; // 0 = absent
  const nearInTopK = comps.slice(0, K).filter((c) => exactMatchTier(c.title, fx.attributes)).length;
  const recall = (directRank > 0 && directRank <= K) || nearInTopK > 0;
  if (directRank > 0) notes.push(`known listing found at rank ${directRank} of ${comps.length}`);
  else if (nearInTopK > 0) notes.push(`known listing absent, but ${nearInTopK} near-identical (exact-tier) comp(s) in top ${K}`);
  else notes.push(`RECALL MISS: known listing not in the ${comps.length} returned comps, no near-identical in top ${K}`);

  const tierOk = !fx.expectTier || res.tier === fx.expectTier;
  if (!tierOk) notes.push(`tier: expected ${fx.expectTier}, got ${res.tier} (query "${res.narrowQuery || ''}")`);

  let priceOk = null;
  let deltaPct = null;
  if (fx.priceTolerancePct !== null && fx.known && Number(fx.known.price) > 0) {
    const rec = res.range && res.range.median;
    const tol = fx.priceTolerancePct ?? DEFAULT_PRICE_TOL_PCT;
    deltaPct = rec ? Math.abs(rec - fx.known.price) / fx.known.price * 100 : null;
    priceOk = deltaPct != null && deltaPct <= tol;
    notes.push(
      priceOk
        ? `recommended $${rec} vs known sale $${fx.known.price} (Δ ${deltaPct.toFixed(0)}% ≤ ${tol}%)`
        : `PRICE MISS: recommended $${rec} vs known sale $${fx.known.price} (Δ ${deltaPct == null ? 'n/a' : deltaPct.toFixed(0) + '%'} > ${tol}%)`
    );
  } else {
    notes.push('price check skipped per fixture');
  }

  return {
    pass: recall && tierOk && priceOk !== false,
    recall, tierOk, priceOk, directRank, nearInTopK, deltaPct,
    tier: res.tier, query: res.tier === 'narrow' ? res.narrowQuery : undefined,
    exactMatchCount: res.range && res.range.exactMatchCount,
    confidence: res.range && res.range.confidence && res.range.confidence.level,
    notes,
  };
}

async function main() {
  const cases = loadCases();
  if (!cases.length) { console.error(`No fixtures in ${FIX_DIR}`); process.exit(2); }

  // Optional attribute overrides (JSON map case→attributes) — a real
  // extractAttributes output replaces the fixture's canned attributes, so the
  // same known-sale assertions run against what a given model ACTUALLY extracted.
  let attrOverrides = {};
  if (ATTRS_FILE) {
    try { attrOverrides = JSON.parse(fs.readFileSync(ATTRS_FILE, 'utf8')); }
    catch (e) { console.error(`--attrs: cannot read ${ATTRS_FILE}: ${e.message}`); process.exit(2); }
  }

  const results = [];
  for (const fx of cases) {
    const provider = DRY ? new CannedProvider(fx) : liveProvider();
    const attrs = attrOverrides[fx.name] || fx.attributes;
    const overridden = Boolean(attrOverrides[fx.name]);
    // Canned responses were captured for the FIXTURE's queries; if the override
    // builds a different narrow query, a dry-run replay is only approximate.
    const fixtureNarrow = buildNarrowQueryText(fx.attributes);
    const actualNarrow = buildNarrowQueryText(attrs);
    const queryMatchesFixture = String(fixtureNarrow || '').toLowerCase() === String(actualNarrow || '').toLowerCase();
    let res;
    try { res = await getCompsTiered(provider, attrs); }
    catch (e) { console.error(`[${fx.name}] ${e.message}`); process.exit(2); }
    const r = scoreCase(fx, res);
    if (overridden) {
      r.attrsOverridden = true;
      r.queryMatchesFixture = queryMatchesFixture;
      r.narrowQuery = actualNarrow;
      if (DRY && !queryMatchesFixture) r.notes.push(`CAVEAT: overridden attrs build narrow query "${actualNarrow || '(none)'}" ≠ fixture's "${fixtureNarrow || '(none)'}" — canned replay is approximate; run live for a real answer`);
    }
    results.push({ case: fx.name, ...r });
    if (!JSON_OUT) {
      console.log(`\n${r.pass ? '✓' : '✗'} ${fx.name}  [tier: ${r.tier}${r.query ? ` "${r.query}"` : ''} · ${r.exactMatchCount ?? 0} exact · conf ${r.confidence ?? 'n/a'}]`);
      r.notes.forEach((n) => console.log(`    • ${n}`));
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const gatePass = passed === results.length;
  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: DRY ? 'dry-run' : 'live', passed, total: results.length, gate: gatePass, results }, null, 2));
  } else {
    console.log(`\n──────── summary (${DRY ? 'dry-run — canned real comps, offline' : 'live — guarded provider'}) ────────`);
    console.log(`  recall+price  ${passed}/${results.length} case(s) pass`);
    console.log(`\n  GATE: ${gatePass ? 'PASS' : 'FAIL — ' + results.filter((r) => !r.pass).map((r) => r.case).join(', ')}`);
  }
  if (DO_GATE && !gatePass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
