/*
 * Deterministic unit tests for the identification scorer (no API, no photos).
 * Run:  node --test pipeline/eval/score.test.js
 * These lock the scoring logic so the eval's numbers stay trustworthy.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreCase, aggregate, gate } = require('./score');

const EXP = {
  brand: 'Nike', brand_min_confidence: 0.6, model: ['Dunk'],
  category: 'footwear', subcategory_any: ['sneakers', 'high top sneakers'],
  condition_rating: 'Gently used', primary_color: 'brown',
};

test('a correct output passes every evaluated field', () => {
  const r = scoreCase(EXP, {
    resembles_brand: 'Nike', brand_confidence: 0.8, model: 'Dunk Low',
    category: 'footwear', subcategory: 'high top sneakers',
    condition_rating: 'Gently used', primary_color: 'brown',
  });
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v !== 'skip')),
    { brand: 'pass', model: 'pass', category: 'pass', subcategory: 'pass', condition: 'pass', color: 'pass' }
  );
  assert.strictEqual(r.nwtViolation, false);
});

test('right brand but under-confidence is a miss', () => {
  const r = scoreCase(EXP, { resembles_brand: 'Nike', brand_confidence: 0.4 });
  assert.strictEqual(r.fields.brand, 'fail');
});

test('"unclear" brand fails the brand field', () => {
  const r = scoreCase(EXP, { resembles_brand: 'unclear', brand_confidence: 0.3 });
  assert.strictEqual(r.fields.brand, 'fail');
});

test('model found in subcategory/search_keywords still counts', () => {
  const r = scoreCase(EXP, { subcategory: 'dunk low sneakers', search_keywords: [] });
  assert.strictEqual(r.fields.model, 'pass');
});

test('NWT rated Used is a hard violation', () => {
  const r = scoreCase({ condition_rating: 'New with tags' }, { condition_rating: 'Used' });
  assert.strictEqual(r.fields.condition, 'fail');
  assert.strictEqual(r.nwtViolation, true);
});

test('empty expected fields are skipped, not failed', () => {
  const r = scoreCase({ brand: 'Nike', brand_min_confidence: 0.5 }, { resembles_brand: 'Nike', brand_confidence: 0.9 });
  assert.strictEqual(r.fields.category, 'skip');
  assert.strictEqual(r.fields.condition, 'skip');
});

test('aggregate + gate: a passing set clears the bars', () => {
  const results = [
    scoreCase(EXP, { resembles_brand: 'Nike', brand_confidence: 0.8, model: 'Dunk', category: 'footwear', subcategory: 'sneakers', condition_rating: 'Gently used', primary_color: 'brown' }),
    scoreCase({ brand: 'Carhartt', brand_min_confidence: 0.6, category: 'outerwear', subcategory_any: ['jacket'], condition_rating: 'Used' },
      { resembles_brand: 'Carhartt', brand_confidence: 0.9, category: 'outerwear', subcategory: 'work jacket', condition_rating: 'Used' }),
  ];
  const agg = aggregate(results);
  assert.strictEqual(agg.rate('brand'), 1);
  assert.strictEqual(agg.nwtViolations, 0);
  assert.strictEqual(gate(agg).pass, true);
});

test('aggregate + gate: an NWT violation fails the gate', () => {
  const agg = aggregate([scoreCase({ condition_rating: 'New with tags' }, { condition_rating: 'Used' })]);
  assert.strictEqual(agg.nwtViolations, 1);
  assert.strictEqual(gate(agg).pass, false);
});

test('diacritics do not fail a correct answer (Garçons vs Garcons)', () => {
  const r = scoreCase(
    { collaboration: 'Comme des Garcons', brand: 'Supreme', brand_min_confidence: 0.5 },
    { collaboration: 'Comme des Garçons', resembles_brand: 'Supreme', brand_confidence: 0.9 }
  );
  assert.strictEqual(r.fields.collaboration, 'pass');
});
