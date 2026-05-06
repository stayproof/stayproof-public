// Service worker — settings storage, badge updates, and cross-reference queue

// Load SCORING_CONFIG in browser service worker context
if (typeof importScripts === 'function') {
  importScripts('../shared/scoring-config.js');
  importScripts('../shared/name-matching.js');
  importScripts('../shared/scoring.js');
}

const DEFAULT_SETTINGS = {
  enabled: true,
  platforms: {
    booking: true,
    'google-maps': true,
    airbnb: true,
  },
  showNeutral: false,
};

// ─── Cross-reference queue config ────────────────────────────────────

const XREF_CONFIG = {
  maxConcurrent: 5,
  delayBetweenMs: 300,
  maxPerPage: 20,
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  scrapeRetries: 2,       // retry scrape this many times (fast fail)
  scrapeIntervalMs: 2000, // between retries
  initialWaitMs: 4000,    // wait after page load before first scrape
  tabLoadTimeoutMs: 30000, // max wait for tab to reach 'complete' status
};

// ─── Cross-reference state ───────────────────────────────────────────

let xrefPending = new Map();    // requestId → { hotelName, city, bookingTabId }
let xrefQueue = [];             // requestIds waiting to be processed
let xrefActiveTabs = new Map(); // tabId → requestId
let xrefWindowId = null;
let xrefCache = new Map();
let xrefCacheLoaded = false;
let xrefIdCounter = 0;
let xrefDrainScheduled = false;

// ─── Search state ───────────────────────────────────────────────────
let searchActiveTabs = new Map();   // tabId -> { platform, requestId }
let searchWindowId = null;
let searchState = null;             // { id, destination, dates, status, results }

const CACHE_STOP_WORDS = ['hotel', 'resort', 'hostel', 'motel', 'inn', 'lodge', 'suites', 'suite',
  'apartment', 'apartments', 'residence', 'residences', 'boutique',
  'building', 'office', 'villas', 'villa', 'house', 'home', 'homes',
  'the', 'a', 'an'];

function normalizeCacheKey(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(function (w) { return w.length > 0 && CACHE_STOP_WORDS.indexOf(w) === -1; })
    .join(' ');
}

// ─── Scrape function (injected into Google Maps tab via executeScript) ──

/**
 * DOM-only scrape function — runs inside the Google Maps page via executeScript.
 * No external dependencies. Returns raw data for service-worker-side matching.
 * Detail panel: returns { rating, reviewCount, histogram, googleName, source: 'detail' }
 * Search results: returns { candidates: [...], source: 'search' }
 */
function scrapeGoogleMapsDOM() {
  // ── Centralized Google Maps DOM selectors ──
  // All selectors in one place for easy triage when Google changes their DOM.
  // _lastVerified = date when selectors were last confirmed working against live DOM.
  var GMAPS_SELECTORS = {
    _lastVerified: '2026-03-08',

    consent: {
      form: ['form[action*="consent.google"]', 'form[action*="consent"]'],
      acceptButton: [
        'button[aria-label*="Accept all"]',
        'button[aria-label*="Accept All"]',
        'button[aria-label*="accept all"]',
        'button[jsname="b3VHJd"]',
        '.VfPpkd-LgbsSe[aria-label*="Accept"]',
        'form[action*="consent"] button:last-child'
      ]
    },

    captcha: {
      form: ['#captcha-form', '.g-recaptcha', '[data-sitekey]']
    },

    detail: {
      histogramRows: ['tr[aria-label*="star"]', 'tr.BHOKXe'],
      rating: [
        '[role="main"] span[aria-label*="stars"]',
        'div.F7nice span[aria-hidden="true"]',
        '[role="main"] span.fontDisplayLarge',
        'span.fontDisplayLarge'
      ],
      reviewCount: [
        'span[aria-label*="review"]',
        'button[aria-label*="review"]',
        '[data-review-count]'
      ],
      histogramBar: [
        'div[aria-label*="star"] div[style*="width"]',
        'div.gS7Yde div',
        'div[style*="padding-left"]'
      ],
      name: ['h1[data-attrid]', 'h1.fontHeadlineLarge', 'h1']
    },

    search: {
      resultLinks: ['a[href*="/maps/place/"]'],
      resultCard: ['div.Nv2PK'],
      resultCardFallback: ['div.Nv2PK', '[jsaction*="mouseover:pane"] > div'],
      rating: ['span[aria-label*="stars"]', 'span.MW4etd'],
      reviewCount: ['span.UY7F9'],
      name: ['a[aria-label]', '.fontHeadlineSmall', '.qBF1Pd'],
      placeType: ['.W4Efsd'],
      placeLink: ['a[href*="/maps/place/"]', 'a[href]']
    }
  };

  // ── Cascade helpers ──
  // queryFirst: try each selector, return first non-null querySelector result
  function queryFirst(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  // queryAllFirst: try each selector, return first non-empty querySelectorAll result
  function queryAllFirst(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = root.querySelectorAll(selectors[i]);
      if (els.length > 0) return els;
    }
    return [];
  }

  // queryAny: join selectors with comma, single querySelector call (OR-match)
  function queryAny(root, selectors) {
    return root.querySelector(selectors.join(', '));
  }

  // ── Place type filter ──
  var NON_HOTEL_TYPES = ['restaurant', 'cafe', 'coffee', 'bar', 'pub', 'food',
    'bakery', 'supermarket', 'grocery', 'store', 'shop', 'pharmacy',
    'hospital', 'school', 'gym', 'clinic', 'museum', 'park', 'beach club',
    'nail', 'hair', 'salon'];

  function isNonHotelType(typeString) {
    if (!typeString) return false;
    var t = typeString.toLowerCase();
    for (var i = 0; i < NON_HOTEL_TYPES.length; i++) {
      if (t.indexOf(NON_HOTEL_TYPES[i]) !== -1) return true;
    }
    return false;
  }

  // Check for Google consent page (GDPR cookie banner)
  var consentForm = queryAny(document, GMAPS_SELECTORS.consent.form);
  if (consentForm) {
    var params = new URLSearchParams(window.location.search);
    var continueUrl = params.get('continue') || null;
    // Try to find and click "Accept all" button — multiple selector strategies
    var acceptBtn = queryAny(document, GMAPS_SELECTORS.consent.acceptButton);
    if (acceptBtn) {
      acceptBtn.click();
      return { error: 'consent_clicked', continueUrl: continueUrl };
    }
    return { error: 'consent_page', continueUrl: continueUrl };
  }

  // Check for CAPTCHA
  if (queryAny(document, GMAPS_SELECTORS.captcha.form)) {
    return { error: 'captcha' };
  }

  // Try detail panel first (richer data — includes histogram)
  // STRATEGY: Use histogram rows as the primary detail-panel detection signal.
  // As of 2026, the rating span selectors (stars/F7nice) are stale — they return 0 matches.
  // But histogram rows (tr[aria-label*="star"] and tr.BHOKXe) are confirmed working.
  // We detect the detail panel via histogram rows, extract review counts from their
  // aria-labels ("N stars, M reviews"), sum for total review count, and compute
  // a weighted average rating — avoiding brittle explicit rating span selectors.

  // Try histogram — semantic first, class-based fallback
  var rows = queryAllFirst(document, GMAPS_SELECTORS.detail.histogramRows);
  // Also attempt explicit rating span selectors (cascade: semantic → class → fontDisplayLarge)
  var detailRatingEl = queryFirst(document, GMAPS_SELECTORS.detail.rating);
  var detailCount = queryFirst(document, GMAPS_SELECTORS.detail.reviewCount);
  // Detect detail panel: either rating elements found OR 5 histogram rows present
  var isDetailPanel = (detailRatingEl && detailCount) || rows.length === 5;

  if (isDetailPanel) {
    var rating = null;
    var reviewCount = 0;

    if (detailRatingEl) {
      // Semantic hit: parse from aria-label (e.g. "4.2 stars")
      var ariaRating = detailRatingEl.getAttribute('aria-label');
      if (ariaRating && /[\d.]+/.test(ariaRating)) {
        rating = parseFloat(ariaRating.match(/[\d.]+/)[0]);
      }
      // Fallback: parse from text content
      if (rating === null || isNaN(rating)) {
        rating = parseFloat(detailRatingEl.textContent);
      }
      if (isNaN(rating)) rating = null;
    }

    if (detailCount) {
      var countLabel = detailCount.getAttribute('aria-label') || detailCount.textContent || '';
      var countMatch = countLabel.replace(/,/g, '').match(/(\d+)/);
      reviewCount = countMatch ? parseInt(countMatch[1], 10) : 0;
    }

    var histogram = null;
    if (rows.length === 5) {
      histogram = [];
      // Rows are 5★ to 1★ top-to-bottom; we want [1★, 2★, 3★, 4★, 5★]
      var starCounts = [];
      for (var i = rows.length - 1; i >= 0; i--) {
        var ariaLabel = rows[i].getAttribute('aria-label') || '';
        var m = ariaLabel.replace(/,/g, '').match(/(\d+)\s*review/i);
        if (m) {
          starCounts.push(parseInt(m[1], 10));
        } else {
          // Fallback: bar width percentage — semantic then class-based
          var bar = queryFirst(rows[i], GMAPS_SELECTORS.detail.histogramBar);
          if (bar) {
            // padding-left encodes bar proportion in live 2026 DOM
            var paddingLeft = bar.style.paddingLeft || bar.style.width || '';
            var pct = parseFloat(paddingLeft);
            starCounts.push(isNaN(pct) ? 0 : Math.round(pct));
          } else {
            starCounts.push(0);
          }
        }
      }
      histogram = starCounts;

      // If rating or reviewCount not available from explicit selectors, derive from histogram
      var totalFromHistogram = histogram.reduce(function(a, b) { return a + b; }, 0);
      if (totalFromHistogram > 0) {
        if (reviewCount === 0) {
          reviewCount = totalFromHistogram;
        }
        if (rating === null) {
          // Weighted average: histogram[0]=1★, histogram[1]=2★, ..., histogram[4]=5★
          var weightedSum = 0;
          for (var s = 0; s < 5; s++) {
            weightedSum += histogram[s] * (s + 1);
          }
          rating = Math.round((weightedSum / totalFromHistogram) * 10) / 10;
        }
      }
    }

    // Place name — cascade: data-attrid > class > bare h1
    var nameEl = queryFirst(document, GMAPS_SELECTORS.detail.name);
    var googleName = nameEl ? nameEl.textContent.trim() : null;

    // Guard: if h1 is "Results", we're on a search results page, not a detail panel.
    // Fall through to search results parser for proper name matching.
    if (googleName && googleName.toLowerCase() === 'results') {
      // not a detail panel — fall through
    } else if (rating !== null) {
      return { rating: rating, reviewCount: reviewCount, histogram: histogram, googleName: googleName, matchScore: null, source: 'detail', placeUrl: window.location.href };
    }
  }

  // Fallback: search results — return all candidates for service-worker-side matching
  var results = document.querySelectorAll(GMAPS_SELECTORS.search.resultLinks[0]);
  var searchItems = [];
  if (results.length > 0) {
    for (var p = 0; p < results.length; p++) {
      var parent = results[p].closest(GMAPS_SELECTORS.search.resultCard[0]) || results[p].parentElement;
      if (parent && searchItems.indexOf(parent) === -1) {
        searchItems.push(parent);
      }
    }
  }
  if (searchItems.length === 0) {
    var fallbackResults = document.querySelectorAll(GMAPS_SELECTORS.search.resultCardFallback.join(', '));
    for (var f = 0; f < fallbackResults.length; f++) {
      searchItems.push(fallbackResults[f]);
    }
  }

  var candidates = [];

  for (var r = 0; r < searchItems.length; r++) {
    var item = searchItems[r];
    var ratingEl = queryFirst(item, GMAPS_SELECTORS.search.rating);
    var countEl = item.querySelector(GMAPS_SELECTORS.search.reviewCount[0]);
    if (!ratingEl) continue;

    var sRating = null;
    var sAriaRating = ratingEl.getAttribute('aria-label');
    if (sAriaRating && /[\d.]+/.test(sAriaRating)) {
      sRating = parseFloat(sAriaRating.match(/[\d.]+/)[0]);
    }
    if (sRating === null || isNaN(sRating)) {
      sRating = parseFloat(ratingEl.textContent);
    }
    if (isNaN(sRating)) continue;

    var sCountText = countEl ? countEl.textContent : '';
    var sCountMatch = sCountText.replace(/[(),]/g, '').match(/(\d+)/);
    var sReviewCount = sCountMatch ? parseInt(sCountMatch[1], 10) : 0;

    var sNameEl = queryFirst(item, GMAPS_SELECTORS.search.name);
    var sGoogleName = sNameEl ? (sNameEl.getAttribute('aria-label') || sNameEl.textContent || '').trim() : null;

    // Extract place type from search result card
    var typeEls = item.querySelectorAll(GMAPS_SELECTORS.search.placeType[0]);
    var placeType = null;
    for (var te = 0; te < typeEls.length; te++) {
      var txt = typeEls[te].textContent.trim();
      if (txt && txt.length > 0 && txt.length < 60) {
        placeType = txt;
        break;
      }
    }
    if (isNonHotelType(placeType)) {
      continue;
    }

    // Extract place URL for click-through to detail page
    var placeUrl = null;
    var placeLink = item.querySelector(GMAPS_SELECTORS.search.placeLink[0]);
    if (!placeLink) {
      var allLinks = item.querySelectorAll(GMAPS_SELECTORS.search.placeLink[1]);
      for (var li = 0; li < allLinks.length; li++) {
        if (allLinks[li].href && allLinks[li].href.indexOf('/maps/place/') !== -1) {
          placeLink = allLinks[li];
          break;
        }
      }
    }
    if (placeLink) placeUrl = placeLink.href;

    candidates.push({ rating: sRating, reviewCount: sReviewCount, googleName: sGoogleName, placeUrl: placeUrl });
  }

  if (candidates.length === 0) return null;
  return { candidates: candidates, source: 'search' };
}

// ─── Cache persistence ──────────────────────────────────────────────

async function loadXrefCache() {
  if (xrefCacheLoaded) return;
  try {
    const data = await chrome.storage.local.get('xrefCache');
    if (data.xrefCache) {
      const now = Date.now();
      let migrated = false;
      for (const [key, entry] of Object.entries(data.xrefCache)) {
        // Skip stale entries and entries without source (pre-migration bad cache)
        if (now - entry.ts < XREF_CONFIG.cacheTtlMs && entry.source) {
          xrefCache.set(key, entry);
        } else {
          migrated = true;
        }
      }
      if (migrated) saveXrefCache(); // Persist cleaned cache
    }
  } catch (e) { /* ignore */ }
  xrefCacheLoaded = true;
}

async function saveXrefCache() {
  const obj = {};
  xrefCache.forEach(function (val, key) { obj[key] = val; });
  try {
    await chrome.storage.local.set({ xrefCache: obj });
  } catch (e) { /* ignore */ }
}

// ─── Queue persistence (survives SW restart, clears on browser close) ───

async function persistQueue() {
  try {
    await chrome.storage.session.set({
      xrefState: {
        pending: Array.from(xrefPending.entries()),
        queue: xrefQueue.slice(),
        activeTabs: Array.from(xrefActiveTabs.entries()),
        idCounter: xrefIdCounter,
      }
    });
  } catch (e) {
    console.log('[StayProof] Failed to persist queue:', e.message);
  }
}

async function restoreQueue() {
  try {
    const { xrefState } = await chrome.storage.session.get('xrefState');
    if (!xrefState) return;
    xrefPending = new Map(xrefState.pending);
    xrefQueue = xrefState.queue || [];
    xrefIdCounter = xrefState.idCounter || 0;
    // Do NOT restore activeTabs — those tab IDs are stale after SW restart.
    // Active tabs are orphaned; their requests stay in pending but are not being
    // actively scraped. Move any "active" request IDs back into the queue:
    if (xrefState.activeTabs && xrefState.activeTabs.length > 0) {
      for (const [tabId, reqId] of xrefState.activeTabs) {
        if (xrefPending.has(reqId) && xrefQueue.indexOf(reqId) === -1) {
          xrefQueue.unshift(reqId); // Re-queue at front for priority
        }
      }
    }
    xrefActiveTabs = new Map(); // Start fresh
    console.log('[StayProof] Restored queue: ' + xrefQueue.length + ' pending, ' + xrefPending.size + ' tracked');
    if (xrefQueue.length > 0) {
      drainQueue();
    }
  } catch (e) {
    console.log('[StayProof] Failed to restore queue:', e.message);
  }
}

// ─── Queue management ───────────────────────────────────────────────

function drainQueue() {
  if (xrefDrainScheduled) return;
  if (xrefQueue.length === 0) {
    stopKeepAlive();
    return;
  }
  if (xrefActiveTabs.size >= XREF_CONFIG.maxConcurrent) return;

  xrefDrainScheduled = true;
  setTimeout(function () {
    xrefDrainScheduled = false;
    processNextInQueue();
  }, XREF_CONFIG.delayBetweenMs);
}

function processNextInQueue() {
  if (xrefQueue.length === 0 || xrefActiveTabs.size >= XREF_CONFIG.maxConcurrent) return;

  const reqId = xrefQueue.shift();
  persistQueue();
  const req = xrefPending.get(reqId);
  if (!req) { drainQueue(); return; }

  startKeepAlive();

  // Use only the first segment of the city (e.g., "Da Nang" from "Da Nang, Da Nang Municipality, Vietnam")
  // Full Booking city strings are too verbose for Google Maps search
  var searchCity = req.city ? req.city.split(',')[0].trim() : '';
  // Strip operator/chain suffixes ("by Haviland", "managed by X") that confuse Google Maps
  var cleanName = req.hotelName
    .replace(/\s+(?:by|managed by|operated by|powered by)\s+.+$/i, '')
    .trim();
  // Strip city name anywhere in hotel name to prevent duplication in search query.
  // Also handles joined variants (e.g., "Danang" for "Da Nang").
  if (searchCity) {
    var escapedCity = searchCity.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    var joinedCity = searchCity.replace(/\s+/g, '');
    var escapedJoined = joinedCity.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    var cityPattern = escapedCity === escapedJoined
      ? escapedCity
      : '(?:' + escapedCity + '|' + escapedJoined + ')';
    cleanName = cleanName.replace(new RegExp('\\s*' + cityPattern + '\\s*', 'gi'), ' ').trim();
  }
  const searchQuery = encodeURIComponent(cleanName + ' hotel ' + searchCity);
  const url = 'https://www.google.com/maps/search/' + searchQuery;
  console.log('[StayProof] Opening Google Maps for: ' + req.hotelName + ' (' + reqId + ')');

  openHiddenTab(url, function (tab) {
    if (!tab) {
      console.log('[StayProof] Failed to open tab for ' + reqId);
      forwardXrefResult(reqId, { error: 'scrape_failed' });
      drainQueue();
      return;
    }

    console.log('[StayProof] Tab opened: ' + tab.id + ' for ' + reqId);
    xrefActiveTabs.set(tab.id, reqId);
    persistQueue();

    // Wait for page load, then scrape with retries
    waitForLoadThenScrape(tab.id, reqId);

    // Continue draining — start next tab while this one loads
    drainQueue();
  });
}

/**
 * Wait for tab to finish loading, then try scraping with retries.
 */
function waitForLoadThenScrape(tabId, reqId) {
  var settled = false;

  function onUpdated(updatedTabId, changeInfo) {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    if (settled) return;
    settled = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    console.log('[StayProof] Page loaded for ' + reqId + ', waiting ' + XREF_CONFIG.initialWaitMs + 'ms for SPA render...');
    setTimeout(function () {
      tryScrape(tabId, reqId, XREF_CONFIG.scrapeRetries);
    }, XREF_CONFIG.initialWaitMs);
  }

  chrome.tabs.onUpdated.addListener(onUpdated);

  // Timeout: if tab never reaches 'complete', fail gracefully
  setTimeout(function () {
    if (settled) return;
    settled = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    console.log('[StayProof] Tab load timeout for ' + reqId + ' after ' + XREF_CONFIG.tabLoadTimeoutMs + 'ms');
    forwardXrefResult(reqId, { error: 'scrape_failed' });
    closeXrefTab(tabId);
    drainQueue();
  }, XREF_CONFIG.tabLoadTimeoutMs);

  // Safety: if tab is already complete (unlikely but possible)
  chrome.tabs.get(tabId, function (tab) {
    if (chrome.runtime.lastError) return;
    if (tab && tab.status === 'complete') {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      console.log('[StayProof] Page already loaded for ' + reqId);
      setTimeout(function () {
        tryScrape(tabId, reqId, XREF_CONFIG.scrapeRetries);
      }, XREF_CONFIG.initialWaitMs);
    }
  });
}

/**
 * Inject the scrape function and check the result. Retry if nothing found yet.
 */
function tryScrape(tabId, reqId, attemptsLeft, searchFallback) {
  console.log('[StayProof] Scrape attempt for ' + reqId + ' (' + attemptsLeft + ' left)');

  var req = xrefPending.get(reqId);
  var searchedHotelName = req ? req.hotelName : '';
  var searchCity = req ? req.city || '' : '';
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: scrapeGoogleMapsDOM,
  }, function (results) {
    if (chrome.runtime.lastError) {
      console.log('[StayProof] executeScript error: ' + chrome.runtime.lastError.message);
      forwardXrefResult(reqId, { error: 'scrape_failed' });
      closeXrefTab(tabId);
      drainQueue();
      return;
    }

    var data = results && results[0] && results[0].result;
    console.log('[StayProof] Scrape result for ' + reqId + ':', JSON.stringify(data));

    if (data && data.error === 'captcha') {
      console.log('[StayProof] CAPTCHA detected, pausing queue');
      forwardXrefResult(reqId, { error: 'scrape_failed' });
      closeXrefTab(tabId);
      drainQueue();
      return;
    }

    if (data && (data.error === 'consent_clicked' || data.error === 'consent_page')) {
      console.log('[StayProof] Consent page detected for ' + reqId);
      if (data.error === 'consent_clicked') {
        // Consent was clicked — wait for redirect, then retry
        // The page should auto-redirect to continueUrl after consent
        if (attemptsLeft > 0) {
          setTimeout(function () {
            // Check if tab has navigated back to Google Maps
            chrome.tabs.get(tabId, function(tab) {
              if (chrome.runtime.lastError) {
                forwardXrefResult(reqId, null);
                closeXrefTab(tabId);
                drainQueue();
                return;
              }
              // If still on consent page, manually navigate to continueUrl
              if (tab.url && tab.url.indexOf('consent.google') !== -1 && data.continueUrl) {
                chrome.tabs.update(tabId, { url: data.continueUrl }, function() {
                  // Wait for new page load, then re-enter the scrape lifecycle
                  waitForLoadThenScrape(tabId, reqId);
                });
              } else {
                // Already redirected — retry scrape
                tryScrape(tabId, reqId, attemptsLeft - 1);
              }
            });
          }, 3000); // Wait 3s for consent redirect
          return;
        }
      }
      // consent_page (couldn't click) or no attempts left
      forwardXrefResult(reqId, { error: 'scrape_failed' });
      closeXrefTab(tabId);
      drainQueue();
      return;
    }

    // Search results: candidates array needs service-side name matching
    if (data && data.candidates && data.source === 'search') {
      var bestResult = null;
      var bestScore = -1;
      var threshold = SCORING_CONFIG.MATCHING.CONFIDENCE_THRESHOLD;
      for (var ci = 0; ci < data.candidates.length; ci++) {
        var c = data.candidates[ci];
        if (!c.googleName) continue;  // skip null-named candidates
        var score = nameMatchConfidence(searchedHotelName, c.googleName, searchCity);
        if (score > bestScore) {
          bestScore = score;
          bestResult = { rating: c.rating, reviewCount: c.reviewCount, histogram: null, googleName: c.googleName, matchScore: score, source: 'search', placeUrl: c.placeUrl };
        }
      }
      if (bestScore < threshold || !bestResult) {
        if (attemptsLeft > 0) {
          setTimeout(function () {
            tryScrape(tabId, reqId, attemptsLeft - 1, searchFallback);
          }, XREF_CONFIG.scrapeIntervalMs);
        } else {
          console.log('[StayProof] No match above threshold for ' + reqId);
          forwardXrefResult(reqId, null);
          closeXrefTab(tabId);
          drainQueue();
        }
        return;
      }
      data = bestResult;
    }

    if (data && data.rating) {
      // Search results lack histogram — navigate to detail page for it
      if (data.source === 'search' && data.placeUrl && !searchFallback) {
        console.log('[StayProof] Search result for ' + reqId + ', navigating to detail page for histogram');
        chrome.tabs.update(tabId, { url: data.placeUrl }, function () {
          if (chrome.runtime.lastError) {
            forwardXrefResult(reqId, data);
            closeXrefTab(tabId);
            drainQueue();
            return;
          }
          // Wait for detail page load, then re-scrape with search data as fallback
          function onDetailLoaded(updatedTabId, changeInfo) {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onDetailLoaded);
            setTimeout(function () {
              tryScrape(tabId, reqId, 2, data);  // 2 retries, search data as fallback
            }, XREF_CONFIG.initialWaitMs + 2000);  // +2s for SPA detail panel render
          }
          chrome.tabs.onUpdated.addListener(onDetailLoaded);
        });
        return;
      }
      // Success — detail panel or search fallback exhausted
      console.log('[StayProof] Got data for ' + reqId + ': ' + data.rating + '/5, ' + data.reviewCount + ' reviews, source=' + data.source);
      forwardXrefResult(reqId, data);
      closeXrefTab(tabId);
      drainQueue();
    } else if (attemptsLeft > 0) {
      // Retry
      setTimeout(function () {
        tryScrape(tabId, reqId, attemptsLeft - 1, searchFallback);
      }, XREF_CONFIG.scrapeIntervalMs);
    } else if (searchFallback) {
      // Detail page didn't load, but we have search data — forward it
      console.log('[StayProof] Detail page failed for ' + reqId + ', using search fallback');
      forwardXrefResult(reqId, searchFallback);
      closeXrefTab(tabId);
      drainQueue();
    } else {
      // Give up
      console.log('[StayProof] No results found for ' + reqId + ' after all retries');
      forwardXrefResult(reqId, { error: 'scrape_failed' });
      closeXrefTab(tabId);
      drainQueue();
    }
  });
}

// ─── Hidden window management ────────────────────────────────────────
// Hidden tab approach: offscreen API spike (PIPE-06) confirmed Google Maps
// does not render in offscreen iframes — cross-origin frame-busting blocks
// contentDocument access. Using off-screen positioned windows with a real
// viewport so IntersectionObserver and scroll-based lazy loading still work.

function openHiddenTab(url, callback) {
  function createInWindow(windowId) {
    chrome.tabs.create({ url: url, active: false, windowId: windowId }, function (tab) {
      if (chrome.runtime.lastError || !tab) {
        callback(null);
        return;
      }
      callback(tab);
    });
  }

  if (xrefWindowId !== null) {
    chrome.windows.get(xrefWindowId, function (win) {
      if (chrome.runtime.lastError || !win) {
        xrefWindowId = null;
        openHiddenTab(url, callback);
        return;
      }
      createInWindow(xrefWindowId);
    });
    return;
  }

  chrome.windows.create({
    url: url,
    focused: false,
    state: 'minimized',
    type: 'normal',
  }, function (win) {
    if (chrome.runtime.lastError || !win) {
      callback(null);
      return;
    }
    xrefWindowId = win.id;
    var tab = win.tabs && win.tabs[0];
    callback(tab || null);
  });
}

function closeXrefTab(tabId) {
  xrefActiveTabs.delete(tabId);
  persistQueue();
  chrome.tabs.remove(tabId).catch(function () {});

  if (xrefActiveTabs.size === 0 && xrefQueue.length === 0 && xrefWindowId !== null) {
    chrome.windows.remove(xrefWindowId).catch(function () {});
    xrefWindowId = null;
  }
}

function forwardXrefResult(reqId, data) {
  const req = xrefPending.get(reqId);
  if (!req) return;

  if (data && data.rating) {
    // Only cache detail-panel results (reliable) — search results may pick the wrong hotel
    if (data.source === 'detail') {
      const cacheKey = normalizeCacheKey(req.hotelName);
      xrefCache.set(cacheKey, {
        rating: data.rating,
        reviewCount: data.reviewCount,
        histogram: data.histogram || null,
        googleName: data.googleName || null,
        matchScore: data.matchScore || null,
        placeUrl: data.placeUrl || null,
        source: data.source,
        incomplete: !data.histogram,  // flag for retry eligibility on next visit
        ts: Date.now(),
      });
      saveXrefCache();
    } else if (data.source === 'search' && data.rating) {
      // Cache search-fallback results as incomplete so rating/name data is available
      // immediately, and the missing histogram triggers a re-scrape on next visit.
      const cacheKey = normalizeCacheKey(req.hotelName);
      xrefCache.set(cacheKey, {
        rating: data.rating,
        reviewCount: data.reviewCount,
        histogram: null,
        googleName: data.googleName || null,
        matchScore: data.matchScore || null,
        placeUrl: data.placeUrl || null,
        source: data.source,
        incomplete: true,
        ts: Date.now(),
      });
      saveXrefCache();
    }
  }

  // Route result to search page if this was a search-initiated xref
  if (req.searchListingId) {
    chrome.runtime.sendMessage({
      type: 'searchXrefResult',
      listingId: req.searchListingId,
      hotelName: req.hotelName,
      data: data,
    }).catch(function() {});
    xrefPending.delete(reqId);
    persistQueue();
    return;
  }

  console.log('[StayProof] Forwarding xref result for "' + req.hotelName + '" (' + reqId + ') to tab ' + req.bookingTabId);
  chrome.tabs.sendMessage(req.bookingTabId, {
    type: 'xrefData',
    requestId: reqId,
    hotelName: req.hotelName,
    data: data,
  }).catch(function (err) {
    console.log('[StayProof] Failed to forward: ' + err.message);
  });

  xrefPending.delete(reqId);
  persistQueue();
}

// ─── Search tab management ────────────────────────────────────────────

function openSearchTab(url, callback) {
  function createInWindow(windowId) {
    chrome.tabs.create({ url: url, active: false, windowId: windowId }, function (tab) {
      if (chrome.runtime.lastError || !tab) {
        callback(null);
        return;
      }
      callback(tab);
    });
  }

  if (searchWindowId !== null) {
    chrome.windows.get(searchWindowId, function (win) {
      if (chrome.runtime.lastError || !win) {
        searchWindowId = null;
        openSearchTab(url, callback);
        return;
      }
      createInWindow(searchWindowId);
    });
    return;
  }

  chrome.windows.create({
    url: url,
    focused: false,
    state: 'minimized',
    type: 'normal',
  }, function (win) {
    if (chrome.runtime.lastError || !win) {
      callback(null);
      return;
    }
    searchWindowId = win.id;
    var tab = win.tabs && win.tabs[0];
    callback(tab || null);
  });
}

function closeSearchTab(tabId) {
  searchActiveTabs.delete(tabId);
  persistSearchState();
  chrome.tabs.remove(tabId).catch(function () {});

  if (searchActiveTabs.size === 0 && searchWindowId !== null) {
    chrome.windows.remove(searchWindowId).catch(function () {});
    searchWindowId = null;
    stopKeepAlive();
  }
}

// ─── Search state persistence (survives SW restart, clears on browser close) ──

async function persistSearchState() {
  try {
    await chrome.storage.session.set({
      searchState: {
        meta: searchState,
      }
    });
  } catch (e) {
    console.log('[StayProof] Failed to persist search state:', e.message);
  }
}

async function restoreSearchState() {
  try {
    const data = await chrome.storage.session.get('searchState');
    if (!data.searchState) return;
    searchState = data.searchState.meta || null;
    // Do NOT restore activeTabs — tab IDs are stale after SW restart.
    searchActiveTabs = new Map();
    if (searchState) {
      console.log('[StayProof] Restored search state: ' + searchState.status + ' for ' + searchState.destination);
    }
  } catch (e) {
    console.log('[StayProof] Failed to restore search state:', e.message);
  }
}

// ─── Keep-alive alarm ────────────────────────────────────────────────

let keepAliveActive = false;

function startKeepAlive() {
  if (keepAliveActive) return;
  keepAliveActive = true;
  chrome.alarms.create('sift-keepalive', { periodInMinutes: 0.5 });
}

function stopKeepAlive() {
  // Don't stop if either system has active work
  if (xrefQueue.length > 0 || xrefActiveTabs.size > 0) return;
  if (searchActiveTabs.size > 0) return;
  if (!keepAliveActive) return;
  keepAliveActive = false;
  chrome.alarms.clear('sift-keepalive');
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sift-keepalive') {
    if (xrefQueue.length === 0 && xrefActiveTabs.size === 0 && searchActiveTabs.size === 0) {
      stopKeepAlive();
    }
  }
});

// ─── Cleanup listeners ──────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (xrefActiveTabs.has(tabId)) {
    var reqId = xrefActiveTabs.get(tabId);
    xrefActiveTabs.delete(tabId);
    // Forward failure so search page doesn't stay stuck in 'checking'
    if (reqId && xrefPending.has(reqId)) {
      forwardXrefResult(reqId, { error: 'scrape_failed' });
    }
    drainQueue();
  }
  if (searchActiveTabs.has(tabId)) {
    searchActiveTabs.delete(tabId);
    persistSearchState();
    if (searchActiveTabs.size === 0) {
      stopKeepAlive();
    }
  }
});

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === xrefWindowId) {
    xrefWindowId = null;
  }
  if (windowId === searchWindowId) {
    searchWindowId = null;
  }
});

// ─── Initialize settings ────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

// ─── Restore queue state on service worker startup ───────────────────

restoreQueue();
restoreSearchState();

// ─── Booking.com search scraper (injected into hidden tab via executeScript) ──

/**
 * Self-contained Booking.com search scraper — runs inside a hidden tab.
 * Waits for cards, scrolls to trigger lazy loading, extracts all listings.
 * Returns Promise resolving to array of listing objects.
 *
 * TEST THIS: open a Booking.com search results page, paste this function
 * in the console, then call scrapeBookingSearch().then(r => console.table(r))
 */
function scrapeBookingSearch() {
  return new Promise(function(resolve) {
    var maxWait = 10000;
    var startTime = Date.now();

    function waitForCards() {
      var cards = document.querySelectorAll('[data-testid="property-card"]');
      if (cards.length > 0 || Date.now() - startTime > maxWait) {
        startScrolling();
        return;
      }
      setTimeout(waitForCards, 500);
    }

    function startScrolling() {
      var scrollCount = 0;
      var maxScrolls = 5;
      function scrollOnce() {
        if (scrollCount >= maxScrolls) {
          var listings = extractAll();
          // Collect script tag texts for coordinate extraction
          var scripts = document.querySelectorAll('script');
          var scriptTexts = [];
          for (var si = 0; si < scripts.length; si++) {
            var st = scripts[si].textContent;
            if (st && st.length >= 100 && st.indexOf('"latitude"') !== -1) {
              scriptTexts.push(st);
            }
          }
          extractBookingCoordinates(listings, scriptTexts);
          console.log('[StayProof] Coord extraction: ' + listings.filter(function(l) { return l.lat !== null; }).length + '/' + listings.length + ' matched');
          resolve(listings);
          return;
        }
        scrollCount++;
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(scrollOnce, 1000);
      }
      scrollOnce();
    }

    function extractAll() {
      var cards = document.querySelectorAll('[data-testid="property-card"]');
      var listings = [];
      var seenUrls = {};
      for (var i = 0; i < cards.length; i++) {
        var listing = extractBookingCard(cards[i]);
        if (listing && listing.url && !seenUrls[listing.url]) {
          seenUrls[listing.url] = true;
          listings.push(listing);
        }
      }
      return listings;
    }

    function extractBookingCard(card) {
      // Title — data-testid first, heading fallback
      var titleEl = card.querySelector('[data-testid="title"]');
      if (!titleEl) titleEl = card.querySelector('h2, h3');
      var name = titleEl ? titleEl.textContent.trim() : null;
      if (name) {
        name = name.replace(/Opens in new window\s*$/i, '').trim();
        var hashIdx = name.indexOf('#');
        if (hashIdx > 0) name = name.substring(0, hashIdx).trim();
      }

      // Rating + review count from review score box
      var rating = null;
      var reviewCount = 0;
      var reviewBox = card.querySelector('[data-testid="review-score"]');
      if (reviewBox) {
        var text = reviewBox.textContent;
        var ratingMatch = text.match(/(\d+\.?\d*)\s*$/m) || text.match(/(\d+\.?\d*)/);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);
        var countMatch = text.match(/([\d,]+)\s*review/i);
        if (countMatch) reviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);
      }

      // Price — data-testid cascade, then regex fallback
      var price = null;
      var priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');
      if (!priceEl) priceEl = card.querySelector('[data-testid="price"]');
      if (priceEl) {
        var priceMatch = priceEl.textContent.replace(/,/g, '').match(/[\d]+\.?\d*/);
        if (priceMatch) price = parseFloat(priceMatch[0]);
      }
      if (price === null) {
        var priceTextMatch = card.textContent.replace(/,/g, '').match(/[£$€]\s*([\d]+\.?\d*)/);
        if (priceTextMatch) price = parseFloat(priceTextMatch[1]);
      }

      // URL — data-testid link, then /hotel/ link, then any anchor
      var linkEl = card.querySelector('a[data-testid="title-link"]');
      if (!linkEl) linkEl = card.querySelector('a[href*="/hotel/"]');
      if (!linkEl) linkEl = card.querySelector('a[href]');
      var url = linkEl ? (linkEl.href || null) : null;

      // Badges
      var isNew = !!card.querySelector('[data-testid="badge-new"]') ||
                  /new to booking/i.test(card.textContent);

      if (!name) return null;

      return {
        name: name,
        platform: 'booking',
        rating: rating,
        reviewCount: reviewCount,
        price: price,
        url: url,
        badges: { isNew: isNew },
      };
    }

    function extractBookingCoordinates(listings, scriptTexts) {
      var _now = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };
      var t0 = _now();
      var timeBudget = 200;

      // Initialize all listings with null coords
      var slugMap = {};
      for (var ci = 0; ci < listings.length; ci++) {
        listings[ci].lat = null;
        listings[ci].lng = null;
        if (listings[ci].url) {
          var cm = listings[ci].url.match(/\/hotel\/[^/]+\/([^/.]+)/);
          if (cm) slugMap[cm[1]] = ci;
        }
      }

      for (var cs = 0; cs < scriptTexts.length; cs++) {
        if (_now() - t0 > timeBudget) break;

        var ctext = scriptTexts[cs];
        if (!ctext || ctext.length < 100) continue;
        if (ctext.indexOf('"latitude"') === -1) continue;

        var cre = /"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)\s*}\s*,\s*"pageName"\s*:\s*"([^"]+)"/g;
        var cmatch;
        while ((cmatch = cre.exec(ctext)) !== null) {
          if (_now() - t0 > timeBudget) break;
          var clat = parseFloat(cmatch[1]);
          var clng = parseFloat(cmatch[2]);
          var cslug = cmatch[3];
          if (isNaN(clat) || isNaN(clng)) continue;
          if (clat < -90 || clat > 90 || clng < -180 || clng > 180) continue;
          if (clat === 0 && clng === 0) continue;
          if (cslug in slugMap) {
            listings[slugMap[cslug]].lat = clat;
            listings[slugMap[cslug]].lng = clng;
          }
        }
      }

      return listings;
    }

    waitForCards();
  });
}

/**
 * Standalone extraction helper — same logic as the inner extractBookingCard
 * inside scrapeBookingSearch, but importable for unit testing.
 * NOT used by executeScript (the self-contained version is inlined above).
 */
function _extractBookingCard(card) {
  // Title — data-testid first, heading fallback
  var titleEl = card.querySelector('[data-testid="title"]');
  if (!titleEl) titleEl = card.querySelector('h2, h3');
  var name = titleEl ? titleEl.textContent.trim() : null;
  if (name) {
    name = name.replace(/Opens in new window\s*$/i, '').trim();
    var hashIdx = name.indexOf('#');
    if (hashIdx > 0) name = name.substring(0, hashIdx).trim();
  }

  // Rating + review count from review score box
  var rating = null;
  var reviewCount = 0;
  var reviewBox = card.querySelector('[data-testid="review-score"]');
  if (reviewBox) {
    var text = reviewBox.textContent;
    var ratingMatch = text.match(/(\d+\.?\d*)\s*$/m) || text.match(/(\d+\.?\d*)/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);
    var countMatch = text.match(/([\d,]+)\s*review/i);
    if (countMatch) reviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);
  }

  // Price — data-testid cascade, then regex fallback
  var price = null;
  var priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');
  if (!priceEl) priceEl = card.querySelector('[data-testid="price"]');
  if (priceEl) {
    var priceMatch = priceEl.textContent.replace(/,/g, '').match(/[\d]+\.?\d*/);
    if (priceMatch) price = parseFloat(priceMatch[0]);
  }
  if (price === null) {
    var priceTextMatch = card.textContent.replace(/,/g, '').match(/[£$€]\s*([\d]+\.?\d*)/);
    if (priceTextMatch) price = parseFloat(priceTextMatch[1]);
  }

  // URL — data-testid link, then /hotel/ link, then any anchor
  var linkEl = card.querySelector('a[data-testid="title-link"]');
  if (!linkEl) linkEl = card.querySelector('a[href*="/hotel/"]');
  if (!linkEl) linkEl = card.querySelector('a[href]');
  var url = linkEl ? (linkEl.href || null) : null;

  // Badges
  var isNew = !!card.querySelector('[data-testid="badge-new"]') ||
              /new to booking/i.test(card.textContent);

  if (!name) return null;

  return {
    name: name,
    platform: 'booking',
    rating: rating,
    reviewCount: reviewCount,
    price: price,
    url: url,
    badges: { isNew: isNew },
  };
}

/**
 * Standalone Airbnb card extraction — mirrors the inner extractAirbnbCard
 * inside scrapeAirbnbSearch, importable for unit testing.
 * NOT used by executeScript (the self-contained version is inlined below).
 */
function _extractAirbnbCard(card) {
  var name = null;

  var cardNameEl = card.querySelector('[data-testid="listing-card-name"]');
  if (cardNameEl) name = cardNameEl.textContent.trim();

  if (!name) {
    var mainLink = card.querySelector('a[aria-label]');
    if (mainLink) {
      var ariaName = mainLink.getAttribute('aria-label');
      if (ariaName) {
        name = ariaName.replace(/,\s*[\d.]+\s*out of\s*\d+.*$/i, '').trim();
      }
    }
  }

  if (!name) {
    var metaName = card.querySelector('meta[itemprop="name"]');
    if (metaName) name = metaName.getAttribute('content');
  }

  if (!name) {
    var titleEl = card.querySelector('[data-testid="listing-card-title"]');
    if (!titleEl) titleEl = card.querySelector('div[id*="title"]');
    if (titleEl) name = titleEl.textContent.trim();
  }

  if (name) name = name.replace(/^\d+\.{2,}\s*/, '');

  var rating = null;
  var ratingEl = card.querySelector('[aria-label*="rating"]');
  if (ratingEl) {
    var label = ratingEl.getAttribute('aria-label') || ratingEl.textContent;
    var rMatch = label.match(/(\d+\.?\d*)/);
    if (rMatch) rating = parseFloat(rMatch[1]);
  }
  if (rating === null) {
    var outOf5Match = card.textContent.match(/(\d+\.?\d*)\s*out of 5/);
    if (outOf5Match && parseFloat(outOf5Match[1]) > 0) rating = parseFloat(outOf5Match[1]);
  }

  var reviewCount = 0;
  var countEl = card.querySelector('[aria-label*="review"]');
  if (countEl) {
    var cLabel = countEl.getAttribute('aria-label') || countEl.textContent;
    var cMatch = cLabel.match(/([\d,]+)\s*review/i);
    if (cMatch) reviewCount = parseInt(cMatch[1].replace(/,/g, ''), 10);
  }
  if (reviewCount === 0) {
    var textCountMatch = card.textContent.match(/([\d,]+)\s*review/i);
    if (textCountMatch) reviewCount = parseInt(textCountMatch[1].replace(/,/g, ''), 10);
  }

  var price = null;
  var priceCurrency = 'USD';
  var priceEl = card.querySelector('[data-testid="price-availability-row"] span');
  if (priceEl) {
    var priceRaw = priceEl.textContent.replace(/,/g, '');
    if (/£/.test(priceRaw)) priceCurrency = 'GBP';
    else if (/€/.test(priceRaw)) priceCurrency = 'EUR';
    var pMatch = priceRaw.match(/[\d]+\.?\d*/);
    if (pMatch) price = parseFloat(pMatch[0]);
  }
  if (price === null) {
    var pTextRaw = card.textContent.replace(/,/g, '');
    var pTextMatch = pTextRaw.match(/[£$€]\s*([\d]+\.?\d*)/);
    if (pTextMatch) {
      price = parseFloat(pTextMatch[1]);
      if (/£/.test(pTextRaw)) priceCurrency = 'GBP';
      else if (/€/.test(pTextRaw)) priceCurrency = 'EUR';
    }
  }
  if (price !== null && priceCurrency !== 'USD') {
    var fxRates = { GBP: 1.27, EUR: 1.09 };
    price = Math.round(price * (fxRates[priceCurrency] || 1));
  }

  var linkEl = card.querySelector('a[href*="/rooms/"]');
  if (!linkEl) linkEl = card.querySelector('a[href]');
  var url = linkEl ? linkEl.href : null;

  var isSuperhost = !!card.querySelector('[aria-label*="Superhost"]') ||
                    /superhost/i.test(card.textContent);
  var isGuestFavorite = !!card.querySelector('[aria-label*="Guest favorite"]') ||
                        /guest\s*favou?rite/i.test(card.textContent);

  if (!name && rating === null) return null;

  return {
    name: name,
    platform: 'airbnb',
    rating: rating,
    reviewCount: reviewCount,
    price: price,
    url: url,
    badges: { isSuperhost: isSuperhost, isGuestFavorite: isGuestFavorite },
  };
}

// ─── Airbnb search scraper (injected into hidden tab via executeScript) ──

/**
 * Self-contained Airbnb search scraper — runs inside a hidden tab.
 * Waits for cards, extracts all listings. No scrolling needed (Airbnb
 * loads ~20 listings on initial render).
 * Returns Promise resolving to array of listing objects.
 *
 * TEST THIS: open an Airbnb search results page, paste this function
 * in the console, then call scrapeAirbnbSearch().then(r => console.table(r))
 */
function scrapeAirbnbSearch() {
  return new Promise(function(resolve) {
    var maxWait = 15000;
    var stableMs = 1500;   // resolve once card count unchanged for this long
    var startTime = Date.now();
    var lastCount = 0;
    var lastChangeTime = startTime;

    // Log page state for debugging regional redirects
    console.log('[StayProof Airbnb] Page URL: ' + location.href);
    console.log('[StayProof Airbnb] Page title: ' + document.title);

    // Dismiss cookie consent / GDPR overlays that block search results
    function dismissConsent() {
      var selectors = [
        'button[data-testid="accept-btn"]',
        'button[data-testid="accept-cookies-btn"]',
        'button[data-testid="main-cookies-banner-container"] button',
        '[aria-label="Accept cookies"]',
        '[aria-label="OK"]',
      ];
      for (var si = 0; si < selectors.length; si++) {
        var btn = document.querySelector(selectors[si]);
        if (btn) {
          console.log('[StayProof Airbnb] Dismissing consent: ' + selectors[si]);
          btn.click();
          return true;
        }
      }
      return false;
    }
    dismissConsent();

    function waitForCards() {
      var cards = document.querySelectorAll(
        '[data-testid="card-container"], [itemprop="itemListElement"]'
      );
      var now = Date.now();

      if (cards.length !== lastCount) {
        lastCount = cards.length;
        lastChangeTime = now;
      }

      // Try dismissing consent on each poll in case it appeared late
      if (lastCount === 0 && now - startTime > 3000) dismissConsent();

      // Resolve when: cards found AND count stable for stableMs, OR timeout
      var stable = lastCount > 0 && (now - lastChangeTime >= stableMs);
      if (stable || now - startTime > maxWait) {
        if (lastCount === 0) {
          console.log('[StayProof Airbnb] Timeout with 0 cards. Body classes: ' + document.body.className);
          console.log('[StayProof Airbnb] Body child count: ' + document.body.children.length);
          var h1 = document.querySelector('h1');
          if (h1) console.log('[StayProof Airbnb] First h1: ' + h1.textContent.substring(0, 100));
        }
        var listings = extractAll();
        // Collect script tag texts for coordinate extraction
        var scripts = document.querySelectorAll('script');
        var scriptTexts = [];
        for (var si = 0; si < scripts.length; si++) {
          var st = scripts[si].textContent;
          if (st && st.length >= 100 && st.indexOf('"latitude"') !== -1) {
            scriptTexts.push(st);
          }
        }
        extractAirbnbCoordinates(listings, scriptTexts);
        console.log('[StayProof] Coord extraction: ' + listings.filter(function(l) { return l.lat !== null; }).length + '/' + listings.length + ' matched');
        resolve(listings);
        return;
      }
      setTimeout(waitForCards, 300);
    }

    function extractAll() {
      var cards = document.querySelectorAll(
        '[data-testid="card-container"], [itemprop="itemListElement"]'
      );
      var listings = [];
      var seenUrls = {};

      // Debug: log first card structure
      if (cards.length > 0) {
        console.log('[StayProof Airbnb] Found ' + cards.length + ' cards');
        var fc = cards[0];
        var aLinks = fc.querySelectorAll('a[aria-label]');
        for (var al = 0; al < aLinks.length; al++) {
          console.log('[StayProof Airbnb] a[aria-label]:', aLinks[al].getAttribute('aria-label'));
        }
        var metas = fc.querySelectorAll('meta[itemprop]');
        for (var mi = 0; mi < metas.length; mi++) {
          console.log('[StayProof Airbnb] meta:', metas[mi].getAttribute('itemprop'), '=', metas[mi].getAttribute('content'));
        }
        var titleEl = fc.querySelector('[data-testid="listing-card-title"]');
        if (titleEl) console.log('[StayProof Airbnb] listing-card-title:', titleEl.textContent);
        var subtitleEl = fc.querySelector('[data-testid="listing-card-subtitle"]');
        if (subtitleEl) console.log('[StayProof Airbnb] listing-card-subtitle:', subtitleEl.textContent);
      }

      for (var i = 0; i < cards.length; i++) {
        var listing = extractAirbnbCard(cards[i]);
        if (listing && listing.url && !seenUrls[listing.url]) {
          seenUrls[listing.url] = true;
          listings.push(listing);
        }
      }
      return listings;
    }

    function extractAirbnbCard(card) {
      // Name — prefer the actual listing name over Airbnb's generic "Condo in City" label
      var name = null;

      // 1. listing-card-name testid — actual listing name (added ~Apr 2026)
      var cardNameEl = card.querySelector('[data-testid="listing-card-name"]');
      if (cardNameEl) name = cardNameEl.textContent.trim();

      // 2. aria-label on the card's main link (legacy path, still present on some cards)
      if (!name) {
        var mainLink = card.querySelector('a[aria-label]');
        if (mainLink) {
          var ariaName = mainLink.getAttribute('aria-label');
          // Strip trailing ", <rating> out of 5" suffix if present
          if (ariaName) {
            name = ariaName.replace(/,\s*[\d.]+\s*out of\s*\d+.*$/i, '').trim();
          }
        }
      }

      // 3. meta itemprop="name" (structured data)
      if (!name) {
        var metaName = card.querySelector('meta[itemprop="name"]');
        if (metaName) name = metaName.getAttribute('content');
      }

      // 4. data-testid="listing-card-title" — often just "Condo in City" but better than nothing
      if (!name) {
        var titleEl = card.querySelector('[data-testid="listing-card-title"]');
        if (!titleEl) titleEl = card.querySelector('div[id*="title"]');
        if (titleEl) name = titleEl.textContent.trim();
      }

      // Strip leading ranking prefix from any source (e.g., "2.." or "15.")
      // Only strip when followed by double dots or dot+space+capital (ranking artifacts).
      // Preserve real names like "01 Bedroom Apt" or "4.2 Banana Flower" (room identifiers).
      if (name) name = name.replace(/^\d+\.{2,}\s*/, '');

      // Rating — aria-label first, star symbol fallback
      var rating = null;
      var ratingEl = card.querySelector('[aria-label*="rating"]');
      if (ratingEl) {
        var label = ratingEl.getAttribute('aria-label') || ratingEl.textContent;
        var rMatch = label.match(/(\d+\.?\d*)/);
        if (rMatch) rating = parseFloat(rMatch[1]);
      }
      if (rating === null) {
        var outOf5Match = card.textContent.match(/(\d+\.?\d*)\s*out of 5/);
        if (outOf5Match && parseFloat(outOf5Match[1]) > 0) rating = parseFloat(outOf5Match[1]);
      }

      // Review count — aria-label first, text fallback
      var reviewCount = 0;
      var countEl = card.querySelector('[aria-label*="review"]');
      if (countEl) {
        var cLabel = countEl.getAttribute('aria-label') || countEl.textContent;
        var cMatch = cLabel.match(/([\d,]+)\s*review/i);
        if (cMatch) reviewCount = parseInt(cMatch[1].replace(/,/g, ''), 10);
      }
      if (reviewCount === 0) {
        var textCountMatch = card.textContent.match(/([\d,]+)\s*review/i);
        if (textCountMatch) reviewCount = parseInt(textCountMatch[1].replace(/,/g, ''), 10);
      }

      // Price — data-testid first, currency-aware regex fallback
      var price = null;
      var priceCurrency = 'USD';
      var priceEl = card.querySelector('[data-testid="price-availability-row"] span');
      if (priceEl) {
        var priceRaw = priceEl.textContent.replace(/,/g, '');
        // Detect currency symbol
        if (/£/.test(priceRaw)) priceCurrency = 'GBP';
        else if (/€/.test(priceRaw)) priceCurrency = 'EUR';
        var pMatch = priceRaw.match(/[\d]+\.?\d*/);
        if (pMatch) price = parseFloat(pMatch[0]);
      }
      if (price === null) {
        var pTextRaw = card.textContent.replace(/,/g, '');
        var pTextMatch = pTextRaw.match(/[£$€]\s*([\d]+\.?\d*)/);
        if (pTextMatch) {
          price = parseFloat(pTextMatch[1]);
          if (/£/.test(pTextRaw)) priceCurrency = 'GBP';
          else if (/€/.test(pTextRaw)) priceCurrency = 'EUR';
        }
      }
      // Convert non-USD to approximate USD
      if (price !== null && priceCurrency !== 'USD') {
        var fxRates = { GBP: 1.27, EUR: 1.09 };
        price = Math.round(price * (fxRates[priceCurrency] || 1));
      }

      // URL — /rooms/ link first, any anchor fallback
      var linkEl = card.querySelector('a[href*="/rooms/"]');
      if (!linkEl) linkEl = card.querySelector('a[href]');
      var url = linkEl ? new URL(linkEl.href, window.location.origin).href : null;

      // Badges
      var isSuperhost = !!card.querySelector('[aria-label*="Superhost"]') ||
                        /superhost/i.test(card.textContent);
      var isGuestFavorite = !!card.querySelector('[aria-label*="Guest favorite"]') ||
                            /guest\s*favou?rite/i.test(card.textContent);

      if (!name && rating === null) return null;

      return {
        name: name,
        platform: 'airbnb',
        rating: rating,
        reviewCount: reviewCount,
        price: price,
        url: url,
        badges: { isSuperhost: isSuperhost, isGuestFavorite: isGuestFavorite },
      };
    }

    function extractAirbnbCoordinates(listings, scriptTexts) {
      var _now = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };
      var t0 = _now();
      var timeBudget = 200;

      // Initialize all listings with null coords
      var idMap = {};
      for (var ci = 0; ci < listings.length; ci++) {
        listings[ci].lat = null;
        listings[ci].lng = null;
        if (listings[ci].url) {
          var cm = listings[ci].url.match(/\/rooms\/(\d+)/);
          if (cm) idMap[cm[1]] = ci;
        }
      }

      for (var cs = 0; cs < scriptTexts.length; cs++) {
        if (_now() - t0 > timeBudget) break;

        var ctext = scriptTexts[cs];
        if (!ctext || ctext.length < 100) continue;
        if (ctext.indexOf('"latitude"') === -1) continue;

        // Forward scan: find each DemandStayListing ID, then find its coordinate ahead
        var idRe = /"id"\s*:\s*"([^"]+)"/g;
        var idMatch;
        while ((idMatch = idRe.exec(ctext)) !== null) {
          if (_now() - t0 > timeBudget) break;
          var rawId = idMatch[1];
          var numericId = null;
          if (/^\d+$/.test(rawId)) {
            numericId = rawId;
          } else {
            try {
              var decoded = atob(rawId);
              var colonIdx = decoded.lastIndexOf(':');
              if (colonIdx !== -1) {
                var numPart = decoded.substring(colonIdx + 1);
                if (/^\d+$/.test(numPart)) numericId = numPart;
              }
            } catch (e) { /* not base64 — skip */ }
          }
          if (!numericId || !(numericId in idMap)) continue;

          // Scan forward up to 5000 chars for the next coordinate
          var lookahead = ctext.substring(idMatch.index, Math.min(ctext.length, idMatch.index + 5000));
          var coordMatch = lookahead.match(/"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)/);
          if (!coordMatch) continue;

          var clat = parseFloat(coordMatch[1]);
          var clng = parseFloat(coordMatch[2]);
          if (isNaN(clat) || isNaN(clng)) continue;
          if (clat < -90 || clat > 90 || clng < -180 || clng > 180) continue;
          if (clat === 0 && clng === 0) continue;

          listings[idMap[numericId]].lat = clat;
          listings[idMap[numericId]].lng = clng;
        }
      }

      return listings;
    }

    waitForCards();
  });
}

// ─── Search tab dispatcher (integration helper for Phase 10) ─────────

/**
 * Inject the appropriate search scraper into a tab and return results.
 * @param {number} tabId - Chrome tab ID
 * @param {string} platform - 'booking' or 'airbnb'
 * @param {function} callback - Called with (listings|null)
 */
function scrapeSearchTab(tabId, platform, callback) {
  var scrapeFunc = platform === 'booking' ? scrapeBookingSearch
    : platform === 'agoda' ? scrapeAgodaSearch
    : scrapeAirbnbSearch;

  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: scrapeFunc,
  }, function(results) {
    if (chrome.runtime.lastError) {
      console.log('[StayProof] Search scrape error (' + platform + '): ' + chrome.runtime.lastError.message);
      callback(null);
      return;
    }
    var listings = results && results[0] && results[0].result;
    console.log('[StayProof] Scraped ' + (listings ? listings.length : 0) + ' ' + platform + ' listings');
    callback(listings || []);
  });
}

// ─── URL builders (currency-forced, locale-forced) ───────────────────

/**
 * Build a Booking.com search URL with USD currency and English locale.
 * Pure function — no side effects.
 */
function buildBookingSearchUrl(destination, checkin, checkout, maxPrice) {
  const params = new URLSearchParams({
    ss: destination,
    checkin: checkin,
    checkout: checkout,
    group_adults: '2',
    no_rooms: '1',
    selected_currency: 'USD',
  });
  if (maxPrice && isFinite(maxPrice)) {
    params.set('nflt', 'price=USD-min-' + maxPrice + '-1');
  }
  return 'https://www.booking.com/searchresults.en-us.html?' + params.toString();
}

/**
 * Build an Airbnb search URL with USD currency and English locale.
 * Pure function — no side effects.
 */
/**
 * Resolve a destination string to an Airbnb place via their autocomplete API.
 * Returns a Promise resolving to { placeId, query } or null.
 */
function resolveAirbnbPlace(destination) {
  var url = 'https://www.airbnb.com/api/v2/autocompletes?'
    + 'key=d306zoyjsyarp7ifhu67rjxn52tv0t20'
    + '&language=en&locale=en&country=US&num_results=5'
    + '&api_version=1.1.1&vertical_refinement=homes&region=-1'
    + '&options=should_filter_by_vertical_refinement%7Cshould_show_stays%7Csimple_search'
    + '&user_input=' + encodeURIComponent(destination);
  console.log('[StayProof] Resolving Airbnb place for:', destination);
  return fetch(url)
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      if (!data || !data.autocomplete_terms || data.autocomplete_terms.length === 0) return null;
      var top = data.autocomplete_terms[0];
      var params = top.explore_search_params || {};
      var placeId = params.place_id || null;
      var query = params.query || destination;
      console.log('[StayProof] Airbnb resolved:', query, 'place_id:', placeId);
      return { placeId: placeId, query: query };
    })
    .catch(function(err) {
      console.log('[StayProof] Airbnb place resolve error:', err);
      return null;
    });
}

function buildAirbnbSearchUrl(destination, checkin, checkout, options) {
  var opts = options || {};
  const encodedDest = encodeURIComponent(destination);
  const params = new URLSearchParams({
    checkin: checkin,
    checkout: checkout,
    adults: '2',
    currency: 'USD',
    locale: 'en',
  });
  if (opts.placeId) {
    params.set('place_id', opts.placeId);
  }
  if (opts.entireHomesOnly) {
    params.append('room_types[]', 'Entire home/apt');
  }
  if (opts.guestFavourite) {
    params.set('guest_favorite', 'true');
  }
  if (opts.maxPrice && isFinite(opts.maxPrice)) {
    params.set('price_max', String(opts.maxPrice));
    params.set('price_filter_input_type', '2');
    params.set('price_filter_num_nights', '1');
  }
  return 'https://www.airbnb.com/s/' + encodedDest + '/homes?' + params.toString();
}

/**
 * Resolve a destination string to an Agoda city ID via their suggest API.
 * Returns a Promise resolving to the city ID number, or null if not found.
 */
/**
 * Pick best city result from Agoda suggest API response.
 * Returns { cityId, name } or null. Pure function — testable without network.
 */
function pickAgodaSuggestResult(data) {
  if (!data || !data.ViewModelList) return null;
  // First pass: prefer items with a real CityId (cities, areas, landmarks)
  for (var i = 0; i < data.ViewModelList.length; i++) {
    var item = data.ViewModelList[i];
    if (!item.DisplayNames) continue;
    if (item.CityId > 0) {
      // Extract area ID: if ObjectId differs from CityId, it's a sub-area constraint
      var areaId = (item.ObjectId > 0 && item.ObjectId !== item.CityId) ? item.ObjectId : null;
      // Also check the preceding item's ResultUrl for an explicit area= param
      if (!areaId && i > 0) {
        var prev = data.ViewModelList[i - 1];
        if (prev.ResultUrl) {
          var areaMatch = prev.ResultUrl.match(/area=(\d+)/);
          if (areaMatch) areaId = parseInt(areaMatch[1], 10);
        }
      }
      return { cityId: item.CityId, areaId: areaId, name: item.DisplayNames.Name || item.Name };
    }
  }
  // Second pass: fall back to ObjectId for non-hotel items (districts etc.)
  for (var j = 0; j < data.ViewModelList.length; j++) {
    var fallback = data.ViewModelList[j];
    if (!fallback.DisplayNames) continue;
    if (fallback.ObjectId > 0 && !fallback.IsHotel) return { cityId: fallback.ObjectId, areaId: null, name: fallback.DisplayNames.Name || fallback.Name };
  }
  return null;
}

function resolveAgodaCityId(destination) {
  var url = 'https://www.agoda.com/api/cronos/search/GetUnifiedSuggestResult/3/1/1/0/en-us/?searchText='
    + encodeURIComponent(destination) + '&origin=US&cid=-1&pageTypeId=1&logTypeId=1';
  console.log('[StayProof] Resolving Agoda city for:', destination, 'URL:', url);
  return fetch(url)
    .then(function(resp) {
      console.log('[StayProof] Agoda suggest response status:', resp.status);
      return resp.json();
    })
    .then(function(data) {
      return pickAgodaSuggestResult(data);
    })
    .catch(function(err) {
      console.log('[StayProof] Agoda city resolve error:', err);
      return null;
    });
}

/**
 * Build an Agoda search URL with USD currency and English locale.
 * Requires a numeric city ID (resolved via resolveAgodaCityId).
 */
function buildAgodaSearchUrl(cityId, areaId, destination, checkin, checkout, maxPrice) {
  var params = new URLSearchParams({
    city: String(cityId),
    checkIn: checkin,
    checkOut: checkout,
    rooms: '1',
    adults: '2',
    children: '0',
    locale: 'en-us',
    currency: 'USD',
    priceCur: 'USD',
    textToSearch: destination,
    productType: '-1',
    travellerType: '1',
    cid: '-1',
  });
  if (areaId) params.set('area', String(areaId));
  if (maxPrice && isFinite(maxPrice)) {
    params.set('PriceFrom', '0');
    params.set('PriceTo', String(maxPrice));
  }
  return 'https://www.agoda.com/search?' + params.toString();
}

// ─── Agoda search scraper (injected into hidden tab via executeScript) ──

/**
 * Self-contained Agoda search scraper — runs inside a hidden tab.
 * Waits for cards, scrolls to trigger lazy loading, extracts all listings.
 * Returns Promise resolving to array of listing objects.
 */
function scrapeAgodaSearch() {
  return new Promise(function(resolve) {
    var maxWait = 30000;
    var startTime = Date.now();
    var lastCount = 0;
    var lastChangeTime = Date.now();
    var stableMs = 1000;
    // Try multiple card selectors — Agoda changes their DOM frequently
    function findCards() {
      var selectors = [
        '[data-selenium="hotel-item"]',
        'li.PropertyCard',
        '[data-element-name="property-card"]',
        'ol.hotel-list-container > li',
        '[class*="PropertyCard"]',
        '[class*="property-card"]',
        '[class*="PropertyListItem"]',
        'li[data-hotelid]',
        'div[data-hotelid]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var cards = document.querySelectorAll(selectors[s]);
        if (cards.length > 0) return cards;
      }
      var hotelLinks = document.querySelectorAll('a[href*="/hotel/"]');
      if (hotelLinks.length >= 3) {
        var seen = new Set();
        var items = [];
        for (var h = 0; h < hotelLinks.length; h++) {
          var li = hotelLinks[h].closest('li') || hotelLinks[h].closest('div[class*="Card"], div[class*="card"]');
          if (li && !seen.has(li)) {
            seen.add(li);
            items.push(li);
          }
        }
        if (items.length >= 3) return items;
      }
      return [];
    }

    function countReadyCards(cards) {
      var ready = 0;
      for (var c = 0; c < cards.length; c++) {
        var nameEl = cards[c].querySelector('h3[data-selenium="hotel-name"]')
          || cards[c].querySelector('[data-selenium="hotel-name"]')
          || cards[c].querySelector('h3')
          || cards[c].querySelector('[class*="hotel-name"], [class*="HotelName"], [class*="propertyName"]');
        if (nameEl && nameEl.textContent.trim()) ready++;
      }
      return ready;
    }

    function scrollAllCards(cards, callback) {
      var idx = 0;
      function scrollNext() {
        if (idx >= cards.length) {
          callback();
          return;
        }
        cards[idx].scrollIntoView({ behavior: 'instant', block: 'center' });
        idx++;
        setTimeout(scrollNext, 30);
      }
      scrollNext();
    }

    function waitForCards() {
      var cards = findCards();
      var readyCount = countReadyCards(cards);
      var now = Date.now();
      if (readyCount !== lastCount) {
        lastCount = readyCount;
        lastChangeTime = now;
      }
      var stable = lastCount > 0 && (now - lastChangeTime >= stableMs);
      if (stable || now - startTime > maxWait) {
        // Pass 1: scroll initial cards to trigger IntersectionObserver loading
        scrollAllCards(cards, function() {
          // Wait for new cards to appear after scrolling
          setTimeout(function() {
            var newCards = findCards();
            if (newCards.length > cards.length) {
              // Pass 2: scroll only the newly loaded cards (skip already-scrolled ones)
              var onlyNewCards = Array.prototype.slice.call(newCards, cards.length);
              scrollAllCards(onlyNewCards, function() {
                var finalWait = Math.min(newCards.length * 50, 500);
                setTimeout(function() { resolve(extractFromCards(findCards())); }, finalWait);
              });
            } else {
              var finalWait = Math.min(cards.length * 50, 500);
              setTimeout(function() { resolve(extractFromCards(findCards())); }, finalWait);
            }
          }, 500);
        });
        return;
      }
      setTimeout(waitForCards, 500);
    }

    function extractFromCards(cards) {
      var listings = [];

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        try {
          // Name — try multiple selectors
          var nameEl = card.querySelector('h3[data-selenium="hotel-name"]')
            || card.querySelector('[data-selenium="hotel-name"]')
            || card.querySelector('h3')
            || card.querySelector('[class*="hotel-name"], [class*="HotelName"], [class*="propertyName"]');
          var name = nameEl ? nameEl.textContent.trim() : '';
          if (!name) continue;

          // Rating (out of 10) — try multiple selectors
          var rating = null;
          var ratingEl = card.querySelector('[data-element-name="review-score"]')
            || card.querySelector('[data-selenium="review-score"]')
            || card.querySelector('[class*="review-score"], [class*="ReviewScore"]');
          if (ratingEl) {
            var ratingMatch = ratingEl.textContent.match(/(\d+\.?\d*)/);
            if (ratingMatch) rating = parseFloat(ratingMatch[1]);
          }
          // Fallback: search all text for review score pattern (e.g., "8.5" near "reviews")
          if (rating === null) {
            var cardText = card.innerText || '';
            var scoreMatch = cardText.match(/(\d+\.\d)\s*\/?\s*10/);
            if (!scoreMatch) scoreMatch = cardText.match(/\b([6-9]\.\d)\b/);
            if (scoreMatch) rating = parseFloat(scoreMatch[1]);
          }

          // Review count — try multiple selectors
          var reviewCount = 0;
          var reviewEl = card.querySelector('[data-selenium="review-count"]')
            || card.querySelector('[class*="review-count"], [class*="ReviewCount"]')
            || card.querySelector('[class*="ReviewSection"] span');
          if (reviewEl) {
            var revMatch = reviewEl.textContent.replace(/,/g, '').match(/(\d+)/);
            if (revMatch) reviewCount = parseInt(revMatch[1], 10);
          }
          // Fallback: look for "X reviews" in card text
          if (reviewCount === 0) {
            var revTextMatch = (card.innerText || '').replace(/,/g, '').match(/(\d+)\s*reviews?/i);
            if (revTextMatch) reviewCount = parseInt(revTextMatch[1], 10);
          }

          // Price — try multiple selectors
          var price = null;
          var priceEl = card.querySelector('[data-element-name="final-price"]')
            || card.querySelector('[data-selenium="display-price"]')
            || card.querySelector('[class*="Price__Value"], [class*="price-text"], [class*="display-price"]');
          if (priceEl) {
            var priceText = priceEl.textContent.replace(/,/g, '');
            var priceMatch = priceText.match(/(\d+\.?\d*)/);
            if (priceMatch) price = parseFloat(priceMatch[1]);
          }
          // Fallback: look for dollar amounts in card text
          if (price === null) {
            var priceTextMatch = (card.innerText || '').replace(/,/g, '').match(/(?:US\$|\$)\s*(\d+)/);
            if (priceTextMatch) price = parseFloat(priceTextMatch[1]);
          }

          // Skip listings with no price (no availability for selected dates)
          if (price === null) continue;

          // URL
          var linkEl = card.querySelector('a[href*="/hotel/"]')
            || card.querySelector('a[href*="agoda.com"]')
            || card.querySelector('a[href]');
          var url = linkEl ? linkEl.href : '';
          if (url && !url.startsWith('http')) url = 'https://www.agoda.com' + url;

          listings.push({
            name: name,
            platform: 'agoda',
            rating: rating,
            reviewCount: reviewCount,
            price: price,
            url: url,
            badges: {},
          });
        } catch (e) {
          // Skip card on error
        }
      }
      return listings;
    }

    waitForCards();
  });
}

// ─── Message handlers ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getSettings') {
    chrome.storage.local.get('settings').then(({ settings }) => {
      sendResponse(settings || DEFAULT_SETTINGS);
    });
    return true;
  }

  if (message.type === 'updateSettings') {
    chrome.storage.local.set({ settings: message.settings }).then(() => {
      sendResponse({ ok: true });
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged', settings: message.settings })
            .catch(() => {});
        }
      });
    });
    return true;
  }

  if (message.type === 'updateBadge') {
    const { score, tabId } = message;
    const id = tabId || sender.tab?.id;
    if (!id) return;

    if (score >= 75) {
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId: id });
    } else if (score >= 50) {
      chrome.action.setBadgeBackgroundColor({ color: '#6b7280', tabId: id });
    } else if (score >= 25) {
      chrome.action.setBadgeBackgroundColor({ color: '#ca8a04', tabId: id });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId: id });
    }
    chrome.action.setBadgeText({ text: String(score), tabId: id });
  }

  // ─── Cross-reference ────────────────────────────────────────────

  if (message.type === 'crossRef') {
    const { hotelName, city } = message;
    if (!hotelName) return;

    console.log('[StayProof] crossRef request: "' + hotelName + '" in ' + city);

    loadXrefCache().then(function () {
      const cacheKey = normalizeCacheKey(hotelName);
      const cached = xrefCache.get(cacheKey);
      if (cached && !cached.incomplete && (Date.now() - cached.ts < XREF_CONFIG.cacheTtlMs)) {
        console.log('[StayProof] Cache hit for "' + hotelName + '"');
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'xrefData',
          hotelName: hotelName,
          data: cached,
        }).catch(function () {});
        sendResponse({ queued: false, cached: true });
        return;
      }

      const reqId = 'xref_' + (++xrefIdCounter);
      console.log('[StayProof] Queued "' + hotelName + '" as ' + reqId);
      xrefPending.set(reqId, {
        hotelName: hotelName,
        city: city,
        bookingTabId: sender.tab.id,
      });
      xrefQueue.push(reqId);
      persistQueue();
      drainQueue();
      sendResponse({ queued: true, requestId: reqId });
    });
    return true;
  }

  // ─── Search page cross-reference (Phase 11) ────────────────────

  if (message.type === 'probeXrefCache') {
    loadXrefCache().then(function () {
      const now = Date.now();
      const hits = [];
      const listings = message.listings || [];
      for (let i = 0; i < listings.length; i++) {
        const item = listings[i];
        const cacheKey = normalizeCacheKey(item.hotelName);
        const cached = xrefCache.get(cacheKey);
        if (cached && !cached.incomplete && (now - cached.ts < XREF_CONFIG.cacheTtlMs)) {
          hits.push({ listingId: item.listingId, hotelName: item.hotelName, data: cached });
        }
      }
      sendResponse({ hits: hits });
    });
    return true;
  }

  if (message.type === 'searchXref') {
    var searchHotelName = message.hotelName;
    var searchCity = message.city;
    var searchListingId = message.listingId;
    if (!searchHotelName) return;

    console.log('[StayProof] searchXref request: "' + searchHotelName + '" in ' + searchCity);

    loadXrefCache().then(function () {
      var cacheKey = normalizeCacheKey(searchHotelName);
      var cached = xrefCache.get(cacheKey);
      if (cached && !cached.incomplete && (Date.now() - cached.ts < XREF_CONFIG.cacheTtlMs)) {
        console.log('[StayProof] Cache hit for search xref "' + searchHotelName + '"');
        chrome.runtime.sendMessage({
          type: 'searchXrefResult',
          listingId: searchListingId,
          hotelName: searchHotelName,
          data: cached,
        }).catch(function () {});
        sendResponse({ queued: false, cached: true });
        return;
      }

      var reqId = 'xref_' + (++xrefIdCounter);
      console.log('[StayProof] Queued search xref "' + searchHotelName + '" as ' + reqId);
      xrefPending.set(reqId, {
        hotelName: searchHotelName,
        city: searchCity,
        searchListingId: searchListingId,
      });
      xrefQueue.push(reqId);
      persistQueue();
      drainQueue();
      sendResponse({ queued: true, requestId: reqId });
    });
    return true;
  }

  if (message.type === 'amICrossRef') {
    const tabId = sender.tab?.id;
    const isCrossRef = tabId ? xrefActiveTabs.has(tabId) : false;
    sendResponse({ isCrossRef: isCrossRef });
    return true;
  }

  // ─── Search orchestration ──────────────────────────────────────────

  if (message.type === 'getTimingLog') {
    chrome.storage.local.get('timingLog', function(data) {
      sendResponse(data.timingLog || []);
    });
    return true;
  }

  if (message.type === 'startSearch') {
    var dest = message.destination;
    var checkin = message.checkin;
    var checkout = message.checkout;
    var maxPrice = message.maxPrice || null;

    searchState = { destination: dest, checkin: checkin, checkout: checkout, status: 'searching' };
    startKeepAlive();
    persistSearchState();
    var searchTimers = { booking: 0, airbnb: 0, agoda: 0 };

    var bookingUrl = buildBookingSearchUrl(dest, checkin, checkout, maxPrice);
    var airbnbOpts = {
      entireHomesOnly: !!message.entireHomesOnly,
      guestFavourite: !!message.guestFavourite,
      maxPrice: maxPrice,
    };

    var totalPlatforms = 3;
    var platformsDone = 0;
    var searchStartTime = Date.now();
    var platformElapsed = {};

    function onPlatformDone(platform) {
      if (platform && searchTimers[platform]) {
        var elapsed = Date.now() - searchTimers[platform];
        platformElapsed[platform] = elapsed;
        console.log('[StayProof] ' + platform + ' completed in ' + (elapsed / 1000).toFixed(1) + 's');
      }
      platformsDone++;
      if (platformsDone === totalPlatforms) {
        searchState.status = 'done';
        persistSearchState();
        stopKeepAlive();
        var totalMs = Date.now() - searchStartTime;
        console.log('[StayProof] Total search: ' + (totalMs / 1000).toFixed(1) + 's');

        // Persist timing log
        var entry = {
          ts: new Date().toISOString(),
          dest: dest,
          totalMs: totalMs,
          platforms: platformElapsed
        };
        chrome.storage.local.get('timingLog', function(data) {
          var log = data.timingLog || [];
          log.push(entry);
          if (log.length > 50) log = log.slice(-50);
          chrome.storage.local.set({ timingLog: log });
        });
      }
    }

    // Helper: open a platform tab, wait for load, scrape, report results
    function launchPlatform(url, platform) {
      searchTimers[platform] = Date.now();
      openSearchTab(url, function(tab) {
        if (!tab) {
          chrome.runtime.sendMessage({ type: 'searchError', platform: platform, error: 'Failed to open tab' });
          onPlatformDone(platform);
          return;
        }
        searchActiveTabs.set(tab.id, { platform: platform });
        chrome.runtime.sendMessage({ type: 'searchProgress', platform: platform, status: 'loading' });

        // Airbnb and Agoda use IntersectionObserver for lazy card rendering —
        // doesn't fire in minimized windows (0x0 viewport). Inject a patch
        // before site scripts run that makes IO immediately report elements
        // as visible so all cards populate.
        if (platform === 'airbnb' || platform === 'agoda') {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            injectImmediately: true,
            func: function() {
              window.IntersectionObserver = function(callback) {
                this._cb = callback;
              };
              window.IntersectionObserver.prototype.observe = function(el) {
                var self = this;
                try {
                  self._cb([{
                    target: el,
                    isIntersecting: true,
                    intersectionRatio: 1,
                    boundingClientRect: el.getBoundingClientRect(),
                    intersectionRect: el.getBoundingClientRect(),
                    rootBounds: null,
                    time: performance.now(),
                  }], self);
                } catch (e) { /* ignore */ }
              };
              window.IntersectionObserver.prototype.unobserve = function() {};
              window.IntersectionObserver.prototype.disconnect = function() {};
              window.IntersectionObserver.prototype.takeRecords = function() { return []; };
            },
          });
        }

        var waitForLoad = function() {
          chrome.tabs.get(tab.id, function(tabInfo) {
            if (chrome.runtime.lastError) {
              chrome.runtime.sendMessage({ type: 'searchError', platform: platform, error: 'Tab closed' });
              onPlatformDone(platform);
              return;
            }
            if (tabInfo.status === 'complete') {
              chrome.runtime.sendMessage({ type: 'searchProgress', platform: platform, status: 'scraping' });
              scrapeSearchTab(tab.id, platform, function(listings) {
                chrome.runtime.sendMessage({ type: 'searchResults', platform: platform, listings: listings || [] });
                chrome.runtime.sendMessage({ type: 'searchProgress', platform: platform, status: 'done', count: (listings || []).length });
                closeSearchTab(tab.id);
                onPlatformDone(platform);
              });
            } else {
              setTimeout(waitForLoad, 500);
            }
          });
        };
        waitForLoad();
      });
    }

    // Booking — open hidden tab, wait for load, scrape
    searchTimers.booking = Date.now();
    openSearchTab(bookingUrl, function(bookingTab) {
      if (!bookingTab) {
        chrome.runtime.sendMessage({ type: 'searchError', platform: 'booking', error: 'Failed to open tab' });
        onPlatformDone('booking');
      } else {
        searchActiveTabs.set(bookingTab.id, { platform: 'booking' });
        chrome.runtime.sendMessage({ type: 'searchProgress', platform: 'booking', status: 'loading' });

        var waitForBookingLoad = function() {
          chrome.tabs.get(bookingTab.id, function(tabInfo) {
            if (chrome.runtime.lastError) {
              chrome.runtime.sendMessage({ type: 'searchError', platform: 'booking', error: 'Tab closed' });
              onPlatformDone('booking');
              return;
            }
            if (tabInfo.status === 'complete') {
              chrome.runtime.sendMessage({ type: 'searchProgress', platform: 'booking', status: 'scraping' });
              scrapeSearchTab(bookingTab.id, 'booking', function(listings) {
                chrome.runtime.sendMessage({ type: 'searchResults', platform: 'booking', listings: listings || [] });
                chrome.runtime.sendMessage({ type: 'searchProgress', platform: 'booking', status: 'done', count: (listings || []).length });
                closeSearchTab(bookingTab.id);
                onPlatformDone('booking');
              });
            } else {
              setTimeout(waitForBookingLoad, 500);
            }
          });
        };
        waitForBookingLoad();
      }

      // Airbnb — resolve place_id first, then launch
      resolveAirbnbPlace(dest).then(function(place) {
        if (place && place.placeId) {
          airbnbOpts.placeId = place.placeId;
        }
        var airbnbDest = (place && place.query) ? place.query : dest;
        var airbnbUrl = buildAirbnbSearchUrl(airbnbDest, checkin, checkout, airbnbOpts);
        launchPlatform(airbnbUrl, 'airbnb');
      });

      // Agoda — resolve city ID first, then launch
      resolveAgodaCityId(dest).then(function(result) {
        if (!result) {
          chrome.runtime.sendMessage({ type: 'searchError', platform: 'agoda', error: 'Could not resolve city' });
          onPlatformDone('agoda');
          return;
        }
        var agodaUrl = buildAgodaSearchUrl(result.cityId, result.areaId, result.name, checkin, checkout, maxPrice);
        launchPlatform(agodaUrl, 'agoda');
      });
    });

    sendResponse({ started: true });
    return true;
  }

});

// ─── Extension icon click → open search page ────────────────────────

chrome.action.onClicked.addListener(function(tab) {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/search/search.html') });
});

// ─── Coordinate extraction (regex only, no JSON.parse) ──────────────

/**
 * Extract lat/lng coordinates from Booking.com inline script text and
 * match them to listings by URL slug.
 * @param {Array} listings - Listing objects with url field
 * @param {Array} scriptTexts - Array of script tag textContent strings
 * @returns {Array} Same listings array with lat/lng set (null if not found)
 */
function _extractBookingCoordinates(listings, scriptTexts) {
  var _now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  var t0 = _now();
  var timeBudget = 200;

  // Initialize all listings with null coords
  var slugMap = {};
  for (var i = 0; i < listings.length; i++) {
    listings[i].lat = null;
    listings[i].lng = null;
    if (listings[i].url) {
      var m = listings[i].url.match(/\/hotel\/[^/]+\/([^/.]+)/);
      if (m) slugMap[m[1]] = i;
    }
  }

  for (var s = 0; s < scriptTexts.length; s++) {
    if (_now() - t0 > timeBudget) break;

    var text = scriptTexts[s];
    if (!text || text.length < 100) continue;
    if (text.indexOf('"latitude"') === -1) continue;

    var re = /"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)\s*}\s*,\s*"pageName"\s*:\s*"([^"]+)"/g;
    var match;
    while ((match = re.exec(text)) !== null) {
      if (_now() - t0 > timeBudget) break;
      var lat = parseFloat(match[1]);
      var lng = parseFloat(match[2]);
      var slug = match[3];
      if (isNaN(lat) || isNaN(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      if (lat === 0 && lng === 0) continue;
      if (slug in slugMap) {
        listings[slugMap[slug]].lat = lat;
        listings[slugMap[slug]].lng = lng;
      }
    }
  }

  return listings;
}

/**
 * Extract lat/lng coordinates from Airbnb inline script text and
 * match them to listings by room ID.
 * @param {Array} listings - Listing objects with url field
 * @param {Array} scriptTexts - Array of script tag textContent strings
 * @returns {Array} Same listings array with lat/lng set (null if not found)
 */
function _extractAirbnbCoordinates(listings, scriptTexts) {
  var _now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  var t0 = _now();
  var timeBudget = 200;

  // Initialize all listings with null coords
  var idMap = {};
  for (var i = 0; i < listings.length; i++) {
    listings[i].lat = null;
    listings[i].lng = null;
    if (listings[i].url) {
      var m = listings[i].url.match(/\/rooms\/(\d+)/);
      if (m) idMap[m[1]] = i;
    }
  }

  for (var s = 0; s < scriptTexts.length; s++) {
    if (_now() - t0 > timeBudget) break;

    var text = scriptTexts[s];
    if (!text || text.length < 100) continue;
    if (text.indexOf('"latitude"') === -1) continue;

    // Forward scan: find each DemandStayListing ID, then find its coordinate ahead
    var idRe = /"id"\s*:\s*"([^"]+)"/g;
    var idMatch;
    while ((idMatch = idRe.exec(text)) !== null) {
      if (_now() - t0 > timeBudget) break;
      var rawId = idMatch[1];
      var numericId = null;
      if (/^\d+$/.test(rawId)) {
        numericId = rawId;
      } else {
        try {
          var decoded = typeof atob === 'function' ? atob(rawId) : Buffer.from(rawId, 'base64').toString();
          var colonIdx = decoded.lastIndexOf(':');
          if (colonIdx !== -1) {
            var numPart = decoded.substring(colonIdx + 1);
            if (/^\d+$/.test(numPart)) numericId = numPart;
          }
        } catch (e) { /* not base64 — skip */ }
      }
      if (!numericId || !(numericId in idMap)) continue;

      // Scan forward up to 5000 chars for the next coordinate
      var lookahead = text.substring(idMatch.index, Math.min(text.length, idMatch.index + 5000));
      var coordMatch = lookahead.match(/"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)/);
      if (!coordMatch) continue;

      var lat = parseFloat(coordMatch[1]);
      var lng = parseFloat(coordMatch[2]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      if (lat === 0 && lng === 0) continue;

      listings[idMap[numericId]].lat = lat;
      listings[idMap[numericId]].lng = lng;
    }
  }

  return listings;
}

// ─── Node.js exports (for testing) ───────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildBookingSearchUrl, buildAirbnbSearchUrl, buildAgodaSearchUrl,
    resolveAirbnbPlace, pickAgodaSuggestResult,
    scrapeBookingSearch, _extractBookingCard,
    scrapeAirbnbSearch, _extractAirbnbCard, scrapeAgodaSearch, scrapeSearchTab,
    _extractBookingCoordinates, _extractAirbnbCoordinates,
    XREF_CONFIG,
  };
}
