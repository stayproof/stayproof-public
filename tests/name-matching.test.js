// Behavioral tests for the extracted public name-matching module.
// Imports MUST come from '../src/shared/name-matching.js' (not scoring.js)
// to prove the extraction is clean and the public module stands alone.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  nameMatchConfidence,
  stripDiacritics,
  jaroWinkler,
  softTfIdfScore,
  compoundVariants,
  bigramDiceOnStripped,
} = require('../src/shared/name-matching.js');

// Also import from scoring.js — proves re-export keeps back-compat
const scoring = require('../src/shared/scoring.js');

const corpus = require('./fixtures/name-matching-corpus.json');

function assertApprox(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual.toFixed(4)})`);
}

describe('name-matching module — public API', () => {
  it('Test 1: exact-match baseline — Park Hyatt Saigon >= 0.95', () => {
    const conf = nameMatchConfidence('Park Hyatt Saigon', 'Park Hyatt Saigon', 'Ho Chi Minh');
    assert.ok(conf >= 0.95,
      `exact match should score >= 0.95, got ${conf.toFixed(4)}`);
  });

  it('Test 2: same-string short-circuit for generic tokens — Grand Plaza > 0.8', () => {
    const conf = nameMatchConfidence('Grand Plaza', 'Grand Plaza', 'Bangkok');
    assert.ok(conf > 0.8,
      `same-string generic tokens should still score > 0.8, got ${conf.toFixed(4)}`);
  });

  it('Test 3: empty input guard — nameMatchConfidence("", "X") returns 0', () => {
    assert.strictEqual(nameMatchConfidence('', 'X', 'City'), 0);
    assert.strictEqual(nameMatchConfidence('X', '', 'City'), 0);
    assert.strictEqual(nameMatchConfidence('', '', 'City'), 0);
  });

  it('Test 4: extracted module stands alone — importing from name-matching.js works', () => {
    // Already proven by the require at top of file, but an explicit sanity check:
    assert.strictEqual(typeof nameMatchConfidence, 'function');
    assert.strictEqual(typeof stripDiacritics, 'function');
    assert.strictEqual(typeof jaroWinkler, 'function');
    assert.strictEqual(typeof softTfIdfScore, 'function');
    assert.strictEqual(typeof compoundVariants, 'function');
    assert.strictEqual(typeof bigramDiceOnStripped, 'function');
  });

  it('Test 5: scoring.js still re-exports nameMatchConfidence (back-compat)', () => {
    assert.strictEqual(typeof scoring.nameMatchConfidence, 'function');
    // And it returns the same value as the direct public import
    const viaScoring = scoring.nameMatchConfidence('Park Hyatt Saigon', 'Park Hyatt Saigon', 'Ho Chi Minh');
    const viaPublic = nameMatchConfidence('Park Hyatt Saigon', 'Park Hyatt Saigon', 'Ho Chi Minh');
    assert.strictEqual(viaScoring, viaPublic,
      'scoring.js re-export must delegate to the public implementation');
  });

  it('Test 6: jaroWinkler("martha", "marhta") ≈ 0.96 (standard JW test vector)', () => {
    const jw = jaroWinkler('martha', 'marhta');
    assertApprox(jw, 0.9611, 0.01, 'standard JW test vector');
  });

  it('Test 7: stripDiacritics("Đà Nẵng") returns "Da Nang"', () => {
    assert.strictEqual(stripDiacritics('Đà Nẵng'), 'Da Nang');
  });
});

// ─── Corpus regression baseline (loose bounds) ───────────────────────
// Private scoring.test.js has tight bounds; this public test only needs
// to catch gross regressions. Loose bounds:
//   - expected=true entries must score >= 0.7
//   - expected=false entries must score < 0.95
// This still catches "function is broken" but doesn't leak calibrated thresholds.

describe('name-matching module — corpus regression (loose bounds)', () => {
  var trueEntries = corpus.filter(function (e) { return e.expected === true; });
  var falseEntries = corpus.filter(function (e) { return e.expected === false; });

  it('at least 90% of expected=true entries score >= 0.7', () => {
    var passing = 0;
    var failures = [];
    trueEntries.forEach(function (e) {
      var conf = nameMatchConfidence(e.nameA, e.nameB, e.city);
      if (conf >= 0.7) passing++;
      else failures.push({ a: e.nameA, b: e.nameB, city: e.city, got: conf.toFixed(3) });
    });
    var pct = passing / trueEntries.length;
    assert.ok(pct >= 0.9,
      'expected 90%+ of true-positive corpus entries to score >= 0.7, got '
      + (pct * 100).toFixed(1) + '% (' + passing + '/' + trueEntries.length + '). '
      + 'Failures sample: ' + JSON.stringify(failures.slice(0, 5)));
  });

  it('at least 90% of expected=false entries score < 0.95 (loose regression bound)', () => {
    // Tight precision bounds live in private scoring.test.js. This loose bound
    // catches catastrophic regressions (e.g., "matcher now says everything matches")
    // while tolerating a small number of known hard-negative edge cases that the
    // shipping algorithm already over-scores (e.g., "Marriott Resort & Spa X" vs
    // "Marriott Suites X" in the Da Nang corpus).
    var passing = 0;
    var leaks = [];
    falseEntries.forEach(function (e) {
      var conf = nameMatchConfidence(e.nameA, e.nameB, e.city);
      if (conf < 0.95) passing++;
      else leaks.push({ a: e.nameA, b: e.nameB, city: e.city, got: conf.toFixed(3) });
    });
    var pct = passing / falseEntries.length;
    assert.ok(pct >= 0.9,
      'expected 90%+ of false-positive corpus entries to score < 0.95, got '
      + (pct * 100).toFixed(1) + '% (' + passing + '/' + falseEntries.length + '). '
      + 'Leaks sample: ' + JSON.stringify(leaks.slice(0, 5)));
  });
});
