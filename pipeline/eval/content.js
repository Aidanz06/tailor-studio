#!/usr/bin/env node
/*
 * Content-generation eval — the third AI stage finally gets a gate.
 *
 * For every identification fixture that has a usable attributes object
 * (content_input.json if present, else sample_response.json), run
 * generateContent() under a given CONTENT_MODEL and score cheap, deterministic
 * rules that encode the guardrails content.js already promises (PRD §8.8 +
 * system-prompt rules 1/3/5/6):
 *
 *   title_present        non-empty title
 *   title_short          ≤ 7 words and ≤ 60 chars (Grailed titles are short)
 *   title_no_brand       no brand/collab name in title or alternatives (rule 5)
 *   tags_valid           ≤ 10 tags, all lowercase, no '#' (schema contract)
 *   no_authenticity      body mentions authenticity nowhere (rule 1 — checked by
 *                        running the production scrubber over a copy: if it
 *                        changes anything, the check fails)
 *   no_measurements      no measurements header / "__" blanks (rule 3, same method)
 *   no_hype              no banned hype phrase survives (rule 6, same method)
 *   brand_hedged         when brand is "unclear" or brand_confidence < 0.6 the
 *                        body may not assert the brand as fact (rule 2)
 *   no_invented_color    no basic color word in the body that the attributes
 *                        never mentioned (rule 4, lenient: 16-color lexicon)
 *
 * Rubric pass-rate + REAL $/item + ms/item per model. Outputs are cached under
 * grailed-vision-test/.sweep-cache keyed by (model, case, attributes signature)
 * so re-runs don't re-spend; --refresh forces new calls. Generated outputs are
 * saved next to the cache for manual spot-checks.
 *
 * Usage:
 *   node pipeline/eval/content.js                          # CONTENT_MODEL env or code default
 *   node pipeline/eval/content.js --model=claude-haiku-4-5-20251001
 *   node pipeline/eval/content.js --json --refresh
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'identification');
const CACHE_DIR = path.join(REPO, 'grailed-vision-test', '.sweep-cache');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.split('=')[1] : d; };
const JSON_OUT = has('--json');
const REFRESH = has('--refresh');
const ONLY = val('--case', null);

const COLOR_LEXICON = ['black', 'white', 'grey', 'gray', 'red', 'blue', 'navy', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'beige', 'cream', 'tan'];

function loadCases() {
  if (!fs.existsSync(FIX_DIR)) return [];
  return fs.readdirSync(FIX_DIR)
    .filter((n) => fs.statSync(path.join(FIX_DIR, n)).isDirectory())
    .filter((n) => !ONLY || n === ONLY)
    .map((name) => {
      const dir = path.join(FIX_DIR, name);
      for (const f of ['content_input.json', 'sample_response.json']) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) return { name, source: f, attributes: JSON.parse(fs.readFileSync(p, 'utf8')) };
      }
      return null;
    })
    .filter(Boolean);
}

// Wrap the SDK client so real usage/model/latency ride back without touching
// pipeline/content.js (generateContent doesn't attach __usage itself).
function meteredClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  const inner = new Anthropic();
  const meter = { usage: null, model: null };
  return {
    meter,
    client: {
      messages: {
        create: async (req) => {
          const resp = await inner.messages.create(req);
          meter.usage = resp.usage;
          meter.model = resp.model;
          return resp;
        },
      },
    },
  };
}

const norm = (s) => String(s ?? '').toLowerCase();
const bodyOf = (c) => [c.description, ...(c.desc_parts ? Object.values(c.desc_parts) : [])].map(norm).join('\n');

// "Did the production scrubber change anything?" — a deterministic detector for
// text the guardrails ban, reusing content.js's own regexes instead of copies.
function scrubberChanged(content, scrub) {
  const before = JSON.stringify({ d: content.description, p: content.desc_parts });
  const after = scrub(JSON.parse(JSON.stringify(content)));
  return JSON.stringify({ d: after.description, p: after.desc_parts }) !== before;
}

function scoreContent(attrs, content) {
  const { stripAuthenticityLines, stripHypeLines, stripMeasurementBlanks } = require('../content');
  const checks = {};
  const notes = [];

  const title = String(content.title ?? '').trim();
  checks.title_present = title.length > 0;
  checks.title_short = title.length > 0 && title.split(/\s+/).length <= 7 && title.length <= 60;
  if (!checks.title_short && title) notes.push(`title too long: "${title}"`);

  const brand = norm(attrs.resembles_brand) !== 'unclear' ? norm(attrs.resembles_brand) : '';
  const collab = norm(attrs.collaboration);
  const titles = [title, ...(content.title_alternatives || [])].map(norm);
  const brandInTitle = (b) => b && titles.some((t) => t.includes(b));
  checks.title_no_brand = !brandInTitle(brand) && !brandInTitle(collab);
  if (!checks.title_no_brand) notes.push(`brand/collab name in a title: ${JSON.stringify(titles)}`);

  const tags = content.tags || [];
  checks.tags_valid = tags.length <= 10 && tags.every((t) => typeof t === 'string' && t === t.toLowerCase() && !t.includes('#'));
  if (!checks.tags_valid) notes.push(`tags invalid (${tags.length} tags): ${JSON.stringify(tags)}`);

  checks.no_authenticity = !scrubberChanged(content, stripAuthenticityLines) && !/authentic/i.test(bodyOf(content));
  if (!checks.no_authenticity) notes.push('authenticity language in the listing body');
  checks.no_measurements = !scrubberChanged(content, stripMeasurementBlanks) && !/_{2,}/.test(bodyOf(content));
  if (!checks.no_measurements) notes.push('measurements header/blanks in the body');
  checks.no_hype = !scrubberChanged(content, stripHypeLines);
  if (!checks.no_hype) notes.push('banned hype phrase in the body');

  const lowConf = !brand || Number(attrs.brand_confidence ?? 0) < 0.6;
  if (lowConf && brand) {
    const body = bodyOf(content);
    if (!body.includes(brand)) checks.brand_hedged = true;
    else {
      // brand named despite low confidence — must be hedged in the same sentence
      const sentences = body.split(/[.!?\n]/).filter((s) => s.includes(brand));
      checks.brand_hedged = sentences.every((s) => /appear|possibl|likel|resembl|seems|style of|unverified|unbranded/i.test(s));
      if (!checks.brand_hedged) notes.push(`low-confidence brand "${brand}" stated as fact`);
    }
  } else {
    checks.brand_hedged = true; // confident brand or nothing to hedge
  }

  const attrColors = norm(JSON.stringify([attrs.primary_color, attrs.secondary_colors, attrs.distinctive_features, attrs.era_style]));
  const body = bodyOf(content) + ' ' + titles.join(' ');
  const invented = COLOR_LEXICON.filter((c) => new RegExp(`\\b${c}\\b`).test(body) && !attrColors.includes(c));
  // grey/gray equivalence
  const realInvented = invented.filter((c) => !((c === 'grey' && attrColors.includes('gray')) || (c === 'gray' && attrColors.includes('grey'))));
  checks.no_invented_color = realInvented.length === 0;
  if (!checks.no_invented_color) notes.push(`color(s) not in attributes: ${realInvented.join(', ')}`);

  const passed = Object.values(checks).filter(Boolean).length;
  return { checks, passed, total: Object.keys(checks).length, notes };
}

function cacheKey(model, name, attrs) {
  const sig = crypto.createHash('sha1').update(model + '|' + name + '|' + JSON.stringify(attrs)).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `content__${model.replace(/[^a-z0-9]+/gi, '_')}__${name}__${sig}.json`);
}

async function main() {
  const { generateContent, DEFAULT_MODEL } = require('../content');
  const model = val('--model', process.env.CONTENT_MODEL || DEFAULT_MODEL);
  const cases = loadCases();
  if (!cases.length) { console.error(`No usable attribute sources in ${FIX_DIR}`); process.exit(2); }
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const { usdFromUsage } = require('../groupingStrategy');
  const results = [];
  const cost = { model, calls: 0, cachedCalls: 0, usd: 0, in: 0, out: 0 };
  for (const c of cases) {
    const cp = cacheKey(model, c.name, c.attributes);
    let entry;
    if (!REFRESH && fs.existsSync(cp)) {
      entry = JSON.parse(fs.readFileSync(cp, 'utf8'));
      cost.cachedCalls++;
    } else {
      const { client, meter } = meteredClient();
      const t0 = Date.now();
      let content;
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !content; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt * attempt));
        try { content = await generateContent(c.attributes, { client, model }); }
        catch (e) { lastErr = e; console.error(`[${c.name}] attempt ${attempt + 1}: ${e.message}`); }
      }
      if (!content) { console.error(`[${c.name}] ${lastErr.message}`); process.exit(2); }
      entry = { content, usage: meter.usage, model: meter.model || model, wallMs: Date.now() - t0 };
      fs.writeFileSync(cp, JSON.stringify(entry, null, 2));
      cost.calls++;
    }
    if (entry.usage) {
      cost.usd += usdFromUsage(entry.usage, model);
      cost.in += entry.usage.input_tokens || 0;
      cost.out += entry.usage.output_tokens || 0;
    }
    const r = scoreContent(c.attributes, entry.content);
    results.push({ case: c.name, source: c.source, wallMs: entry.wallMs, ...r, output: entry.content });
    if (!JSON_OUT) {
      console.log(`\n${r.passed === r.total ? '✓' : '✗'} ${c.name}  ${r.passed}/${r.total}  (${entry.wallMs} ms)`);
      r.notes.forEach((n) => console.log(`    • ${n}`));
    }
  }

  const totalChecks = results.reduce((s, r) => s + r.total, 0);
  const passedChecks = results.reduce((s, r) => s + r.passed, 0);
  const allCalls = results.length;
  const summary = {
    model,
    cases: results.length,
    rubricPassRate: totalChecks ? passedChecks / totalChecks : null,
    perfectCases: results.filter((r) => r.passed === r.total).length,
    usdPerItem: allCalls ? cost.usd / allCalls : null,
    msPerItem: results.reduce((s, r) => s + (r.wallMs || 0), 0) / (allCalls || 1),
    liveCalls: cost.calls,
    cachedCalls: cost.cachedCalls,
    tokens: { in: cost.in, out: cost.out },
  };

  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, results: results.map((r) => ({ case: r.case, source: r.source, wallMs: r.wallMs, checks: r.checks, passed: r.passed, total: r.total, notes: r.notes, output: r.output })) }, null, 2));
  } else {
    console.log(`\n──────── content eval summary (${model}) ────────`);
    console.log(`  rubric        ${(summary.rubricPassRate * 100).toFixed(0)}% checks pass (${passedChecks}/${totalChecks}); ${summary.perfectCases}/${results.length} cases perfect`);
    console.log(`  cost          $${(summary.usdPerItem ?? 0).toFixed(4)}/item (${cost.calls} live, ${cost.cachedCalls} cached)`);
    console.log(`  latency       ${Math.round(summary.msPerItem)} ms/item (cached entries report their original latency)`);
    console.log(`\n  outputs saved under ${path.relative(REPO, CACHE_DIR)}/content__* for manual spot-checks`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
