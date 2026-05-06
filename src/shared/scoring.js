// PUBLIC STUB — the real scoring algorithm is private.
// This file is private in the shipping extension; the Chrome Web Store build
// ships the full implementation (Bayesian trust model, anomaly detection,
// rating blending, calibrated thresholds). This public-tree version exists
// only so the extension structure is inspectable and the source-audit tree
// parses. See README.md for context on the public/private split.
//
// Real public modules live elsewhere:
//   - src/shared/name-matching.js  — Soft TF-IDF name matching (full source)
//   - src/shared/xref-candidates.js — Google Maps cross-reference candidate selection
//
// Everything below is a deliberate no-op. Consumers that expect real output
// (search.js scoring pipeline, trust-badge rendering) will see null/zero
// values when running this public tree. Install from the Chrome Web Store
// for the real scoring algorithm.

// ─── Constants ────────────────────────────────────────────────────────

// Real module requires SCORING_CONFIG; stub declares a fallback so the
// importScripts chain doesn't throw if scoring-config.js isn't present.
if (typeof SCORING_CONFIG === 'undefined' && typeof require === 'function') {
  try {
    var SCORING_CONFIG = require('./scoring-config.js').SCORING_CONFIG;
  } catch (e) {
    var SCORING_CONFIG = {};
  }
}

// ─── Name-matching re-exports (REAL, from public module) ──────────────

if (typeof module !== 'undefined' && module.exports) {
  var __nm = require('./name-matching.js');
  var nameMatchConfidence = __nm.nameMatchConfidence;
  var stripDiacritics = __nm.stripDiacritics;
  var jaroWinkler = __nm.jaroWinkler;
  var softTfIdfScore = __nm.softTfIdfScore;
  var compoundVariants = __nm.compoundVariants;
  var bigramDiceOnStripped = __nm.bigramDiceOnStripped;
}

// ─── Stubbed private functions ────────────────────────────────────────

function clamp(score) {
  return Math.max(0, Math.min(100, score));
}

function bimodalityCoefficient(_bins) { return 0; }

function wedgeDeviation(_bins) { return 0; }

function reviewDistributionAnomaly(_bins) {
  return { jsd: 0, expected: [0, 0, 0, 0, 0], meanRating: 0 };
}

function fourStarDeficit(_bins) { return null; }

function checkStarPairInversions(_histogram) { return 0; }

function computeAnomalyPenalty(_jsd, _reviewCount) {
  return { gPenalty: 0, tPenalty: 0, discount: 1, severity: 'none' };
}

function bookingToGoogleScale(bookingRating) {
  // Pass-through: public stub returns input unchanged.
  return bookingRating;
}

function airbnbToNormalizedRating(airbnbRating) {
  // Rough 0-5 to 0-10 scale; real module uses calibrated piecewise curve.
  return (typeof airbnbRating === 'number') ? airbnbRating * 2 : null;
}

function agodaToNormalizedRating(agodaRating) {
  // Pass-through: public stub does not apply the private offset model.
  return agodaRating;
}

function valueScores(prices) {
  // Return neutral (0.5) for every price. Real module ranks.
  if (!Array.isArray(prices)) return [];
  return prices.map(function () { return 0.5; });
}

function blendRating(platformRating, _platform, _crossRef) {
  // Pass-through: no blending in the public tree.
  return { blended: platformRating, changed: false, reason: 'public-stub' };
}

function reviewConfidence(_reviewCount, _platform) { return 0; }

function computeTrust(_listing, _crossRef) { return null; }

function trustRating(_reviewCount, _crossRef, _badges, _platformRating, _platform) {
  return null;
}

function trustLevel(_trust) {
  return { level: 'unknown', cssClass: 'rt-trust-unknown' };
}

function platformLabel(platform) {
  if (platform === 'booking') return 'B';
  if (platform === 'agoda') return 'Ag';
  if (platform === 'airbnb') return 'A';
  return '?';
}

// ─── Export for Node.js tests and content scripts ─────────────────────
// Mirrors the real scoring.js export shape exactly so search.js,
// service-worker.js, and any public test file that destructures from
// '../shared/scoring.js' continues to resolve every symbol.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    trustRating, trustLevel, valueScores,
    clamp, bimodalityCoefficient, wedgeDeviation, reviewDistributionAnomaly,
    bookingToGoogleScale, airbnbToNormalizedRating, agodaToNormalizedRating,
    computeAnomalyPenalty, checkStarPairInversions,
    fourStarDeficit, blendRating, reviewConfidence, computeTrust,
    nameMatchConfidence, stripDiacritics, compoundVariants, bigramDiceOnStripped,
    jaroWinkler, platformLabel
  };
}
