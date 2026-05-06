const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Minimal chrome API mock so service-worker.js can be required in Node
// (the URL builder functions are pure — they don't touch chrome APIs)
if (typeof globalThis.chrome === 'undefined') {
  globalThis.chrome = {
    alarms: {
      onAlarm: { addListener: function () {} },
      create: function () {},
      clear: function () {},
    },
    tabs: {
      onRemoved: { addListener: function () {} },
      create: function () {},
      remove: function () { return Promise.resolve(); },
      get: function () {},
      query: function () {},
      sendMessage: function () { return Promise.resolve(); },
      update: function () {},
      onUpdated: { addListener: function () {}, removeListener: function () {} },
    },
    windows: {
      onRemoved: { addListener: function () {} },
      create: function () {},
      get: function () {},
      remove: function () { return Promise.resolve(); },
    },
    runtime: {
      onInstalled: { addListener: function () {} },
      onMessage: { addListener: function () {} },
      lastError: null,
    },
    storage: {
      local: {
        get: function () { return Promise.resolve({}); },
        set: function () { return Promise.resolve(); },
      },
      session: {
        get: function () { return Promise.resolve({}); },
        set: function () { return Promise.resolve(); },
      },
    },
    action: {
      setBadgeBackgroundColor: function () {},
      setBadgeText: function () {},
      onClicked: { addListener: function () {} },
    },
    scripting: {
      executeScript: function () {},
    },
  };
}

const {
  buildBookingSearchUrl,
  buildAirbnbSearchUrl,
  buildAgodaSearchUrl,
  pickAgodaSuggestResult,
  XREF_CONFIG,
} = require('../src/background/service-worker.js');
const fs = require('fs');
const path = require('path');

// ─── buildBookingSearchUrl ──────────────────────────────────────────

describe('buildBookingSearchUrl', () => {
  it('contains selected_currency=USD', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('selected_currency=USD'),
      `URL should contain selected_currency=USD (got ${url})`);
  });

  it('path contains en-us', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('en-us'),
      `URL path should contain en-us (got ${url})`);
  });

  it('contains ss= with destination', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('ss=Da'),
      `URL should contain ss= with destination (got ${url})`);
  });

  it('contains checkin and checkout dates', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('checkin=2026-03-01'),
      `URL should contain checkin date (got ${url})`);
    assert.ok(url.includes('checkout=2026-03-05'),
      `URL should contain checkout date (got ${url})`);
  });

  it('contains group_adults=2 and no_rooms=1', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('group_adults=2'),
      `URL should contain group_adults=2 (got ${url})`);
    assert.ok(url.includes('no_rooms=1'),
      `URL should contain no_rooms=1 (got ${url})`);
  });

  it('handles special characters in destination (Hoi An with diacritics)', () => {
    const url = buildBookingSearchUrl('H\u1ed9i An', '2026-04-01', '2026-04-05');
    assert.ok(url.includes('ss='),
      `URL should contain ss= parameter (got ${url})`);
    assert.ok(url.startsWith('https://www.booking.com/searchresults.en-us.html'),
      `URL should have correct base (got ${url})`);
  });

  it('handles multi-word destinations', () => {
    const url = buildBookingSearchUrl('Ho Chi Minh City', '2026-05-01', '2026-05-05');
    assert.ok(url.includes('ss=Ho'),
      `URL should contain destination (got ${url})`);
  });

  it('produces a valid URL starting with https://www.booking.com', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.startsWith('https://www.booking.com/searchresults.en-us.html?'),
      `URL should start with correct base (got ${url})`);
  });
});

describe('buildBookingSearchUrl with maxPrice', () => {
  it('includes nflt price filter when maxPrice is provided', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05', 200);
    assert.ok(url.includes('nflt=price%3DUSD-min-200-1') || url.includes('nflt=price=USD-min-200-1'),
      'URL should contain nflt price filter: ' + url);
  });

  it('omits nflt when maxPrice is null', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05', null);
    assert.ok(!url.includes('nflt'), 'URL should not contain nflt: ' + url);
  });

  it('omits nflt when maxPrice is undefined', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(!url.includes('nflt'), 'URL should not contain nflt: ' + url);
  });

  it('omits nflt when maxPrice is Infinity', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05', Infinity);
    assert.ok(!url.includes('nflt'), 'URL should not contain nflt: ' + url);
  });

  it('nflt format is price=USD-min-{max}-1', () => {
    const url = buildBookingSearchUrl('Da Nang', '2026-03-01', '2026-03-05', 350);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.strictEqual(params.get('nflt'), 'price=USD-min-350-1',
      'nflt should be price=USD-min-350-1: ' + url);
  });
});

// ─── buildAirbnbSearchUrl ───────────────────────────────────────────

describe('buildAirbnbSearchUrl', () => {
  it('contains currency=USD', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('currency=USD'),
      `URL should contain currency=USD (got ${url})`);
  });

  it('uses currency param (NOT display_currency) — regression for Airbnb param rename', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('currency=USD'),
      `URL should contain currency=USD (got ${url})`);
    assert.ok(!url.includes('display_currency'),
      `URL must NOT contain display_currency (old broken param) (got ${url})`);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.strictEqual(params.get('currency'), 'USD',
      `params.get('currency') should be 'USD' (got ${params.get('currency')})`);
    assert.strictEqual(params.get('display_currency'), null,
      `params.get('display_currency') should be null (got ${params.get('display_currency')})`);
  });

  it('contains locale=en', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('locale=en'),
      `URL should contain locale=en (got ${url})`);
  });

  it('path contains encoded destination', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('/s/Da%20Nang/homes'),
      `URL path should contain encoded destination (got ${url})`);
  });

  it('contains checkin and checkout dates', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('checkin=2026-03-01'),
      `URL should contain checkin date (got ${url})`);
    assert.ok(url.includes('checkout=2026-03-05'),
      `URL should contain checkout date (got ${url})`);
  });

  it('contains adults=2', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('adults=2'),
      `URL should contain adults=2 (got ${url})`);
  });

  it('handles special characters in destination (Hoi An with diacritics)', () => {
    const url = buildAirbnbSearchUrl('H\u1ed9i An', '2026-04-01', '2026-04-05');
    assert.ok(url.includes('/s/'),
      `URL should contain /s/ path segment (got ${url})`);
    assert.ok(url.includes('/homes'),
      `URL should contain /homes path segment (got ${url})`);
    assert.ok(url.includes('currency=USD'),
      `URL should contain currency=USD (got ${url})`);
  });

  it('handles multi-word destinations', () => {
    const url = buildAirbnbSearchUrl('Ho Chi Minh City', '2026-05-01', '2026-05-05');
    assert.ok(url.includes('/s/Ho%20Chi%20Minh%20City/homes'),
      `URL path should contain encoded multi-word destination (got ${url})`);
  });

  it('produces a valid URL starting with https://www.airbnb.com', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.startsWith('https://www.airbnb.com/s/'),
      `URL should start with correct base (got ${url})`);
  });
});

describe('buildAirbnbSearchUrl with maxPrice', () => {
  it('includes price_max and filter type params when maxPrice is provided', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { maxPrice: 150 });
    assert.ok(url.includes('price_max=150'),
      'URL should contain price_max=150: ' + url);
    assert.ok(url.includes('price_filter_input_type=2'),
      'URL should contain price_filter_input_type=2: ' + url);
    assert.ok(url.includes('price_filter_num_nights=1'),
      'URL should contain price_filter_num_nights=1: ' + url);
  });

  it('omits price_max when maxPrice is null', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { maxPrice: null });
    assert.ok(!url.includes('price_max'), 'URL should not contain price_max: ' + url);
  });

  it('omits price_max when maxPrice is Infinity', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { maxPrice: Infinity });
    assert.ok(!url.includes('price_max'), 'URL should not contain price_max: ' + url);
  });

  it('omits price_max when no options provided', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(!url.includes('price_max'), 'URL should not contain price_max: ' + url);
  });
});

// ─── pickAgodaSuggestResult ─────────────────────────────────────────

describe('pickAgodaSuggestResult', () => {
  it('returns null for null/undefined data', () => {
    assert.equal(pickAgodaSuggestResult(null), null);
    assert.equal(pickAgodaSuggestResult(undefined), null);
    assert.equal(pickAgodaSuggestResult({}), null);
  });

  it('returns null for empty ViewModelList', () => {
    assert.equal(pickAgodaSuggestResult({ ViewModelList: [] }), null);
  });

  it('skips text-echo items (DisplayNames null)', () => {
    const data = { ViewModelList: [
      { Name: 'ubud', CityId: 0, ObjectId: 26638, IsHotel: false, DisplayNames: null },
      { Name: 'Ubud', CityId: 17193, ObjectId: 26638, IsHotel: false, DisplayNames: { Name: 'Ubud', GeoHierarchyName: 'Bali', CategoryName: 'Area' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 17193, areaId: 26638, name: 'Ubud' });
  });

  it('city query — returns CityId and display name (da nang), no areaId when ObjectId matches CityId', () => {
    const data = { ViewModelList: [
      { Name: 'da nang', CityId: 0, ObjectId: 16440, IsHotel: false, DisplayNames: null },
      { Name: 'Da Nang', CityId: 16440, ObjectId: 16440, IsHotel: false, DisplayNames: { Name: 'Da Nang', GeoHierarchyName: 'Vietnam', CategoryName: 'City' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 16440, areaId: null, name: 'Da Nang' });
  });

  it('area query — returns parent CityId with areaId (seminyak)', () => {
    const data = { ViewModelList: [
      { Name: 'seminyak', CityId: 0, ObjectId: 27988, IsHotel: false, DisplayNames: null },
      { Name: 'Umalas, Seminyak', CityId: 0, ObjectId: 3105, IsHotel: false, DisplayNames: { Name: 'Umalas, Seminyak', GeoHierarchyName: 'Indonesia' } },
      { Name: 'Nakula, Seminyak', CityId: 0, ObjectId: 2779, IsHotel: false, DisplayNames: { Name: 'Nakula, Seminyak', GeoHierarchyName: 'Indonesia' } },
      { Name: 'Seminyak', CityId: 17193, ObjectId: 27988, IsHotel: false, DisplayNames: { Name: 'Seminyak', GeoHierarchyName: 'Bali', CategoryName: 'Area' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 17193, areaId: 27988, name: 'Seminyak' });
  });

  it('comma-separated input — returns areaId from ObjectId (ubud, bali)', () => {
    const data = { ViewModelList: [
      { Name: 'ubud, bali', CityId: 0, ObjectId: 26638, IsHotel: false, DisplayNames: null },
      { Name: 'Ubud', CityId: 17193, ObjectId: 26638, IsHotel: false, DisplayNames: { Name: 'Ubud', GeoHierarchyName: 'Bali', CategoryName: 'Area' } },
      { Name: 'The Westin Resort & Spa Ubud, Bali', CityId: 17193, ObjectId: 10776988, IsHotel: true, DisplayNames: { Name: 'The Westin Resort & Spa Ubud, Bali', CategoryName: 'Property' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 17193, areaId: 26638, name: 'Ubud' });
  });

  it('extracts areaId from previous item ResultUrl when ObjectId matches CityId', () => {
    const data = { ViewModelList: [
      { Name: 'canggu', CityId: 0, ObjectId: 50000, ResultUrl: '/search?city=17193&area=50000', IsHotel: false, DisplayNames: null },
      { Name: 'Canggu', CityId: 17193, ObjectId: 17193, IsHotel: false, DisplayNames: { Name: 'Canggu', GeoHierarchyName: 'Bali', CategoryName: 'Area' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 17193, areaId: 50000, name: 'Canggu' });
  });

  it('skips hotel items in fallback pass', () => {
    const data = { ViewModelList: [
      { Name: 'test', CityId: 0, ObjectId: 999, IsHotel: false, DisplayNames: null },
      { Name: 'Test Hotel', CityId: 0, ObjectId: 1001, IsHotel: true, DisplayNames: { Name: 'Test Hotel', CategoryName: 'Property' } },
      { Name: 'Test Area', CityId: 0, ObjectId: 1002, IsHotel: false, DisplayNames: { Name: 'Test Area', GeoHierarchyName: 'Somewhere' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 1002, areaId: null, name: 'Test Area' });
  });

  it('ambiguous destination — returns first CityId match, no areaId (medellin)', () => {
    const data = { ViewModelList: [
      { Name: 'medellin', CityId: 0, ObjectId: 667208, IsHotel: false, DisplayNames: null },
      { Name: 'Medellín', CityId: 10309, ObjectId: 10309, IsHotel: false, DisplayNames: { Name: 'Medellín', GeoHierarchyName: 'Colombia', CategoryName: 'City' } },
      { Name: 'Medellin', CityId: 667208, ObjectId: 667208, IsHotel: false, DisplayNames: { Name: 'Medellin', GeoHierarchyName: 'Spain', CategoryName: 'City' } },
    ]};
    const result = pickAgodaSuggestResult(data);
    assert.deepEqual(result, { cityId: 10309, areaId: null, name: 'Medellín' });
  });
});

// ─── buildAgodaSearchUrl display name contract (AGOD-02) ─────────────

describe('buildAgodaSearchUrl display name contract (AGOD-02)', () => {
  it('puts Da Nang display name into textToSearch param (no area)', () => {
    const url = buildAgodaSearchUrl('16440', null, 'Da Nang', '2026-04-01', '2026-04-03');
    assert.ok(url.includes('textToSearch=Da'),
      'URL should contain textToSearch with Da Nang display name: ' + url);
    assert.ok(url.includes('city=16440'),
      'URL should contain city=16440: ' + url);
    assert.ok(!url.includes('area='),
      'URL should not contain area param when areaId is null: ' + url);
  });

  it('puts Ubud display name into textToSearch and includes area param', () => {
    const url = buildAgodaSearchUrl('17193', 26638, 'Ubud', '2026-04-01', '2026-04-03');
    assert.ok(url.includes('textToSearch=Ubud'),
      'URL should contain textToSearch=Ubud: ' + url);
    assert.ok(url.includes('area=26638'),
      'URL should contain area=26638 for Ubud: ' + url);
  });

  it('handles empty string destination defensively', () => {
    const url = buildAgodaSearchUrl('17193', null, '', '2026-04-01', '2026-04-03');
    assert.ok(url.includes('textToSearch='),
      'URL should still contain textToSearch param even when empty: ' + url);
  });
});

describe('buildAgodaSearchUrl with maxPrice', () => {
  it('includes PriceFrom and PriceTo params when provided', () => {
    const url = buildAgodaSearchUrl('16440', null, 'Da Nang', '2026-04-01', '2026-04-03', 250);
    assert.ok(url.includes('PriceFrom=0'),
      'URL should contain PriceFrom=0: ' + url);
    assert.ok(url.includes('PriceTo=250'),
      'URL should contain PriceTo=250: ' + url);
  });

  it('omits price params when null', () => {
    const url = buildAgodaSearchUrl('16440', null, 'Da Nang', '2026-04-01', '2026-04-03', null);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.strictEqual(params.get('PriceTo'), null,
      'URL should not have PriceTo param: ' + url);
  });

  it('omits price params when undefined', () => {
    const url = buildAgodaSearchUrl('16440', null, 'Da Nang', '2026-04-01', '2026-04-03');
    const params = new URLSearchParams(url.split('?')[1]);
    assert.strictEqual(params.get('PriceTo'), null,
      'URL should not have PriceTo param: ' + url);
  });

  it('omits price params when Infinity', () => {
    const url = buildAgodaSearchUrl('16440', null, 'Da Nang', '2026-04-01', '2026-04-03', Infinity);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.strictEqual(params.get('PriceTo'), null,
      'URL should not have maxPrice param: ' + url);
  });
});

describe('buildAirbnbSearchUrl with filter options', () => {
  it('backward compatible — no options still works', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(url.includes('currency=USD'));
    assert.ok(!url.includes('room_types'));
    assert.ok(!url.includes('guest_favorite'));
  });

  it('contains room_types[] when entireHomesOnly is true', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { entireHomesOnly: true });
    assert.ok(url.includes('room_types%5B%5D=') || url.includes('room_types[]='),
      'URL should contain room_types[] parameter: ' + url);
    assert.ok(url.includes('Entire') || url.includes('entire'),
      'URL should contain Entire home value: ' + url);
  });

  it('does NOT contain room_types when entireHomesOnly is false', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { entireHomesOnly: false });
    assert.ok(!url.includes('room_types'), 'URL should not contain room_types: ' + url);
  });

  it('contains guest_favorite=true when guestFavourite is true', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { guestFavourite: true });
    assert.ok(url.includes('guest_favorite=true'),
      'URL should contain guest_favorite=true: ' + url);
  });

  it('does NOT contain guest_favorite when guestFavourite is false', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05', { guestFavourite: false });
    assert.ok(!url.includes('guest_favorite'), 'URL should not contain guest_favorite: ' + url);
  });

  it('contains both parameters when both options true', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05',
      { entireHomesOnly: true, guestFavourite: true });
    assert.ok(url.includes('room_types%5B%5D=') || url.includes('room_types[]='));
    assert.ok(url.includes('guest_favorite=true'));
  });

  it('includes place_id when provided', () => {
    const url = buildAirbnbSearchUrl('Ubud', '2026-03-01', '2026-03-05',
      { placeId: 'ChIJt8NOlg090i0RMC19yvsLAwQ' });
    assert.ok(url.includes('place_id=ChIJt8NOlg090i0RMC19yvsLAwQ'),
      'URL should contain place_id: ' + url);
  });

  it('omits place_id when not provided', () => {
    const url = buildAirbnbSearchUrl('Da Nang', '2026-03-01', '2026-03-05');
    assert.ok(!url.includes('place_id'), 'URL should not contain place_id: ' + url);
  });
});

// ─── XREF_CONFIG timeout (AGOD-04) ──────────────────────────────────

describe('XREF_CONFIG timeout (AGOD-04)', () => {
  it('tabLoadTimeoutMs is 30000', () => {
    assert.strictEqual(XREF_CONFIG.tabLoadTimeoutMs, 30000,
      'Tab load timeout should be 30 seconds');
  });

  it('maxConcurrent is 5 (config sanity check)', () => {
    assert.strictEqual(XREF_CONFIG.maxConcurrent, 5,
      'Max concurrent xref tabs should be 5');
  });

  it('XREF_CONFIG is a plain object with expected keys', () => {
    assert.ok(typeof XREF_CONFIG === 'object' && XREF_CONFIG !== null,
      'XREF_CONFIG should be an object');
    assert.ok('tabLoadTimeoutMs' in XREF_CONFIG, 'Should have tabLoadTimeoutMs key');
    assert.ok('maxConcurrent' in XREF_CONFIG, 'Should have maxConcurrent key');
    assert.ok('delayBetweenMs' in XREF_CONFIG, 'Should have delayBetweenMs key');
  });
});

// ─── Tab removal failure forwarding (AGOD-05) ───────────────────────

describe('Tab removal failure forwarding (AGOD-05)', () => {
  it('service-worker source contains tabs.onRemoved handler that calls forwardXrefResult with scrape_failed', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'background', 'service-worker.js'), 'utf8');
    // Verify onRemoved listener exists and forwards failure
    assert.ok(src.includes('tabs.onRemoved.addListener'),
      'Should have tabs.onRemoved listener');
    assert.ok(src.includes("forwardXrefResult(reqId, { error: 'scrape_failed' })"),
      'Should call forwardXrefResult with scrape_failed error on tab removal');
  });

  it('search.js maps data.error to not-found xrefState', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'search', 'search.js'), 'utf8');
    assert.ok(src.includes('data.error') || src.includes('data && data.error'),
      'search.js should handle data.error from xref results');
    // Verify the error case sets xrefState to not-found
    var errorBlock = src.substring(src.indexOf('data.error'));
    assert.ok(errorBlock.includes("'not-found'"),
      'search.js should set xrefState to not-found on error');
  });
});
