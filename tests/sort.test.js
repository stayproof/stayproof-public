var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

// ── Pure sort functions (copied from src/search/search.js — must stay in sync) ──
// search.js is not a module, so we duplicate the pure logic here for testing.

function getListingTier(listing) {
  if (listing._anomaly) return 1;
  return 0;
}

function applyUserSort(listings, currentSort) {
  if (!currentSort.column) return listings;
  listings.sort(function (a, b) {
    var aTier = getListingTier(a);
    var bTier = getListingTier(b);
    if (aTier !== bTier) return aTier - bTier;

    var dir = currentSort.direction === 'asc' ? 1 : -1;
    if (currentSort.column === 'price') {
      var aPrice = a._pricePerNight != null ? a._pricePerNight : Infinity;
      var bPrice = b._pricePerNight != null ? b._pricePerNight : Infinity;
      return dir * (aPrice - bPrice);
    }
    if (currentSort.column === 'rating') {
      var aRating = a._normalizedRating != null ? a._normalizedRating : -1;
      var bRating = b._normalizedRating != null ? b._normalizedRating : -1;
      return dir * (aRating - bRating);
    }
    if (currentSort.column === 'name') {
      var aName = (a.name || '').toLowerCase();
      var bName = (b.name || '').toLowerCase();
      if (aName < bName) return -1 * dir;
      if (aName > bName) return 1 * dir;
      return 0;
    }
    return 0;
  });
  return listings;
}

function toggleSort(currentSort, column) {
  var defaults = { price: 'asc', rating: 'desc', name: 'asc' };
  if (currentSort.column === column) {
    if (currentSort.direction === 'asc') {
      return { column: column, direction: 'desc' };
    } else {
      return { column: null, direction: 'asc' };
    }
  }
  return { column: column, direction: defaults[column] || 'asc' };
}

// ── getListingTier ──────────────────────────────────────────────────

describe('getListingTier', function () {
  it('returns 0 for normal listing', function () {
    assert.strictEqual(getListingTier({ platform: 'booking', reviewCount: 50 }), 0);
  });

  it('returns 1 for anomaly-flagged listing', function () {
    assert.strictEqual(getListingTier({ platform: 'booking', reviewCount: 50, _anomaly: true }), 1);
  });

  it('returns 0 for any listing with few reviews (no review-count demotion)', function () {
    assert.strictEqual(getListingTier({ platform: 'airbnb', reviewCount: 5 }), 0);
  });

  it('returns 0 for booking with 10 reviews (no review-count demotion)', function () {
    assert.strictEqual(getListingTier({ platform: 'booking', reviewCount: 10 }), 0);
  });

  it('returns 0 for agoda with 5 reviews (no review-count demotion)', function () {
    assert.strictEqual(getListingTier({ platform: 'agoda', reviewCount: 5 }), 0);
  });
});

// ── applyUserSort ───────────────────────────────────────────────────

describe('applyUserSort', function () {
  function makeListings() {
    return [
      { name: 'Hotel C', platform: 'booking', reviewCount: 100, _pricePerNight: 80, _normalizedRating: 7.5 },
      { name: 'Hotel A', platform: 'booking', reviewCount: 200, _pricePerNight: 50, _normalizedRating: 9.0 },
      { name: 'Hotel B', platform: 'booking', reviewCount: 150, _pricePerNight: 120, _normalizedRating: 8.0 },
      { name: 'Anomaly Place', platform: 'booking', reviewCount: 100, _pricePerNight: 30, _normalizedRating: 9.5, _anomaly: true },
      { name: 'New Place', platform: 'agoda', reviewCount: 5, _pricePerNight: 40, _normalizedRating: 9.8 },
    ];
  }

  it('sorts by price ascending within tiers (anomalies stay at bottom)', function () {
    var listings = makeListings();
    applyUserSort(listings, { column: 'price', direction: 'asc' });
    // Tier 0: New Place ($40), Hotel A ($50), Hotel C ($80), Hotel B ($120)
    assert.strictEqual(listings[0].name, 'New Place');
    assert.strictEqual(listings[1].name, 'Hotel A');
    assert.strictEqual(listings[2].name, 'Hotel C');
    assert.strictEqual(listings[3].name, 'Hotel B');
    // Tier 1 (anomaly): Anomaly Place
    assert.strictEqual(listings[4].name, 'Anomaly Place');
  });

  it('sorts by price descending within tiers', function () {
    var listings = makeListings();
    applyUserSort(listings, { column: 'price', direction: 'desc' });
    assert.strictEqual(listings[0].name, 'Hotel B');
    assert.strictEqual(listings[1].name, 'Hotel C');
    assert.strictEqual(listings[2].name, 'Hotel A');
    assert.strictEqual(listings[3].name, 'New Place');
    assert.strictEqual(listings[4].name, 'Anomaly Place');
  });

  it('sorts by rating descending within tiers (anomalies stay at bottom)', function () {
    var listings = makeListings();
    applyUserSort(listings, { column: 'rating', direction: 'desc' });
    assert.strictEqual(listings[0].name, 'New Place');  // 9.8
    assert.strictEqual(listings[1].name, 'Hotel A');    // 9.0
    assert.strictEqual(listings[2].name, 'Hotel B');    // 8.0
    assert.strictEqual(listings[3].name, 'Hotel C');    // 7.5
    assert.strictEqual(listings[4].name, 'Anomaly Place');
  });

  it('sorts by name ascending (A-Z) within tiers', function () {
    var listings = makeListings();
    applyUserSort(listings, { column: 'name', direction: 'asc' });
    assert.strictEqual(listings[0].name, 'Hotel A');
    assert.strictEqual(listings[1].name, 'Hotel B');
    assert.strictEqual(listings[2].name, 'Hotel C');
    assert.strictEqual(listings[3].name, 'New Place');
    assert.strictEqual(listings[4].name, 'Anomaly Place');
  });

  it('handles null prices (sorted to bottom as Infinity)', function () {
    var listings = [
      { name: 'Cheap', platform: 'booking', reviewCount: 100, _pricePerNight: 50, _normalizedRating: 8.0 },
      { name: 'No Price', platform: 'booking', reviewCount: 100, _pricePerNight: null, _normalizedRating: 8.0 },
      { name: 'Mid', platform: 'booking', reviewCount: 100, _pricePerNight: 80, _normalizedRating: 8.0 },
    ];
    applyUserSort(listings, { column: 'price', direction: 'asc' });
    assert.strictEqual(listings[0].name, 'Cheap');
    assert.strictEqual(listings[1].name, 'Mid');
    assert.strictEqual(listings[2].name, 'No Price');
  });

  it('handles null ratings (sorted to bottom as -1)', function () {
    var listings = [
      { name: 'Rated', platform: 'booking', reviewCount: 100, _pricePerNight: 50, _normalizedRating: 8.0 },
      { name: 'No Rating', platform: 'booking', reviewCount: 100, _pricePerNight: 50, _normalizedRating: null },
      { name: 'Low Rated', platform: 'booking', reviewCount: 100, _pricePerNight: 50, _normalizedRating: 6.0 },
    ];
    applyUserSort(listings, { column: 'rating', direction: 'desc' });
    assert.strictEqual(listings[0].name, 'Rated');
    assert.strictEqual(listings[1].name, 'Low Rated');
    assert.strictEqual(listings[2].name, 'No Rating');
  });

  it('returns listings unchanged when column is null', function () {
    var listings = makeListings();
    var origOrder = listings.map(function (l) { return l.name; });
    applyUserSort(listings, { column: null, direction: 'asc' });
    var newOrder = listings.map(function (l) { return l.name; });
    assert.deepStrictEqual(newOrder, origOrder);
  });

  it('reset to default re-sorts by composite score after user sort', function () {
    // Simulate: listings sorted by price, then user clicks third time to reset
    var listings = [
      { name: 'Cheap',  platform: 'booking', reviewCount: 100, _pricePerNight: 30, _normalizedRating: 6.0, _compositeScore: 40 },
      { name: 'Best',   platform: 'booking', reviewCount: 200, _pricePerNight: 80, _normalizedRating: 9.0, _compositeScore: 90 },
      { name: 'Mid',    platform: 'booking', reviewCount: 150, _pricePerNight: 60, _normalizedRating: 8.0, _compositeScore: 70 },
    ];
    // Sort by price first (simulates user clicking price column)
    applyUserSort(listings, { column: 'price', direction: 'asc' });
    assert.strictEqual(listings[0].name, 'Cheap');

    // Now reset: apply default composite sort (same logic as search.js toggleSort reset)
    listings.sort(function (a, b) {
      var aTier = getListingTier(a);
      var bTier = getListingTier(b);
      if (aTier !== bTier) return aTier - bTier;
      return (b._compositeScore || 0) - (a._compositeScore || 0);
    });
    // Should be back to composite score order: Best (90), Mid (70), Cheap (40)
    assert.strictEqual(listings[0].name, 'Best');
    assert.strictEqual(listings[1].name, 'Mid');
    assert.strictEqual(listings[2].name, 'Cheap');
  });
});

// ── toggleSort ──────────────────────────────────────────────────────

describe('toggleSort', function () {
  it('clicking price sets column=price, direction=asc', function () {
    var result = toggleSort({ column: null, direction: 'asc' }, 'price');
    assert.deepStrictEqual(result, { column: 'price', direction: 'asc' });
  });

  it('clicking rating sets column=rating, direction=desc (natural default)', function () {
    var result = toggleSort({ column: null, direction: 'asc' }, 'rating');
    assert.deepStrictEqual(result, { column: 'rating', direction: 'desc' });
  });

  it('clicking same column twice reverses direction', function () {
    var result = toggleSort({ column: 'price', direction: 'asc' }, 'price');
    assert.deepStrictEqual(result, { column: 'price', direction: 'desc' });
  });

  it('clicking same column third time clears sort (column=null)', function () {
    var result = toggleSort({ column: 'price', direction: 'desc' }, 'price');
    assert.deepStrictEqual(result, { column: null, direction: 'asc' });
  });

  it('clicking different column resets to that column default direction', function () {
    var result = toggleSort({ column: 'price', direction: 'desc' }, 'rating');
    assert.deepStrictEqual(result, { column: 'rating', direction: 'desc' });
  });

  it('clicking name sets direction=asc', function () {
    var result = toggleSort({ column: null, direction: 'asc' }, 'name');
    assert.deepStrictEqual(result, { column: 'name', direction: 'asc' });
  });
});
