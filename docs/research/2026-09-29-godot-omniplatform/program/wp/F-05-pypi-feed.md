# F-05 PyPI feed: PEP 691 JSON, PEP 658/714 metadata, PEP 592 yank and the inert HTML fallback

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1–1.5 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The PyPI feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/pypi/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). The inert HTML fallback is served only when `Accept` lacks the JSON type. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

pip and uv refuse plain `application/json`; the exact PEP 691 type is required. pip before 22.2 needs HTML, which is the host's single HTML answer.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the PyPI row and its notes).
- The Simple Repository API, PEPs 691, 658, 714 and 592, pip's `collector.py`, and uv's `registry_client.rs` ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the PyPI extractor.

## Scope

**In:**

- `simple/` and `simple/<normalised>/` in JSON (API 1.1) and HTML; 301 normalisation and trailing-slash redirects; files under `files/<sha256>/<filename>`; `<file>.metadata` (PEP 658); `yanked` with a reason (PEP 592).
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- The HTML page escapes every value, has no script, form or style, and passes `inertDocumentPolicy`. The `htmlFallback` setting off answers 406.
- Names are compared after PEP 503 normalisation. Fragment hashes are for corruption only.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [x] Matrix green: pip current and 22.2, uv with `explicit = true`, Poetry 2.
- [x] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [x] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [x] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/pypi routeCoverage
gh workflow run registry-clients.yml -f ecosystem=pypi
```

## Corrections from the code (recorded during implementation)

- **pip 22.2 is not "the HTML path".** pip 22.2 is the first pip with PEP 691 and, like uv and
  Poetry 2, lists the JSON type first, so it gets JSON. pip before 22.2 asks only for `text/html`,
  which the host never serves (the HTML page goes out as `application/vnd.pypi.simple.v1+html`),
  so those pips are unsupported. The matrix runs pip 22.2 (on Python 3.11, which it supports)
  through install, yank and hash checks over JSON, and exercises the HTML page with pip 22.2's own
  link parser (`parse_links`): every file, its hash, the yank reason and `Requires-Python`.
- **Negotiation.** JSON whenever `Accept` lists `…simple.v1+json` or `…simple.latest+json` with a
  non-zero q; otherwise HTML. With `htmlFallback` off, a client that admits JSON only through a
  wildcard (or sends no `Accept`) still gets JSON, and only a client that cannot take JSON gets 406.
- **Deprecate and channels have no PyPI form.** A deprecated version is listed as live (PEP 592
  has only yank; PEP 792 markers are per project), and the page maps no channel tag: pre-releases
  are chosen by PEP 440 version. `RegistryPackage.tags` is `{}` for PyPI, so the read path never
  pays for `packageChannelHeads`.
- **The project list is computed on read**, not rendered into R2: `render(pkg)` sees one package,
  and the list spans the owner. It goes through `serveFeedRead` (list decision) and the Cache API,
  and omits a project whose own delivery access is stricter than the feed's.
- **The render-on-write drain is not wired** (F-02's corrections give it to F-03, F-03's give it
  to F-02). So the project-page read compares the stored render record's stamp with the state it
  just read from `releaseCatalog` and re-renders a stale or missing page (answered from memory,
  written back via `waitUntil`). A yank therefore shows up at the next Cache API miss (≤ 60 s)
  without the drain; once the drain lands this is a one-`head` safety net. Proposed follow-up below.
- **Relative file URLs** (`../../files/<sha256>/<filename>`), so a stored page never bakes in the
  host. The PEP 714 `core-metadata` key only; the old `dist-info-metadata` is not sent.
- **Unknown names never become an oracle**: a path naming no project or file runs the feed-level
  check (`deliverableId: null`) before the not-found, so a non-public feed answers 401 for known
  and unknown names alike, and a feed that is off answers 404 for both, redirects included.
- **Files** are found by filename prefix among the owner's PyPI deliverables (longest name first)
  and served only when name and hash match a listed file and the owner holds the blob ref; served
  by Core's `blobResponse` (`application/octet-stream`, `attachment`, `Repr-Digest`, ranges). Its
  immutable `Cache-Control` adds `no-transform` to §6.7's value.
- **The harness owner could not load.** `seed.mjs` inserted no active `product_keys` row, so
  `loadProductPublic` returned null and every feed route answered the not-found (F-02's curl smoke
  only probed not-founds). Fixed in `seed.mjs`. The PyPI fixture is seeded as the rows
  `pkey release publish` writes, plus checksummed R2 objects through wrangler's platform proxy,
  because a local Worker cannot mint upload tickets; the real ingest path is covered by
  `test/registry/pypi.test.ts`, which publishes through the submit route. `run.mjs` gained
  per-client fixtures (`clients/<name>.seed.mjs`).
- **Miniflare and 304s.** Under `wrangler dev`, Miniflare's compression emulation adds
  `Content-Encoding: gzip` to any answer without a `Content-Type` when the client accepts gzip, a
  body-less 304 included; Poetry's HTTP cache then fails to decode its stored body. The Poetry
  client uses a fresh cache per command. Whether the production edge does the same is unverified.
- **Tests** live in `test/registry/pypi.test.ts` (the Verify filter `registry/pypi` matches it) with
  goldens under `test/fixtures/registry/pypi/` (`UPDATE_PYPI_GOLDENS=1`, prettier-ignored). F-02's
  "no routes yet" assertions in `registryFeeds.test.ts` and `registryHost.test.ts` now check that
  every route belongs to a renderer of its own ecosystem.

## Hand-off

- F-10 publishes our PyPI packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-05 done`.
