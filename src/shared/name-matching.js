// Public module. Soft TF-IDF name matching. No private thresholds.
//
// Extracted from src/shared/scoring.js so the public repo can ship the
// matching logic unchanged while the scoring algorithm and its calibrated
// thresholds stay private. This file contains:
//
//   - stripDiacritics       — Unicode NFD + d-bar normalization
//   - compoundVariants      — adjacent-token concatenations for bigram rescue
//   - bigramDiceOnStripped  — Sorensen-Dice on joined-token character bigrams
//   - jaroWinkler           — Winkler (1990) prefix-weighted similarity
//   - softTfIdfScore        — Cohen et al. (2003) IDF-weighted fuzzy cosine
//   - nameMatchConfidence   — end-to-end property-name similarity (0-1)
//
// Dual-export pattern: top-level `var`/`function` declarations so Chrome
// `importScripts('../shared/name-matching.js')` exposes them as globals
// for content scripts, plus a trailing Node `module.exports` block for tests.
//
// No dependency on scoring-config. All heuristic constants are literal
// and match values that ship in the extension today.

/**
 * Strip diacritical marks and normalize Đ/đ (Vietnamese d-bar) to D/d.
 */
function stripDiacritics(str) {
  return str
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Generate compound-word concatenations of adjacent token runs.
 * For ["grand", "star", "city"] produces:
 *   Pairs:  ["grandstar", "starcity"]
 *   Triples: ["grandstarcity"]
 *   Full (4+ tokens): [tokens.join('')]
 *
 * @param {string[]} tokens - Array of word tokens
 * @returns {string[]} Compound variant strings
 */
function compoundVariants(tokens) {
  var variants = [];
  // Adjacent pairs
  for (var i = 0; i < tokens.length - 1; i++) {
    variants.push(tokens[i] + tokens[i + 1]);
  }
  // Adjacent triples
  for (var i = 0; i < tokens.length - 2; i++) {
    variants.push(tokens[i] + tokens[i + 1] + tokens[i + 2]);
  }
  // Full concatenation for 4+ tokens
  if (tokens.length >= 4) {
    variants.push(tokens.join(''));
  }
  return variants;
}

/**
 * Compute Sorensen-Dice coefficient on character bigrams of joined token strings.
 * Input: pre-filtered token arrays (stop words and city already removed).
 * Formula: DSC = 2 * |intersection| / (|A| + |B|)
 *
 * @param {string[]} tokA - Token array A
 * @param {string[]} tokB - Token array B
 * @returns {number} Dice coefficient 0-1
 */
function bigramDiceOnStripped(tokA, tokB) {
  var sA = tokA.join('');
  var sB = tokB.join('');
  if (sA.length < 2 || sB.length < 2) return 0;
  function extractBigrams(s) {
    var b = new Map();
    for (var i = 0; i < s.length - 1; i++) {
      var pair = s[i] + s[i + 1];
      b.set(pair, (b.get(pair) || 0) + 1);
    }
    return b;
  }
  var biA = extractBigrams(sA);
  var biB = extractBigrams(sB);
  var totalA = 0, totalB = 0, matchCount = 0;
  biA.forEach(function (c) { totalA += c; });
  biB.forEach(function (c) { totalB += c; });
  biA.forEach(function (cA, pair) {
    matchCount += Math.min(cA, biB.get(pair) || 0);
  });
  if (totalA + totalB === 0) return 0;
  return (2 * matchCount) / (totalA + totalB);
}

/**
 * Jaro-Winkler similarity between two strings.
 * Better calibrated than bigram Dice for short token comparison (3-10 chars).
 * Source: standard algorithm from Winkler (1990).
 *
 * @param {string} s1 - First string
 * @param {string} s2 - Second string
 * @returns {number} Similarity score 0-1
 */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  var len1 = s1.length, len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  var matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  var s1Matches = [];
  var s2Matches = [];
  for (var x = 0; x < len1; x++) s1Matches[x] = false;
  for (var x = 0; x < len2; x++) s2Matches[x] = false;
  var matches = 0, transpositions = 0;

  for (var i = 0; i < len1; i++) {
    var start = Math.max(0, i - matchDist);
    var end = Math.min(i + matchDist + 1, len2);
    for (var j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  var k = 0;
  for (var i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  var jaro = (matches / len1 + matches / len2 +
    (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus (up to 4 chars, p=0.1)
  var prefix = 0;
  for (var i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ─── Hospitality IDF Table ────────────────────────────────────────────
// Static IDF weights for Soft TF-IDF entity matching (Cohen et al. 2003).
// Higher = more distinctive (brand names), Lower = more common (noise).
// Unknown tokens default to DEFAULT_IDF (distinctive by definition).

var HOSPITALITY_IDF = {
  // Generic descriptors (medium signal — common in hotel names but not noise)
  'spa': 0.4, 'beach': 0.5, 'pool': 0.4, 'view': 0.4,
  'garden': 0.5, 'terrace': 0.5, 'tower': 0.5,
  'palace': 0.6, 'park': 0.5, 'plaza': 0.6,
  'central': 0.6, 'grand': 0.5, 'royal': 0.5, 'golden': 0.5,
  'premier': 0.6, 'premium': 0.6,
  'point': 0.5, 'bay': 0.6, 'hill': 0.6, 'court': 0.6,
  'place': 0.5, 'centre': 0.5, 'center': 0.5,
  'height': 0.5, 'square': 0.6, 'riverside': 0.6,
  'lakeside': 0.6, 'island': 0.6, 'cove': 0.6,
  'beachfront': 0.5, 'oceanfront': 0.5, 'seaview': 0.5,
  // Generic adjectives (medium signal)
  'star': 0.5, 'gold': 0.5, 'sun': 0.5, 'moon': 0.5,
  'ocean': 0.5, 'sea': 0.5, 'sky': 0.5, 'green': 0.5,
  'blue': 0.5, 'white': 0.5, 'new': 0.5, 'old': 0.5,
  'nest': 0.6, 'eco': 0.5,
  // Chain/operator suffixes (medium signal)
  'collection': 0.5, 'portfolio': 0.5, 'autograph': 0.7,
  'tribute': 0.6, 'handwritten': 0.7,
  // Location pattern words (medium signal)
  'city': 0.5, 'town': 0.5, 'district': 0.5, 'quarter': 0.6,
  'north': 0.5, 'south': 0.5, 'east': 0.5, 'west': 0.5,
  'wing': 0.6,
  // Amenity/feature words (low signal — describe features, not property identity)
  'fitnes': 0.3, 'free': 0.3, 'sauna': 0.3, 'gym': 0.3,
  'netflix': 0.3, 'wifi': 0.3, 'parking': 0.3,
  'breakfast': 0.3, 'dinner': 0.3, 'lunch': 0.3,
  'rooftop': 0.3, 'panoramic': 0.3, 'daily': 0.3,
  'afternoon': 0.3, 'mobile': 0.3, 'checkin': 0.3
};

var DEFAULT_IDF = 1.5;

function idfWeight(token) {
  return HOSPITALITY_IDF[token] !== undefined ? HOSPITALITY_IDF[token] : DEFAULT_IDF;
}

/**
 * Soft TF-IDF similarity score (Cohen et al. 2003).
 * For each token in A, finds the best Jaro-Winkler match (>= 0.85) in B.
 * Scores are weighted by IDF and L2-normalized (cosine-style).
 *
 * @param {string[]} tokensA - Token array A
 * @param {string[]} tokensB - Token array B
 * @returns {number} Similarity score 0-1
 */
function softTfIdfScore(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  var score = 0;
  var sqSumA = 0;
  var sqSumB = 0;

  for (var i = 0; i < tokensA.length; i++) {
    var wA = idfWeight(tokensA[i]);
    sqSumA += wA * wA;

    var bestSim = 0;
    var bestWB = 0;
    for (var j = 0; j < tokensB.length; j++) {
      var sim = (tokensA[i] === tokensB[j]) ? 1 : jaroWinkler(tokensA[i], tokensB[j]);
      if (sim >= 0.85 && sim > bestSim) {
        bestSim = sim;
        bestWB = idfWeight(tokensB[j]);
      }
    }
    score += wA * bestSim * bestWB;
  }

  for (var j = 0; j < tokensB.length; j++) {
    var wB = idfWeight(tokensB[j]);
    sqSumB += wB * wB;
  }

  if (sqSumA === 0 || sqSumB === 0) return 0;
  return score / Math.sqrt(sqSumA * sqSumB);
}

/**
 * Name match confidence — Soft TF-IDF with Jaro-Winkler fuzzy token matching.
 * Uses IDF-weighted tokens instead of binary stop-word removal.
 * L2-normalized (cosine-style) for principled asymmetric name handling.
 *
 * @param {string} bookingName
 * @param {string} googleName
 * @param {string} [city] - City name for geographic token filtering
 * @returns {number} 0-1 similarity score
 */
function nameMatchConfidence(bookingName, googleName, city) {
  if (!bookingName || !googleName) return 0;

  // Strip "Formerly/Previously" alias suffixes from names before matching.
  bookingName = bookingName.replace(/\s*[-–—·]\s*(?:formerly|previously)\b.*/i, '');
  googleName = googleName.replace(/\s*[-–—·]\s*(?:formerly|previously)\b.*/i, '');

  // Strip Booking.com promotional suffixes after " - ".
  // Keep the unstripped name for retry if score is low.
  var bookingNameFull = bookingName;
  var dashSplit = bookingName.split(/\s+-\s+/);
  if (dashSplit.length > 1 && dashSplit[0].trim().split(/\s+/).length >= 2) {
    bookingName = dashSplit[0].trim();
  }

  // Build city tokens to filter geographic noise
  var cityTokens = [];
  if (city) {
    var baseStopWords = ['hotel', 'resort', 'hostel', 'motel', 'inn', 'lodge', 'suites', 'suite',
      'apartment', 'apartments', 'residence', 'residences', 'boutique', 'spa',
      'building', 'office', 'villas', 'villa', 'house', 'home', 'homes', 'homestay',
      'the', 'a', 'an', 'and', '&', 'by', 'at', 'de', 'la', 'le', 'el', 'da', 'do', 'di',
      'khach', 'san', 'nha', 'nghi', 'can', 'ho'];
    var rawCityTokens = stripDiacritics(city).toLowerCase().replace(/[^a-z0-9\s]/g, '')
      .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .split(/\s+/).filter(function (w) {
        return w.length > 1 && baseStopWords.indexOf(w) === -1;
      });
    cityTokens = rawCityTokens.slice();
    if (rawCityTokens.length >= 1) {
      var allCityParts = stripDiacritics(city).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function (w) { return w.length > 0; });
      if (allCityParts.length >= 2) {
        cityTokens.push(allCityParts.join(''));
      }
    }
  }

  // Stop words: accommodation types, determiners, Vietnamese hospitality terms.
  // These are removed during tokenization (same as before), letting Soft TF-IDF
  // operate on the distinctive tokens that actually identify properties.
  var stopWords = ['hotel', 'resort', 'hostel', 'motel', 'inn', 'lodge', 'suites', 'suite',
    'apartment', 'apartments', 'residence', 'residences', 'boutique', 'spa',
    'building', 'office', 'villas', 'villa', 'house', 'home', 'homes', 'homestay',
    'restaurant', 'cafe', 'bar',
    'the', 'a', 'an', 'and', '&', 'by', 'at', 'de', 'la', 'le', 'el', 'da', 'do', 'di',
    'khach', 'san', 'nha', 'nghi', 'can', 'ho'];

  function tokenize(name, stops) {
    return stripDiacritics(name).toLowerCase().replace(/[''’]s\b/g, '').replace(/[^a-z0-9\s]/g, '')
      .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .split(/\s+/).filter(function (w) {
        return w.length > 0 && stops.indexOf(w) === -1;
      }).map(function (w) {
        if (w.length > 3 && w[w.length - 1] === 's') return w.slice(0, -1);
        return w;
      });
  }

  var allStops = stopWords.concat(cityTokens);
  var tokensA = tokenize(bookingName, allStops);
  var tokensB = tokenize(googleName, allStops);

  // Fallback: if city filtering emptied both sides, retry without city tokens
  if (tokensA.length === 0 && tokensB.length === 0 && cityTokens.length > 0) {
    tokensA = tokenize(bookingName, stopWords);
    tokensB = tokenize(googleName, stopWords);
  }

  if (tokensA.length === 0 && tokensB.length === 0) return 0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Single low-IDF token guard: when both sides reduce to a single shared
  // low-IDF token (e.g., "terrace"), check if the original names diverge.
  var genericWords = ['terrace', 'tower', 'palace', 'garden',
    'park', 'plaza', 'central', 'grand', 'royal', 'golden', 'premier',
    'view', 'point', 'bay', 'beach', 'hill', 'court', 'place', 'centre', 'center',
    'height', 'square', 'star', 'gold', 'sun', 'moon', 'ocean', 'sea', 'sky',
    'green', 'blue', 'white', 'riverside', 'lakeside', 'island', 'cove', 'nest'];
  if (tokensA.length === 1 && tokensB.length === 1 && tokensA[0] === tokensB[0]
    && genericWords.indexOf(tokensA[0]) !== -1) {
    var rawA = tokenize(bookingName, []);
    var rawB = tokenize(googleName, []);
    var rawMatch = rawA.length === rawB.length && rawA.every(function (t, i) { return t === rawB[i]; });
    if (!rawMatch) return 0;
  }

  // Asymmetric single generic token guard
  if ((tokensA.length === 1 && tokensB.length > 1 && genericWords.indexOf(tokensA[0]) !== -1
        && tokensB.indexOf(tokensA[0]) !== -1)
      || (tokensB.length === 1 && tokensA.length > 1 && genericWords.indexOf(tokensB[0]) !== -1
          && tokensA.indexOf(tokensB[0]) !== -1)) {
    var rawA = tokenize(bookingName, []);
    var rawB = tokenize(googleName, []);
    var rawSetA = {};
    var rawSetB = {};
    rawA.forEach(function (t) { rawSetA[t] = true; });
    rawB.forEach(function (t) { rawSetB[t] = true; });
    var aSubsetB = Object.keys(rawSetA).every(function (k) { return rawSetB[k]; });
    var bSubsetA = Object.keys(rawSetB).every(function (k) { return rawSetA[k]; });
    var rawIntersection = 0;
    Object.keys(rawSetA).forEach(function (k) { if (rawSetB[k]) rawIntersection++; });
    var rawUnion = Object.keys(rawSetA).length + Object.keys(rawSetB).length - rawIntersection;
    var rawJaccard = rawIntersection / rawUnion;
    if (!aSubsetB && !bSubsetA && rawJaccard < 0.5) return 0;
  }

  // Compute Soft TF-IDF score — IDF-weighted tokens with JW fuzzy matching
  var score = softTfIdfScore(tokensA, tokensB);

  // Google subset check: if ALL Google tokens exist in booking tokens,
  // Google name is a truncation. Score based on coverage for building-name FPs.
  var setA = {};
  var setB = {};
  tokensA.forEach(function (t) { setA[t] = true; });
  tokensB.forEach(function (t) { setB[t] = true; });
  var sizeA = Object.keys(setA).length;
  var sizeB = Object.keys(setB).length;

  // Google subset check: if ALL Google tokens exist in booking tokens,
  // Google name is a truncation. Use blended overlap+Jaccard for these cases
  // since Soft TF-IDF over-penalizes extra unmatched tokens on the longer side.
  var googleSubset = Object.keys(setB).every(function (k) { return setA[k]; });
  if (googleSubset) {
    var shorter = Math.min(sizeA, sizeB);
    var exactIntersection = 0;
    Object.keys(setB).forEach(function (k) { if (setA[k]) exactIntersection++; });
    var overlapScore = exactIntersection / shorter;
    var union = sizeA + sizeB - exactIntersection;
    var jaccardScore = exactIntersection / union;
    var blendedScore = overlapScore * 0.6 + jaccardScore * 0.4;
    var coverage = sizeB / sizeA;
    // Discount for unmatched brand-distinctive tokens on the booking side.
    // When the only overlap is on generic tokens (e.g., "Sari") and booking
    // has additional brand tokens ("Kano"), the blended score is too generous.
    // Only apply when exact intersection is small and unmatched tokens are all
    // brand-distinctive (not known hospitality/location words).
    if (exactIntersection <= 1 && sizeA > sizeB) {
      var unmatchedBooking = Object.keys(setA).filter(function (k) { return !setB[k]; });
      var allBrandDistinctive = unmatchedBooking.length > 0 && unmatchedBooking.every(function (k) {
        return idfWeight(k) >= 1.0 && k.length >= 4; // brand name: not in IDF table AND >= 4 chars
      });
      if (allBrandDistinctive) {
        blendedScore = Math.min(blendedScore, score);
      }
    }
    if (coverage >= 0.5 || sizeB < 3) return blendedScore;
    return blendedScore * coverage;
  }

  // Reverse-subset penalty: booking tokens all in Google, but Google has
  // unmatched extra tokens (likely different property). Only apply when
  // booking covers a moderate fraction of Google — high extra-token counts
  // (addresses) are naturally penalized by Soft TF-IDF's L2 norm.
  var bookingSubset = Object.keys(setA).every(function (k) { return setB[k]; });
  if (bookingSubset && sizeB > sizeA) {
    var extraGoogleTokens = Object.keys(setB).filter(function (k) { return !setA[k]; });
    var unmatchedExtra = 0;
    for (var ei = 0; ei < extraGoogleTokens.length; ei++) {
      var hasMatch = false;
      for (var ai = 0; ai < tokensA.length; ai++) {
        if (jaroWinkler(extraGoogleTokens[ei], tokensA[ai]) >= 0.85) { hasMatch = true; break; }
      }
      if (!hasMatch) unmatchedExtra++;
    }
    if (unmatchedExtra > 0) {
      var bookingCoverage = sizeA / sizeB;
      // Weight penalty by how many unmatched tokens are known descriptors
      // (in HOSPITALITY_IDF). Unknown tokens (addresses, brand names) are
      // supplementary and shouldn't penalize as heavily.
      var knownUnmatched = 0;
      for (var kui = 0; kui < extraGoogleTokens.length; kui++) {
        var hasJwMatch = false;
        for (var ai = 0; ai < tokensA.length; ai++) {
          if (jaroWinkler(extraGoogleTokens[kui], tokensA[ai]) >= 0.85) { hasJwMatch = true; break; }
        }
        if (!hasJwMatch && HOSPITALITY_IDF[extraGoogleTokens[kui]] !== undefined) knownUnmatched++;
      }
      var extraRatio = unmatchedExtra / sizeB;
      var knownRatio = unmatchedExtra > 0 ? knownUnmatched / unmatchedExtra : 0;
      var penaltyStrength = Math.min(0.3, (1 - bookingCoverage) * extraRatio * (0.3 + knownRatio * 1.5));
      score *= (1 - penaltyStrength);
    }
  }

  // False positive guard: single-token overlap between names where the longer
  // has 2+ tokens — compound-word expansion + bigram Dice rescue
  // Use fuzzy intersection: count tokens matched via JW >= 0.85
  var intersection = 0;
  for (var bi = 0; bi < tokensB.length; bi++) {
    for (var ai = 0; ai < tokensA.length; ai++) {
      var sim = (tokensA[ai] === tokensB[bi]) ? 1 : jaroWinkler(tokensA[ai], tokensB[bi]);
      if (sim >= 0.85) { intersection++; break; }
    }
  }
  var longer = Math.max(sizeA, sizeB);
  if (intersection < 2 && longer >= 2) {
    var compA = compoundVariants(tokensA);
    var compB = compoundVariants(tokensB);
    var matchedCompound = null;
    for (var ci = 0; ci < compA.length; ci++) {
      if (setB[compA[ci]]) { matchedCompound = compA[ci]; break; }
    }
    if (!matchedCompound) {
      for (var ci = 0; ci < compB.length; ci++) {
        if (setA[compB[ci]]) { matchedCompound = compB[ci]; break; }
      }
    }
    if (!matchedCompound) {
      var compBSet = {};
      for (var ci = 0; ci < compB.length; ci++) { compBSet[compB[ci]] = true; }
      for (var ci = 0; ci < compA.length; ci++) {
        if (compBSet[compA[ci]]) { matchedCompound = compA[ci]; break; }
      }
    }
    if (matchedCompound) {
      var joinedA = tokensA.join('');
      var joinedB = tokensB.join('');
      var geoLen = Math.sqrt(joinedA.length * joinedB.length);
      var coverage = matchedCompound.length / geoLen;
      return Math.min(1, coverage * 0.85);
    }
    var dice = bigramDiceOnStripped(tokensA, tokensB);
    if (dice >= 0.7) return dice * 0.85;

    if (bookingNameFull !== bookingName) {
      var retryScore = nameMatchConfidence(bookingNameFull.replace(/\s+-\s+/g, ' '), googleName, city);
      if (retryScore > intersection * 0.3) return retryScore;
    }
    return intersection * 0.3;
  }

  // Operator/token mismatch guard: discount score when either side has
  // unmatched tokens. Skip if reverse-subset penalty already applied.
  var gOnly = Object.keys(setB).filter(function (k) { return !setA[k]; });
  var bOnly = Object.keys(setA).filter(function (k) { return !setB[k]; });
  var skipMismatch = bookingSubset && sizeB > sizeA; // already penalized above
  if (!skipMismatch && (gOnly.length > 0 || bOnly.length > 0)) {
    // Check if any unmatched tokens fuzzy-match across sides
    var fuzzyMatchedG = 0;
    for (var gi = 0; gi < gOnly.length; gi++) {
      for (var bi = 0; bi < tokensA.length; bi++) {
        if (jaroWinkler(gOnly[gi], tokensA[bi]) >= 0.85) { fuzzyMatchedG++; break; }
      }
    }
    var fuzzyMatchedB = 0;
    for (var bi = 0; bi < bOnly.length; bi++) {
      for (var gi = 0; gi < tokensB.length; gi++) {
        if (jaroWinkler(bOnly[bi], tokensB[gi]) >= 0.85) { fuzzyMatchedB++; break; }
      }
    }
    var unmatchedG = gOnly.length - fuzzyMatchedG;
    var unmatchedB = bOnly.length - fuzzyMatchedB;
    if (unmatchedG > 0 && unmatchedB > 0) {
      // Both sides have unmatched tokens — significant mismatch
      var unmatchedRatio = (unmatchedG + unmatchedB) / (sizeA + sizeB);
      score *= (1 - unmatchedRatio);
    } else if (unmatchedG > 0 && unmatchedB === 0) {
      // Only Google has unmatched — possible different property variant
      var unmatchedRatio = unmatchedG / sizeB;
      score *= (1 - unmatchedRatio * 0.5);
    }
  }

  // Dash-suffix retry: when a promotional suffix was stripped from bookingName
  // and the resulting score is not already a perfect match, re-run against
  // the unstripped name in case the suffix contained the distinguishing token.
  // (The private scoring.js wrapper originally gated this on a calibrated
  // CONFIDENCE_THRESHOLD, but because the retry only returns the higher of
  // the two scores, an unconditional retry is behaviorally equivalent and
  // keeps no tuning knobs in this public module.)
  if (bookingNameFull !== bookingName && score < 1) {
    var fullScore = nameMatchConfidence(bookingNameFull.replace(/\s+-\s+/g, ' '), googleName, city);
    if (fullScore > score) return fullScore;
  }

  return score;
}

// Export for both content scripts (via importScripts — globals above) and Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    nameMatchConfidence,
    stripDiacritics,
    jaroWinkler,
    softTfIdfScore,
    compoundVariants,
    bigramDiceOnStripped,
  };
}
