# policy-recheck

The S-07 checklist as a program. Each of the 18 dated policy, fee, deadline and API facts in the
research is a row in `checks.mjs`, with the primary pages that state it and the exact wording that
must still be there. `recheck.mjs` fetches the pages, extracts text, and reports which quotes
survived. The results, with every quote and its URL, are in
[notes/S-07.md](../../notes/S-07.md).

## Run

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/policy-recheck
mise exec node@22 -- node --test lib.test.mjs          # offline tests of the helpers
mise exec node@22 -- node recheck.mjs                  # all rows
mise exec node@22 -- node recheck.mjs --rows 4,6,16    # only some rows
mise exec node@22 -- node recheck.mjs --rows 1-5,12,14 # ranges work; the table below pastes as is
mise exec node@22 -- node recheck.mjs --json           # machine-readable
```

Node 22 or later (global `fetch`), no dependencies, no credentials, read-only. Exit code 0: every
quote is still present. Exit code 1: at least one row needs a human to re-read the page and
decide whether the fact changed, moved or was reworded. Exit code 2: bad usage (a `--rows` item
that does not parse, or a row number not in `checks.mjs`); nothing was checked, so it is never a
pass.

**What a PASS proves.** Only that the quoted text is still present on the page. Text that was
_added_ is invisible to a quote check: the one change this spike found (row 8, the 2026-09-17
extension of the US external-content-links reporting date) was an addition. Added text is caught
only where a source carries a changelog guard, an `expect` that fails when the page gains a dated
entry newer than the last one read: row 8 `us-update` (after 2026-09-17), row 9 (Billing Library
releases newer than 9.1.x), row 12 (Flathub `requirements.md` commits after 2026-09-21) and the row
16 (App Store Connect API versions newer than 4.5). A row without a guard can pass while the page grows a new
paragraph, so treat PASS as "the facts this note cites have not been removed or reworded", not as
"nothing changed".

Outputs go to `out/` (git-ignored): `results.json` (status, bytes, page date, text hash and
failures per source) and one text snapshot per source, which is what to diff against when a row
fails.

## Which rows to re-run

| Package        | Rows         |
| -------------- | ------------ |
| D-01           | 1, 2, 7, 10  |
| P2b-03, P2b-05 | 1-5, 12, 14  |
| P5-02          | 4, 6, 16     |
| P5-03          | 8, 9, 17     |
| P5-04          | 11, 18       |
| P6-01          | 8, 9, 15     |
| P4-03, P4-08   | 6, 7, 11, 13 |

Re-run at the start of the package if more than a month has passed since 2026-09-30.

## Adding or changing a check

A source in `checks.mjs` has a `url`, a `kind` (`html`, `md`, `docc` for Apple's
`tutorials/data/documentation/...` JSON, or `json`), optional `quotes`, `regexes` and an `expect`
function for structural tests, and an optional `date` regex that captures the page's own date. Quote
whole sentences from the primary page; whitespace, smart quotes and dashes are normalised before
matching. A failing quote means "read the page", not "the fact is false".

## Known traps

- Google's sites choose a language from the client IP when no `Accept-Language` header is sent; the
  harness sends `en-US`. From a browser add `?hl=en`.
- `developer.apple.com/support/dma-and-apps-in-the-european-union/` now answers HTTP 200 with a
  "Page Not Found" title. It is kept as a canary source on row 4; the live pages are
  `support/apps-in-the-eu/` and the EU marketplace and web-distribution pages.
- Several policy pages print no date. The harness records the page date only where one exists. It
  also stores a text hash per source in `out/results.json`, but `out/` is git-ignored and no
  baseline is committed or compared, so the hash is only a hint for a manual diff; it does not
  detect changes on its own.
- The harness reads Flathub's documentation and never opens, comments on or automates anything on
  Flathub (its generative-AI policy forbids agent-driven pull requests).
