// Google Maps entry point — stub: cross-ref tab detection only.
// Overlay rendering, scraper.js, and selectors.js removed (Phases 14, 20).
// The service worker uses an inlined scrapeGoogleMapsForXref function via executeScript().

(function () {
  chrome.runtime.sendMessage({ type: 'amICrossRef' }, function (response) {
    if (response && response.isCrossRef) {
      console.log('[StayProof] Cross-ref tab detected');
    }
    // Normal Google Maps tab: no overlay (search page is the product now)
  });
})();
