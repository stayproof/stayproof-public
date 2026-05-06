// Precision/Recall Harness for nameMatchConfidence
// Standalone script: node tests/harness/pr-harness.js
// Sweeps thresholds from 0.10 to 0.90, reports P/R/F1/F0.5 at each.

var { nameMatchConfidence } = require('../../src/shared/scoring.js');
var corpus = require('../fixtures/name-matching-corpus.json');

var thresholds = [];
for (var i = 10; i <= 90; i += 5) thresholds.push(i / 100);

var results = thresholds.map(function(threshold) {
  var tp = 0, fp = 0, fn = 0, tn = 0;
  corpus.forEach(function(pair) {
    var score = nameMatchConfidence(pair.nameA, pair.nameB, pair.city || null);
    var predicted = score >= threshold;
    if (pair.expected && predicted) tp++;
    else if (!pair.expected && predicted) fp++;
    else if (pair.expected && !predicted) fn++;
    else tn++;
  });
  var precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  var recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  var f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  var f05 = precision + recall > 0 ? 1.25 * precision * recall / (0.25 * precision + recall) : 0;
  return { threshold: threshold, tp: tp, fp: fp, fn: fn, tn: tn,
           precision: Math.round(precision * 1000) / 1000,
           recall: Math.round(recall * 1000) / 1000,
           f1: Math.round(f1 * 1000) / 1000,
           f05: Math.round(f05 * 1000) / 1000 };
});

console.log('Precision/Recall Report');
console.log('Algorithm: nameMatchConfidence');
console.log('Corpus: ' + corpus.length + ' pairs (' +
  corpus.filter(function(e) { return e.expected; }).length + ' positive, ' +
  corpus.filter(function(e) { return !e.expected; }).length + ' negative)');
console.log('');
results.forEach(function(r) {
  console.log('T=' + r.threshold.toFixed(2) +
    '  P=' + r.precision.toFixed(3) +
    '  R=' + r.recall.toFixed(3) +
    '  F1=' + r.f1.toFixed(3) +
    '  F0.5=' + r.f05.toFixed(3) +
    '  (TP=' + r.tp + ' FP=' + r.fp + ' FN=' + r.fn + ' TN=' + r.tn + ')');
});
