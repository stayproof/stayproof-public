/* Xref candidate selection — pure function for deciding which listings
   get auto-triggered Google Maps lookups and which show Check buttons. */

var XREF_AUTO_BUDGET = 20;
var XREF_POOL_CAP = 30;

var TERMINAL_STATES = { scored: 1, 'not-found': 1, failed: 1, checking: 1, na: 1, pending: 1 };

/**
 * Select cross-reference candidates from all listings.
 * @param {Array} allListings - All scraped listings
 * @param {number|null} maxPrice - Price ceiling ($/night), null/Infinity = no filter
 * @param {Object} currentXrefState - Current xref states keyed by URL
 * @returns {{ autoTrigger: string[], eligible: string[], updatedState: Object }}
 */
function selectXrefCandidates(allListings, maxPrice, currentXrefState) {
  var shouldFilterPrice = maxPrice != null && isFinite(maxPrice) && maxPrice > 0;

  // Partition by platform (skip airbnb)
  var booking = [];
  var agoda = [];
  for (var i = 0; i < allListings.length; i++) {
    var lst = allListings[i];
    if (lst.platform !== 'booking' && lst.platform !== 'agoda') continue;

    // Price filter
    if (shouldFilterPrice) {
      var effectivePrice = lst._pricePerNight != null ? lst._pricePerNight : lst.price;
      if (effectivePrice != null && effectivePrice > maxPrice) continue;
    }

    if (lst.platform === 'booking') booking.push(lst);
    else agoda.push(lst);
  }

  // Sort each platform by _normalizedRating descending
  var ratingSort = function(a, b) {
    var aR = a._normalizedRating != null ? a._normalizedRating : -1;
    var bR = b._normalizedRating != null ? b._normalizedRating : -1;
    return bR - aR;
  };
  booking.sort(ratingSort);
  agoda.sort(ratingSort);

  // Cap each platform at XREF_POOL_CAP
  if (booking.length > XREF_POOL_CAP) booking = booking.slice(0, XREF_POOL_CAP);
  if (agoda.length > XREF_POOL_CAP) agoda = agoda.slice(0, XREF_POOL_CAP);

  // Merge candidates
  var candidates = booking.concat(agoda);
  candidates.sort(ratingSort);

  // Build updatedState, preserving terminal states
  var updatedState = {};
  var key;
  for (key in currentXrefState) {
    if (currentXrefState.hasOwnProperty(key)) {
      updatedState[key] = currentXrefState[key];
    }
  }

  // Mark candidates as 'eligible' unless they have a terminal/existing state
  for (var c = 0; c < candidates.length; c++) {
    var url = candidates[c].url;
    if (!url) continue;
    if (!updatedState[url]) {
      updatedState[url] = 'eligible';
    }
  }

  // Count already-triggered toward budget
  var alreadyTriggered = 0;
  for (var s = 0; s < candidates.length; s++) {
    var st = updatedState[candidates[s].url];
    if (st === 'pending' || st === 'checking' || st === 'scored' || st === 'not-found' || st === 'failed') {
      alreadyTriggered++;
    }
  }

  // Pick top eligible for auto-trigger
  var autoTrigger = [];
  var autoRemaining = XREF_AUTO_BUDGET - alreadyTriggered;
  for (var a = 0; a < candidates.length && autoRemaining > 0; a++) {
    var aUrl = candidates[a].url;
    if (updatedState[aUrl] === 'eligible') {
      autoTrigger.push(aUrl);
      updatedState[aUrl] = 'pending';
      autoRemaining--;
    }
  }

  // Collect remaining eligible URLs (for Check buttons)
  var eligible = [];
  for (var e = 0; e < candidates.length; e++) {
    var eUrl = candidates[e].url;
    if (updatedState[eUrl] === 'eligible') {
      eligible.push(eUrl);
    }
  }

  return { autoTrigger: autoTrigger, eligible: eligible, updatedState: updatedState };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectXrefCandidates, XREF_AUTO_BUDGET, XREF_POOL_CAP };
}
