var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

// ── confidenceLabel (copied from src/search/search.js — must stay in sync) ──
// search.js is not a module, so we duplicate the pure logic here for testing.

function confidenceLabel(score) {
  if (score >= 0.95) return 'Exact match';
  if (score >= 0.85) return 'High confidence match';
  return 'Likely match';
}

describe('confidenceLabel', function () {
  it('returns "Exact match" for score >= 0.95', function () {
    assert.equal(confidenceLabel(0.96), 'Exact match');
    assert.equal(confidenceLabel(0.95), 'Exact match');
    assert.equal(confidenceLabel(1.0), 'Exact match');
  });

  it('returns "High confidence match" for 0.85 <= score < 0.95', function () {
    assert.equal(confidenceLabel(0.90), 'High confidence match');
    assert.equal(confidenceLabel(0.85), 'High confidence match');
    assert.equal(confidenceLabel(0.94), 'High confidence match');
  });

  it('returns "Likely match" for score < 0.85', function () {
    assert.equal(confidenceLabel(0.80), 'Likely match');
    assert.equal(confidenceLabel(0.75), 'Likely match');
    assert.equal(confidenceLabel(0.84), 'Likely match');
  });
});

// ── renderGmapsColumn state coverage ──
// Verifies all xrefState values produce expected output type.
// Uses a minimal stub since search.js depends on browser DOM.

describe('renderGmapsColumn state logic', function () {
  // Pure logic: which state maps to which UI element
  function gmapsOutputType(state, platform, hasGoogleData) {
    if (hasGoogleData) return 'rating-link';
    if (state === 'pending') return 'pending-text';
    if (state === 'checking') return 'spinner';
    if (state === 'eligible') return 'check-button';
    if (state === 'not-found' || state === 'failed') return 'not-verified';
    if (state !== 'na' && platform !== 'airbnb') return 'check-button';
    return 'empty';
  }

  it('shows check button for undefined state on Booking listing', function () {
    assert.equal(gmapsOutputType(undefined, 'booking', false), 'check-button');
  });

  it('shows check button for undefined state on Agoda listing', function () {
    assert.equal(gmapsOutputType(undefined, 'agoda', false), 'check-button');
  });

  it('shows empty for Airbnb na state', function () {
    assert.equal(gmapsOutputType('na', 'airbnb', false), 'empty');
  });

  it('shows empty for Airbnb undefined state', function () {
    assert.equal(gmapsOutputType(undefined, 'airbnb', false), 'empty');
  });

  it('shows not-verified for not-found state', function () {
    assert.equal(gmapsOutputType('not-found', 'booking', false), 'not-verified');
  });

  it('shows rating link when google data present regardless of state', function () {
    assert.equal(gmapsOutputType('scored', 'booking', true), 'rating-link');
    assert.equal(gmapsOutputType(undefined, 'agoda', true), 'rating-link');
  });

  it('shows check button for eligible state', function () {
    assert.equal(gmapsOutputType('eligible', 'booking', false), 'check-button');
  });
});

// ── Map data logic (copied from search.js — must stay in sync) ──

function getListingTier(listing) {
  if ((listing.platform === 'booking' || listing.platform === 'agoda') && listing.reviewCount < 20) return 2;
  if (listing._anomaly) return 1;
  return 0;
}
function getPinColor(listing) {
  var tier = getListingTier(listing);
  if (tier === 0) return '#16a34a';
  if (tier === 1) return '#d97706';
  return '#dc2626';
}

function filterMappableListings(listings) {
  return listings.filter(function (l) {
    if (l.lat == null || l.lng == null) return false;
    if (l.lat === 0 && l.lng === 0) return false;
    return true;
  });
}

function mapStatusText(mapped, total) {
  return mapped + ' of ' + total + ' listings mapped';
}

describe('getPinColor', function () {
  it('returns green for normal booking listing with enough reviews', function () {
    assert.equal(getPinColor({ platform: 'booking', reviewCount: 50 }), '#16a34a');
  });

  it('returns amber for listing with anomaly flag', function () {
    assert.equal(getPinColor({ platform: 'booking', reviewCount: 50, _anomaly: true }), '#d97706');
  });

  it('returns red for booking listing with low reviews', function () {
    assert.equal(getPinColor({ platform: 'booking', reviewCount: 5 }), '#dc2626');
  });

  it('does not penalise airbnb for low reviews', function () {
    assert.equal(getPinColor({ platform: 'airbnb', reviewCount: 5 }), '#16a34a');
  });
});

describe('filterMappableListings', function () {
  it('keeps listings with valid lat/lng', function () {
    var result = filterMappableListings([{ lat: 10.5, lng: 106.7 }]);
    assert.equal(result.length, 1);
  });

  it('excludes listing with lat: null', function () {
    var result = filterMappableListings([{ lat: null, lng: 106.7 }]);
    assert.equal(result.length, 0);
  });

  it('excludes listing with lng: null', function () {
    var result = filterMappableListings([{ lat: 10.5, lng: null }]);
    assert.equal(result.length, 0);
  });

  it('excludes listing with lat: 0 and lng: 0', function () {
    var result = filterMappableListings([{ lat: 0, lng: 0 }]);
    assert.equal(result.length, 0);
  });

  it('keeps listing with lat: 0 but lng !== 0 (valid equator location)', function () {
    var result = filterMappableListings([{ lat: 0, lng: 32.5 }]);
    assert.equal(result.length, 1);
  });
});

describe('mapStatusText', function () {
  it('generates correct status for partial mapping', function () {
    assert.equal(mapStatusText(3, 5), '3 of 5 listings mapped');
  });

  it('generates correct status for zero listings', function () {
    assert.equal(mapStatusText(0, 0), '0 of 0 listings mapped');
  });
});

// ── haversineKm (copied from search.js — must stay in sync) ──

function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

describe('haversineKm', function () {
  it('returns ~343 km for London to Paris', function () {
    var dist = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(dist > 338 && dist < 348, 'Expected ~343km, got ' + dist);
  });

  it('returns 0 for same point', function () {
    assert.equal(haversineKm(10.5, 106.7, 10.5, 106.7), 0);
  });

  it('returns ~20015 km for half circumference', function () {
    var dist = haversineKm(0, 0, 0, 180);
    assert.ok(dist > 19995 && dist < 20035, 'Expected ~20015km, got ' + dist);
  });
});

// ── computeCentroid (copied from search.js — must stay in sync) ──

function computeCentroid(listings) {
  var sumLat = 0;
  var sumLng = 0;
  var count = 0;
  for (var i = 0; i < listings.length; i++) {
    var l = listings[i];
    if (l.lat == null || l.lng == null) continue;
    if (l.lat === 0 && l.lng === 0) continue;
    sumLat += l.lat;
    sumLng += l.lng;
    count++;
  }
  if (count === 0) return null;
  return { lat: sumLat / count, lng: sumLng / count };
}

describe('computeCentroid', function () {
  it('returns null for empty array', function () {
    assert.equal(computeCentroid([]), null);
  });

  it('returns null for listings with null coords', function () {
    assert.equal(computeCentroid([{ lat: null, lng: null }]), null);
  });

  it('returns same coords for single listing', function () {
    var c = computeCentroid([{ lat: 10, lng: 20 }]);
    assert.deepStrictEqual(c, { lat: 10, lng: 20 });
  });

  it('returns arithmetic mean for two listings', function () {
    var c = computeCentroid([{ lat: 10, lng: 20 }, { lat: 20, lng: 40 }]);
    assert.deepStrictEqual(c, { lat: 15, lng: 30 });
  });

  it('skips listings where lat===0 && lng===0', function () {
    var c = computeCentroid([{ lat: 0, lng: 0 }, { lat: 10, lng: 20 }]);
    assert.deepStrictEqual(c, { lat: 10, lng: 20 });
  });
});
