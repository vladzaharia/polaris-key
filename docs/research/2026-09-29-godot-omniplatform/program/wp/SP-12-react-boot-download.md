# SP-12 React boot and download surface: one-call `boot()` (`ui.boot`), bearer-mode `release.fetch` and the `distribution` model, `update.feedUrl()` on the desktop bridge, `crashTags()`

| Field       | Value                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                                                                                           |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                |
| Depends on  | none                                                                                                                                                                                |
| Unblocks    | [SP-15](SP-15-react-local-update-lifecycle.md)                                                                                                                                      |
| Role        | `pkey-sdk-porter`                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                  |
| Gates       | transcript replay (`boot-cold-register.json`, `release-fetch-gated.json`, `distribution-download-model.json`) and `feed-url-matrix.json`; `parity:check`; the generated parity page |
| Human input | none                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                           |

## Goal

`@polaris-key/react` boots in one call and serves the release and download surface the other SDKs already have: `boot()` drives discovery, keyless registration, trust, documents and report to a stage outcome; `release.fetch` downloads a licensed build in bearer mode with Range resume and size and SHA-256 checks; `distribution` exposes `GET /<p>/distribution/download.json`; `update.feedUrl(kind)` answers on the desktop bridge; `crashTags()` returns the Sentry tags.

## Why

Five React rows are `planned` and unowned after the parity follow-ups: client-core's stage functions are re-exported (`ui.stages`) but nothing composes them, the release client only builds URLs, and React never reads the download model. Node implements all five (`packages/sdk-node/parity.json`), so the behaviour and the transcripts already exist. The parity rows it owns: `ui.boot`, `release.fetch`, `release.distribution`, `update.feeds`, `crash.tags` in `packages/sdk-react/parity.json`; their `note` fields give the current state. It absorbs the parity note's SP-R06, SP-R09 and the feed-URL half of SP-R08 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.4 (`ui.boot`), §3.6 (`release.fetch`), §3.7 (`update.feeds`), §3.8 (`release.distribution`), §3.14 (`crash.tags`) and §5.2.
- Node's implementations as the reference: `client.boot()`, `client.release.fetch()`, `client.update.feedUrl()`, `client.crashTags()` in `packages/sdk-node/src/`.
- `packages/sdk-react/src/browser/bearer/` (the bearer engine) and `packages/sdk-react/src/desktop/desktopAdapter.ts` (the bridge verbs).
- `conformance/transcripts/boot-cold-register.json`, `release-fetch-gated.json`, `distribution-download-model.json`; `conformance/corpus/v2/feed-url-matrix.json`, `stage-matrix.json`.

## Scope

**In:**

- `boot()` (and a `useBoot` hook) over client-core's stage machine, on both runtimes; on `desktop-bridge` it forwards to the host's `client.boot()`.
- `release.fetch(target, {signal, onProgress})` in bearer mode: device bearer, Range/If-Range resume, size and SHA-256 verified; the 401 body code mapped. On `desktop-bridge` it forwards to the host.
- `distribution` (the download model from `download.json`) on both runtimes. The Worker's CORS list already covers the route.
- `update.feedUrl(kind)` on `desktop-bridge` (forwarded to the host); `web` takes the registry's `runtime` N/A as an `except`.
- `crashTags()` / `crashTagsFor()` over the same vectors as Node (`packages/worker/src/services/distribution/sentry.ts`).
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Device-local overrides (→ SP-13).
- Update-health recording (→ SP-14).
- The update hand-off and the boot guard (→ SP-15).
- A `<PolarisBoot>` component (the UI-kit program, UK-\*).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- No wire change: every route and transcript exists. React must replay the same transcripts Node does; do not record new ones.
- SSR safety holds: no network in a constructor or render (SP-R13 in the note).
- Bridge v3 hosts that lack a verb answer the typed `unsupported`; do not fall back to direct network from the renderer.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [x] `@pkey-feature ui.boot` tests replay `boot-cold-register.json` and the `stage-matrix.json` outcomes.
- [x] `@pkey-feature release.fetch` tests replay all three steps of `release-fetch-gated.json` (200, 206 resume, 401 `download_auth_required`).
- [x] `@pkey-feature release.distribution` tests replay `distribution-download-model.json`.
- [x] `@pkey-feature update.feeds` tests run every `feed-url-matrix.json` row through the desktop-bridge path; the manifest declares the `web` `runtime` except.
- [x] `@pkey-feature crash.tags` unit tests cover the Sentry vectors.
- [x] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [x] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [x] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- SP-15's update driver and boot guard build on `boot()` and `release.fetch`.

The role agent sets `--set SP-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-12 done`.
