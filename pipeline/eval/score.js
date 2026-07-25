/*
 * Pure scoring for the AI identification eval (no I/O, no API) — unit-tested in
 * score.test.js. Compares one expected.json against one extractAttributes output
 * and reports per-field pass/fail/skip, plus the hard "NWT was mis-rated Used"
 * violation the tester hit.
 *
 * Matching is intentionally lenient (contains, either direction, normalized) so
 * a correct answer phrased slightly differently ("sneakers" vs "high top
 * sneakers") still passes — we're measuring identification, not string equality.
 */

// Strip diacritics before comparing — "Comme des Garçons" must match an
// expected "Comme des Garcons" (2026-07 sweep: all three models were marked
// wrong on a collab they answered correctly, purely on the cedilla).
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** true if either normalized string contains the other (non-empty). */
function contains(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}
function anyContains(haystack, terms) {
  return (terms || []).some((t) => contains(haystack, t));
}

/**
 * @param {object} expected - fixture ground truth (see fixtures README)
 * @param {object} actual   - extractAttributes output (or a sample_response.json)
 * @returns {{fields: Record<string,'pass'|'fail'|'skip'>, nwtViolation: boolean, notes: string[]}}
 */
function scoreCase(expected, actual) {
  const fields = {};
  const notes = [];
  actual = actual || {};

  // Brand: right label AND confident enough (an under-confident correct brand
  // still makes the copy hedge/omit it — so it counts as a miss).
  if (!expected.brand || norm(expected.brand) === 'unclear') fields.brand = 'skip';
  else {
    const labelOk = contains(actual.resembles_brand, expected.brand);
    const confOk = Number(actual.brand_confidence ?? 0) >= Number(expected.brand_min_confidence ?? 0);
    fields.brand = labelOk && confOk ? 'pass' : 'fail';
    if (labelOk && !confOk) notes.push(`brand "${actual.resembles_brand}" matched but confidence ${actual.brand_confidence} < ${expected.brand_min_confidence}`);
    if (!labelOk) notes.push(`brand: expected "${expected.brand}", got "${actual.resembles_brand}"`);
  }

  // Model/silhouette: accept it appearing in model, subcategory, or search_keywords.
  if (!expected.model || !expected.model.length) fields.model = 'skip';
  else {
    const hay = [actual.model, actual.subcategory, ...(actual.search_keywords || [])].join(' ');
    fields.model = anyContains(hay, expected.model) ? 'pass' : 'fail';
    if (fields.model === 'fail') notes.push(`model: expected one of ${JSON.stringify(expected.model)}, none found in "${hay.trim()}"`);
  }

  // Collaboration (collab pieces only).
  if (!expected.collaboration) fields.collaboration = 'skip';
  else fields.collaboration = contains(actual.collaboration, expected.collaboration) ? 'pass' : 'fail';

  if (!expected.category) fields.category = 'skip';
  else fields.category = contains(actual.category, expected.category) ? 'pass' : 'fail';

  if (!expected.subcategory_any || !expected.subcategory_any.length) fields.subcategory = 'skip';
  else fields.subcategory = anyContains(actual.subcategory, expected.subcategory_any) ? 'pass' : 'fail';

  // Condition (exact) + the hard NWT rule.
  let nwtViolation = false;
  if (!expected.condition_rating) fields.condition = 'skip';
  else {
    fields.condition = norm(actual.condition_rating) === norm(expected.condition_rating) ? 'pass' : 'fail';
    if (norm(expected.condition_rating) === 'new with tags' && norm(actual.condition_rating) === 'used') {
      nwtViolation = true;
      notes.push('NWT VIOLATION: a new-with-tags item was rated "Used"');
    }
  }

  if (!expected.primary_color) fields.color = 'skip';
  else fields.color = contains(actual.primary_color, expected.primary_color) ? 'pass' : 'fail';

  if (!expected.size) fields.size = 'skip';
  else fields.size = contains(actual.size, expected.size) ? 'pass' : 'fail';

  return { fields, nwtViolation, notes };
}

/** Roll up many case results into per-field accuracy + overall + NWT violations. */
function aggregate(caseResults) {
  const per = {};
  let nwtViolations = 0;
  for (const r of caseResults) {
    if (r.nwtViolation) nwtViolations++;
    for (const [f, v] of Object.entries(r.fields)) {
      per[f] = per[f] || { pass: 0, evaluated: 0 };
      if (v === 'skip') continue;
      per[f].evaluated++;
      if (v === 'pass') per[f].pass++;
    }
  }
  const rate = (f) => (per[f] && per[f].evaluated ? per[f].pass / per[f].evaluated : null);
  const evaluated = Object.values(per).reduce((s, x) => s + x.evaluated, 0);
  const passed = Object.values(per).reduce((s, x) => s + x.pass, 0);
  return { per, rate, overall: evaluated ? passed / evaluated : null, nwtViolations, cases: caseResults.length };
}

/** Default gate: the bars a change must not regress below. */
const GATE = { brand: 0.7, condition: 0.7, category: 0.8, subcategory: 0.6 };
function gate(agg, bars = GATE) {
  const fails = [];
  for (const [f, bar] of Object.entries(bars)) {
    const r = agg.rate(f);
    if (r != null && r < bar) fails.push(`${f} ${(r * 100).toFixed(0)}% < ${(bar * 100).toFixed(0)}%`);
  }
  if (agg.nwtViolations > 0) fails.push(`${agg.nwtViolations} NWT→Used violation(s)`);
  return { pass: fails.length === 0, fails };
}

module.exports = { scoreCase, aggregate, gate, GATE, contains };
