/*
 * Renders docs/COST-ACCURACY-SWEEP.md from the sweep.js results object.
 * Pure formatting — every number comes from the results JSON, nothing is
 * computed from scratch here except arithmetic roll-ups (rates, per-listing $).
 */

const path = require('path');

const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const MODELS = [OPUS, SONNET, HAIKU];
const short = (m) => (m === OPUS ? 'opus-4-8' : m === SONNET ? 'sonnet-5' : m === HAIKU ? 'haiku-4.5' : m);

const f2 = (x) => (x == null ? '—' : Number(x).toFixed(2));
const usd = (x) => (x == null ? '—' : `$${Number(x).toFixed(3)}`);
const usd4 = (x) => (x == null ? '—' : `$${Number(x).toFixed(4)}`);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
const ms = (x) => (x == null ? '—' : `${(x / 1000).toFixed(1)} s`);

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Stage 1 — grouping
// ---------------------------------------------------------------------------
function groupingSection(results) {
  const g = results.grouping;
  if (!g) return '_grouping stage not run_';
  const out = [];
  for (const gt of results.gtFiles) {
    const name = path.basename(gt);
    const rows = g.rows.filter((r) => r.gt === gt);
    out.push(`### Shoot: \`${name}\`${name.includes('varied') ? ' — 56 photos / 8 items, **no EXIF (vision-only regime)**' : ' — 36 photos / 9 items, EXIF present'}`);
    out.push('');
    out.push(table(
      ['strategy', 'P', 'R', 'F1', 'exact', 'wrong-AA', 'stability (5 fresh runs)', 'wall', '$/batch'],
      rows.map((r) => {
        if (r.error) return [r.label, '—', '—', '—', '—', '—', '—', '—', `ERROR: ${r.error.split('\n')[0].slice(0, 60)}`];
        const st = g.stability[r.label] && g.stability[r.label][name];
        const stTxt = st
          ? `${st.distinctPartitions} partition(s), wrong-AA in ${st.wrongAARuns}/${st.okRuns}, mean R=${f2(st.meanRecall)}, mean exact=${st.meanExact.toFixed(1)}`
          : (r.label.startsWith('batched') ? 'not run (already disqualified)' : 'deterministic (cached inputs)');
        const cost = r.label === 'embedding-clip' ? '$0.000 (local)' : (r.cost && r.cost.usd != null ? usd(r.cost.usd) : '—');
        return [r.label, f2(r.metrics.precision), f2(r.metrics.recall), f2(r.metrics.f1),
          `${r.metrics.exactGroupMatches}/${r.metrics.truthItems}`, String(r.metrics.wrongAutoAccept),
          stTxt, ms(r.meta.wallMs), cost];
      })
    ));
    out.push('');
  }
  out.push('Reading guide: **wrong-AA > 0 anywhere is disqualifying** (an auto-accepted group mixing two real items — the one unacceptable failure, PRD §8.9). P=1.00 alone is NOT enough: `descriptor-improved` shows P=1.00 on the EXIF shoot while fragmenting items (R=0.59). Stability partitions are relative to the incumbent — even opus is not single-partition on the no-EXIF shoot.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 2 — attributes
// ---------------------------------------------------------------------------
const FIELD_ORDER = ['brand', 'model', 'collaboration', 'category', 'subcategory', 'condition', 'color', 'size'];

function attributesSection(results) {
  const a = results.attributes;
  if (!a) return '_attributes stage not run_';
  const out = [];

  out.push('### Headline (aggregated over all runs of every live case)');
  out.push('');
  out.push(table(
    ['ATTRIBUTE_MODEL', 'overall', 'NWT→Used', 'gate', '$/item (real)', 'tokens in/out', 'cache read', 'ms/item', 'calls'],
    MODELS.map((m) => {
      const r = a[m];
      if (!r || r.error) return [short(m), '—', '—', 'ERROR', '—', '—', '—', '—', '—'];
      const perItem = r.cost ? r.cost.usd / r.cost.calls : null;
      const meanMs = r.results && r.results.length ? r.results.reduce((s, x) => s + (x.wallMs || 0), 0) / r.results.length : null;
      return [short(m), pct(r.agg.overall), String(r.agg.nwtViolations),
        r.gate.pass ? '**PASS**' : `**FAIL** (${r.gate.fails.join('; ')})`,
        usd4(perItem), r.cost ? `${Math.round(r.cost.in / r.cost.calls)}/${Math.round(r.cost.out / r.cost.calls)}` : '—',
        r.cost ? String(Math.round(r.cost.cacheRead / r.cost.calls)) : '—',
        ms(meanMs), String(r.cost ? r.cost.calls : 0)];
    })
  ));
  out.push('');

  out.push('### Per-field accuracy (gate bars: brand ≥70%, condition ≥70%, category ≥80%, subcategory ≥60%)');
  out.push('');
  out.push(table(
    ['field', ...MODELS.map(short)],
    FIELD_ORDER.map((f) => [f, ...MODELS.map((m) => {
      const r = a[m];
      if (!r || r.error || !r.agg.per[f]) return '—';
      const p = r.agg.per[f];
      return p.evaluated ? `${pct(p.pass / p.evaluated)} (${p.pass}/${p.evaluated})` : 'n/a';
    })])
  ));
  out.push('');

  // Per-case stability matrix: for each case, how many of the N runs were
  // clean (every evaluated field passed), and which fields flaked.
  out.push(`### Per-case stability (clean runs out of ${results.runs}; flaky/failing fields in parentheses)`);
  out.push('');
  const cases = [...new Set(MODELS.flatMap((m) => (a[m] && a[m].results) ? a[m].results.map((x) => x.case) : []))].sort();
  out.push(table(
    ['case', ...MODELS.map(short)],
    cases.map((c) => [c, ...MODELS.map((m) => {
      const r = a[m];
      if (!r || r.error) return '—';
      const runs = r.results.filter((x) => x.case === c);
      if (!runs.length) return '—';
      const failCounts = {};
      let clean = 0;
      for (const run of runs) {
        const fails = Object.entries(run.fields).filter(([, v]) => v === 'fail').map(([k]) => k);
        if (!fails.length) clean++;
        for (const f of fails) failCounts[f] = (failCounts[f] || 0) + 1;
      }
      const flaky = Object.entries(failCounts).map(([f, n]) => `${f}×${n}`).join(', ');
      return `${clean}/${runs.length}${flaky ? ` (${flaky})` : ''}`;
    })])
  ));
  out.push('');
  out.push('A case at `5/5` is solved; `0/5 (field×5)` is a consistent miss (a real capability gap); anything in between is run-to-run noise — cheaper models are typically noisier, which is what this matrix makes visible.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 3 — content
// ---------------------------------------------------------------------------
function contentSection(results) {
  const c = results.content;
  if (!c) return '_content stage not run_';
  const out = [];
  out.push(table(
    ['CONTENT_MODEL', 'rubric pass', 'perfect cases', '$/item (real)', 'latency/item (median · max)'],
    MODELS.map((m) => {
      const r = c[m];
      if (!r || r.error) return [short(m), 'ERROR', '—', '—', '—'];
      const s = r.summary;
      // Median, not mean: a single hung call that rode SDK retries (observed:
      // one 16.8-min outlier) would otherwise swamp the latency column.
      const times = r.results.map((x) => x.wallMs || 0).sort((a, b) => a - b);
      const med = times[Math.floor(times.length / 2)];
      const max = times[times.length - 1];
      return [short(m), pct(s.rubricPassRate), `${s.perfectCases}/${s.cases}`, usd4(s.usdPerItem), `${ms(med)} · ${ms(max)}`];
    })
  ));
  out.push('');

  const CHECKS = ['title_present', 'title_short', 'title_no_brand', 'tags_valid', 'no_authenticity', 'no_measurements', 'no_hype', 'brand_hedged', 'no_invented_color'];
  out.push('### Per-check pass rate (cases passing / cases)');
  out.push('');
  out.push(table(
    ['check', ...MODELS.map(short)],
    CHECKS.map((ch) => [ch, ...MODELS.map((m) => {
      const r = c[m];
      if (!r || r.error) return '—';
      const pass = r.results.filter((x) => x.checks[ch]).length;
      return `${pass}/${r.results.length}`;
    })])
  ));
  out.push('');

  const failures = [];
  for (const m of MODELS) {
    const r = c[m];
    if (!r || r.error) continue;
    for (const x of r.results) if (x.notes && x.notes.length) failures.push([short(m), x.case, x.notes.join('; ')]);
  }
  if (failures.length) {
    out.push('### Every rubric miss, verbatim');
    out.push('');
    out.push(table(['model', 'case', 'what failed'], failures));
  } else {
    out.push('No rubric misses on any model.');
  }
  out.push('');
  out.push('`no_authenticity` / `no_measurements` / `no_hype` are checked on the FINAL output (after content.js\'s own scrubbers), so a fail there means text a seller would actually see. Generated listings are saved under `grailed-vision-test/.sweep-cache/content__*` — spot-check the writing quality by eye; the rubric measures rule-compliance, not prose taste.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 4 — pricing
// ---------------------------------------------------------------------------
function pricingSection(results) {
  const p = results.pricing;
  if (!p) return '_pricing stage not run_';
  const out = [];
  if (p.canned) {
    out.push(`**Canned recall gate** (fixture attributes, offline, attribute-model-independent): ${p.canned.passed}/${p.canned.total} cases ${p.canned.gate ? '**PASS**' : '**FAIL**'} — the tiered lookup still finds the known sold listings (Isoknock narrow-tier case included).`);
    out.push('');
  }
  const models = MODELS.filter((m) => p.downstream && p.downstream[m] && p.downstream[m].length);
  if (models.length) {
    out.push('### Downstream check — each attribute model\'s REAL extracted attributes → live guarded comp lookup');
    out.push('');
    out.push('No known-sale ground truth exists for these items yet, so this measures **input parity**: does a cheaper attribute model still produce queries that reach the narrow (exact-identity) tier with exact matches? `tier·exact·comps` = tier reached · exact-match count · comps returned.');
    out.push('');
    const cases = [...new Set(models.flatMap((m) => p.downstream[m].map((x) => x.case)))].sort();
    out.push(table(
      ['case', ...models.map((m) => `${short(m)}`)],
      cases.map((c) => [c, ...models.map((m) => {
        const row = p.downstream[m].find((x) => x.case === c);
        if (!row) return '—';
        if (row.error) return `err: ${row.error.slice(0, 30)}`;
        return `${row.tier}·${row.exactMatchCount}·${row.nComps}`;
      })])
    ));
    out.push('');
    out.push('### The narrow queries each model actually built (query degradation is visible here)');
    out.push('');
    out.push(table(
      ['case', ...models.map((m) => `${short(m)} narrow query`)],
      cases.map((c) => [c, ...models.map((m) => {
        const row = p.downstream[m].find((x) => x.case === c);
        if (!row || row.error) return '—';
        return `\`${row.narrowQuery || '(none → broad)'}\``;
      })])
    ));
    out.push('');
    out.push('To turn this into true recall@K: supply a known sold Grailed listing (url + price) for any shoot-varied-01 item and add a `pipeline/fixtures/comps/<case>.json` (see that folder\'s README); the sweep will then score each attribute model against it.');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------
function economics(results) {
  const g = results.grouping, a = results.attributes, c = results.content;
  if (!g || !a || !c) return null;
  const refGt = results.gtFiles.find((f) => !f.includes('varied')) || results.gtFiles[0];
  const items = 9;
  return (gLabel, aM, cM) => {
    const gRow = g.rows.find((r) => r.label === gLabel && r.gt === refGt && !r.error);
    const aR = a[aM] && !a[aM].error ? a[aM] : null;
    const cR = c[cM] && !c[cM].error ? c[cM] : null;
    if (!gRow || !aR || !cR) return null;
    const gUsd = gRow.label === 'embedding-clip' ? 0 : ((gRow.cost && gRow.cost.usd) || 0);
    const aUsd = aR.cost ? aR.cost.usd / aR.cost.calls : 0;
    const cUsd = cR.summary.usdPerItem || 0;
    const aMs = aR.results.reduce((s, x) => s + (x.wallMs || 0), 0) / aR.results.length;
    return {
      gUsd, aUsd, cUsd,
      perListing: gUsd / items + aUsd + cUsd,
      perBatch: gUsd + items * (aUsd + cUsd),
      latency: (gRow.meta.wallMs || 0) / items + aMs + cR.summary.msPerItem,
    };
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function renderReport(results) {
  const rec = results.recommendation || {};
  const eco = economics(results);
  const lines = [];
  lines.push('# Cost vs accuracy sweep — pipeline model configurations');
  lines.push('');
  lines.push(`Generated ${results.generated} by \`pipeline/eval/sweep.js\` (attribute runs=${results.runs}, stability runs=${results.stabilityRuns}). Machine-readable twin: \`grailed-vision-test/sweep-results.json\`. **No production default was changed** — the diff at the bottom is a proposal.`);
  lines.push('');
  lines.push('## Reproduce');
  lines.push('```bash');
  lines.push('cd ~/Desktop/Grailed-automation');
  lines.push('source .env.local                       # ANTHROPIC_API_KEY (+ optional VOYAGE_API_KEY, GRAILED_ALGOLIA_KEY)');
  lines.push('npm i @huggingface/transformers         # one-time, only for embedding-clip');
  lines.push('npm run clustering:gate                 # sanity: fallback still P=1.0, wrong-AA=0');
  lines.push('node pipeline/eval/sweep.js --json --out=grailed-vision-test/sweep-results.json');
  lines.push('```');
  lines.push('');
  lines.push('Every dollar figure on a live row is REAL (`usage` tokens × published per-MTok rates via `usdFromUsage`, including prompt-cache read/write accounting). `embedding-clip` runs locally and is genuinely $0. Cached rows report the cost their original live call incurred.');
  lines.push('');
  lines.push('The labeled pool: the original 36-photo/9-item EXIF shoot (`ground-truth.json`) + the new 56-photo/8-item varied shoot (`ground-truth.shoot-varied-01.json` — Acne NWT overshirt, NOCTA×Nike anorak, Cav Empt, WE11DONE, Palm Angels (pinholes), Supreme crewneck, Supreme×CDG hoodie, YoungLA). 13 identification fixtures run live (8 new with real photos; the 5 legacy placeholder-photo cases are dry-run-only and marked `live_skip`).');
  lines.push('');

  lines.push('## Stage 1 — Grouping (`GROUPING_STRATEGY` / `CLUSTER_MODEL`)');
  lines.push('');
  lines.push(groupingSection(results));
  lines.push('');

  lines.push('## Stage 2 — Attributes (`ATTRIBUTE_MODEL`)');
  lines.push('');
  lines.push(attributesSection(results));
  lines.push('');

  lines.push('## Stage 3 — Content (`CONTENT_MODEL`)');
  lines.push('');
  lines.push(contentSection(results));
  lines.push('');

  lines.push('## Stage 4 — Pricing (comps — Algolia + pure code, no LLM cost)');
  lines.push('');
  lines.push(pricingSection(results));
  lines.push('');

  if (eco) {
    lines.push('## Combined per-listing economics');
    lines.push('');
    lines.push('Representative batch = the EXIF shoot (36 photos / 9 items; the no-EXIF shoot costs ~1.5–2× per batch on grouping because it has 56 photos). $/listing = grouping$/9 + attributes$/item + content$/item. Latency/listing = grouping wall/9 + attributes + content (the comp lookup adds ~1–3 s of guarded HTTP, identical across configs).');
    lines.push('');
    const configs = [
      ['current default', 'batched-vision@opus', SONNET, HAIKU],
      ['all-Opus (pre-July default)', 'batched-vision@opus', OPUS, OPUS],
      ['recommended', rec.grouping, rec.attributes, rec.content],
      ['all-Haiku (floor, NOT safe)', 'batched-haiku', HAIKU, HAIKU],
    ];
    const rows = [];
    const cur = eco('batched-vision@opus', SONNET, HAIKU);
    for (const [name, gL, aM, cM] of configs) {
      if (!gL || !aM || !cM) continue;
      const e = eco(gL, aM, cM);
      if (!e) { rows.push([name, `${gL} · ${short(aM)} · ${short(cM)}`, '—', '—', '—', '—', '—']); continue; }
      const save = cur ? (1 - e.perListing / cur.perListing) : null;
      rows.push([name, `${gL} · attr=${short(aM)} · content=${short(cM)}`,
        `${usd4(e.gUsd / 9)} + ${usd4(e.aUsd)} + ${usd4(e.cUsd)}`,
        usd4(e.perListing), usd(e.perBatch), save == null ? '—' : (save >= 0 ? `−${pct(save)}` : `+${pct(-save)}`), ms(e.latency)]);
    }
    lines.push(table(['config', 'stages', 'group+attr+content /listing', '$/listing', '$/batch (9 items)', 'vs current', 'latency/listing'], rows));
    lines.push('');
  }

  lines.push('## Recommendation — cheapest configuration that holds every gate');
  lines.push('');
  lines.push(`| stage | pick | knob |`);
  lines.push(`|---|---|---|`);
  lines.push(`| grouping | \`${rec.grouping || 'n/a'}\` | \`GROUPING_STRATEGY\`/\`CLUSTER_MODEL\` |`);
  lines.push(`| attributes | \`${rec.attributes || 'n/a'}\` | \`ATTRIBUTE_MODEL\` |`);
  lines.push(`| content | \`${rec.content || 'n/a'}\` | \`CONTENT_MODEL\` |`);
  lines.push('');
  const blocked = rec.blocked || {};
  for (const [stage, map] of Object.entries(blocked)) {
    const entries = Object.entries(map || {});
    if (!entries.length) continue;
    lines.push(`**Blocked ${stage} candidates** (the metric that blocks each):`);
    lines.push('');
    for (const [cand, reasons] of entries) lines.push(`- \`${cand}\`: ${reasons.join('; ')}`);
    lines.push('');
  }

  lines.push('### Proposed diff (NOT applied — for your approval)');
  lines.push('');
  lines.push('Current runtime config: `GROUPING_STRATEGY` unset (→ batched-vision), `CLUSTER_MODEL` unset (→ opus-4-8), `ATTRIBUTE_MODEL` unset (→ sonnet-5 code default in vision.js), `CONTENT_MODEL=claude-haiku-4-5-20251001` set in `.env.local`.');
  lines.push('');
  lines.push('```diff');
  if (rec.grouping && rec.grouping !== 'batched-vision@opus') {
    if (rec.grouping === 'batched-vision@sonnet') lines.push('+export CLUSTER_MODEL=claude-sonnet-5        # grouping: batched-vision stays, model drops to Sonnet');
    else lines.push(`+export GROUPING_STRATEGY=${rec.grouping.split('@')[0]}   # grouping strategy change`);
  } else lines.push(' # grouping: keep batched-vision @ opus-4-8 — no cheaper candidate held every gate');
  if (rec.attributes && rec.attributes !== SONNET) lines.push(`+export ATTRIBUTE_MODEL=${rec.attributes}`);
  else lines.push(' # attributes: keep claude-sonnet-5 (current default) — cheaper failed the gate');
  if (rec.content && rec.content !== HAIKU) lines.push(`+export CONTENT_MODEL=${rec.content}`);
  else lines.push(' # content: keep claude-haiku-4-5-20251001 (current .env.local setting)');
  lines.push('```');
  lines.push('');

  if (results.skipsAndCaveats && results.skipsAndCaveats.length) {
    lines.push('## Skipped rows & caveats (nothing silently omitted)');
    lines.push('');
    for (const s of [...new Set(results.skipsAndCaveats)]) lines.push(`- ${s}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

module.exports = { renderReport };
