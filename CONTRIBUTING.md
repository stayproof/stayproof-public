# Contributing to StayProof (public mirror)

This repository is a **read-only mirror**, rebuilt from private sources
on each release of the StayProof Chrome extension. It ships so that
third parties can audit the scraper and UI code against StayProof's
"no servers, no tracking" privacy claim.

## What we accept

**PRs are welcome** on the publicly-listed files:

- `src/background/service-worker.js` — scrapers, URL builders, tab
  management, cross-reference queue
- `src/search/` — search UI, rendering, sort/filter
- `src/content/` — content scripts
- `src/shared/name-matching.js` — Soft TF-IDF name matching
- `src/shared/xref-candidates.js` — Google Maps cross-reference candidate
  selection
- Public tests in `tests/` (scraper, URL builders, name matching, UI)
- `manifest.json`, `privacy.html`

### How accepted PRs flow back

1. You open a PR against `main`
2. A maintainer reviews on GitHub
3. If accepted: the patch is cherry-picked into the private repo via
   `git cherry-pick` (or `git am`) with `--author="You <your@email>"`
   so attribution is preserved
4. The next `publish-public.sh` run brings the applied commit into this
   mirror
5. GitHub detects the applied commit and auto-closes the PR

This means your PR may sit open until the next release; the merge
happens indirectly (the mirror is force-pushed fresh each release, so
we can't use the normal "merge" button).

## What we can't accept

**Scoring, algorithm, or threshold PRs** cannot be merged here. The
math lives in the private repo; the file you see at
`src/shared/scoring.js` in this mirror is a non-functional stub. If
you have an algorithm suggestion,
[open an issue](https://github.com/stayproof/stayproof-public/issues)
describing the intuition and the expected behavior change. We read
every issue.

## Reporting bugs

[Open an issue](https://github.com/stayproof/stayproof-public/issues)
on this repository for any of the following:

- Extension bugs, feature requests, or UX feedback
- Code-level bugs in the files published here (e.g., "the Booking
  scraper regex misses prices with non-breaking spaces")
- Algorithm or scoring suggestions (see note above — these become
  feedback for the private implementation)

## Reporting security issues

**Do not open a public issue for security problems.** Email
`security@stayproof.co`. PGP key on request.

Examples of what to report privately:

- Ways the extension could be tricked into leaking data beyond its
  stated scope (Booking/Airbnb/Agoda/Google Maps)
- CSP, permission, or sandboxing weaknesses
- Supply-chain concerns in vendored dependencies

## Development

```
git clone https://github.com/stayproof/stayproof-public.git
cd stayproof-public
node --test tests/*.test.js      # run the public test suite
```

Note: tests that depend on the real scoring algorithm live in the
private repo and are excluded from this mirror. The tests that ship
here exercise scrapers, URL builders, name matching, and UI.

## Code style

See `CLAUDE.md` in the source tree (carried into this mirror) for the
conventions: `var` in content-script files for broad compatibility,
`const`/`let` allowed in the service worker, behavioral tests via
`node:test` (no external runner).
