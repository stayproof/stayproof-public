# StayProof

**The audit-ready mirror of the StayProof Chrome extension.**

This repository lets anyone verify the privacy promises on the Chrome Web
Store listing by reading the exact code that runs in your browser. No
servers, no analytics, no tracking — the only network calls the extension
makes are to Booking, Airbnb, Agoda, and Google Maps. Every one of those
calls is visible below in the scraper source.

This is a **read-only mirror**, rebuilt from private sources on each
release. For the install-and-use experience, get the extension on the
Chrome Web Store: **https://stayproof.co**.

---

## What's in this repository

- **Scrapers** — `src/background/service-worker.js` (Booking.com, Airbnb,
  Agoda) and `src/content/google-maps/inject.js`. Every external HTTP
  call the extension makes, and every DOM node it reads, is in these
  files.
- **UI** — `src/search/` (search.html, search.js, search.css). Rendering, sort, filter.
- **URL builders** — part of `src/background/service-worker.js`.
  Construction of search URLs for each platform.
- **Name matching** — `src/shared/name-matching.js`. The Soft TF-IDF
  fuzzy name-matching module used to deduplicate the same property
  across Booking/Airbnb/Agoda. Published in full.
- **Cross-reference candidate selection** — `src/shared/xref-candidates.js`.
  The logic that decides when the extension queries Google Maps.
- **Manifest** — `manifest.json`. The canonical permissions declaration;
  audit this file to see exactly which sites the extension can touch.
- **Privacy policy** — `privacy.html`.
- **Tests** — a subset of the test suite that exercises scrapers, URL
  builders, UI behavior, and name matching. All runnable with
  `node --test tests/*.test.js`.

## What is intentionally NOT in this repository

- **The scoring algorithm** (`src/shared/scoring.js`) ships as a
  non-functional stub here. The real implementation — Bayesian trust
  model, review-distribution anomaly detection, rating-blending
  math — is private.
- **Calibrated thresholds** (`src/shared/scoring-config.js`) are
  omitted entirely.
- **Scoring tests and ranked fixtures** — anything that encodes the
  calibrated output values.
- **Internal planning documents** (`.planning/`).

This split exists because the scoring algorithm is the project's
commercial moat, while the scrapers are the falsifiable part of the
privacy claim. Everything a third party needs to verify "no data leaves
your browser except to Booking/Airbnb/Agoda/Google" is in this repo.
Everything proprietary is in the private repo and the compiled
Chrome Web Store bundle.

## Installing from source

> Heads-up: a source-load from this mirror uses the **stubbed** scoring
> algorithm. Trust ratings will be null; sort order and platform
> deduplication will still work (those don't depend on the private
> scoring). **For the full StayProof experience, install from the
> Chrome Web Store.**

1. `git clone https://github.com/stayproof/stayproof-public.git`
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the cloned directory
5. The StayProof icon should appear in your toolbar

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: PRs against scrapers /
UI / URL builders / name-matching are welcome and get cherry-picked into
the private repo with attribution preserved. PRs that modify the
stubbed scoring algorithm can't be merged (the math lives privately);
open an issue in
[stayproof/stayproof-feedback](https://github.com/stayproof/stayproof-feedback)
instead.

## Reporting bugs and requesting features

- **Bugs and feature requests:** please open an issue in
  [stayproof/stayproof-feedback](https://github.com/stayproof/stayproof-feedback).
- **Security issues:** email `security@stayproof.co` (do NOT open a
  public issue).

## License

MIT — see [LICENSE](LICENSE).

## Links

- **Website:** https://stayproof.co
- **Privacy policy:** [privacy.html](privacy.html)
- **Chrome Web Store:** https://stayproof.co (listing link)
- **Feedback:** https://github.com/stayproof/stayproof-feedback
