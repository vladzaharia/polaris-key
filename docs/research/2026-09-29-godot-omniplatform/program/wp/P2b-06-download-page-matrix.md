# P2b-06 Public download page v1 and the console distribution matrix v1

| Field       | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                 |
| Size        | 1 engineer-weeks                                                                                                                                                       |
| Depends on  | [P2b-03](P2b-03-availability-keys.md), [P2b-04](P2b-04-rollouts-delivery.md)                                                                                           |
| Unblocks    | none                                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                     |
| Gates       | rule 10 (page routes and the bytes-host alias); admin tests and `pnpm --filter @polaris-key/admin build`; `docsLinks` drift gate; threat model (a public HTML surface) |
| Human input | none for the work; seeing it in production needs the bytes domain from [P2-01](P2-01-blob-store.md)                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                              |

Milestone: **Diceroll's AltStore source, F-Droid repo and download page come from Polaris Key.**

## Goal

Each product with distribution enabled has a public, cookie-free download page on the separate
bytes domain: it detects the visitor's platform, offers one primary action, lists every other way
to get the product (store links, AltStore/SideStore, Obtainium, F-Droid, Scoop, web) with deep
links and QR codes, and shows versions, sizes, SHA-256s, signer fingerprints and minimum OS
versions. The console's Distribution section gains a **matrix** of releases × outlets showing
availability, submission and rollout per cell, with pause, resume, halt and complete controls.

## Why

`/<product>` alone 404s today, and the portal's Downloads view needs a sign-in and a licence even
for public artifacts ([notes/A3 §3](../../notes/A3-admin-dx.md#32-what-an-omni-platform-download-page-needs),
[README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #22). The
research specifies a separate public page on the bytes domain ([§6.3](../../README.md#63-player-end-user),
[§3.5](../../README.md#35-storage-and-byte-delivery) "Separate domain") and puts the distribution
matrix first among new console surfaces ([§6.2](../../README.md#62-administrator-operator) item 1).

## Read first

- `AGENTS.md` (rules 5, 10, 11; the docs conventions for console help links), `CLAUDE.md`.
- [README §6.3](../../README.md#63-player-end-user), [§6.2](../../README.md#62-administrator-operator)
  items 1 and 3, [§6.1](../../README.md#61-developer-adopter) ("the console shows the release ×
  outlet matrix filling in"), [§3.9](../../README.md#39-rollouts-halts-and-telemetry).
- [notes/A3 §3.2 and §7.2](../../notes/A3-admin-dx.md#72-web-builds-and-cors) (platform detection,
  store badge URLs, deep links, why never on the console origin);
  [notes/E1 §B5](../../notes/E1-apple.md#b5-deep-links); [notes/E2 §B3, §C2](../../notes/E2-android.md#b3-obtainium).
- Hand-offs: [P2b-03](P2b-03-availability-keys.md) (availability, submissions, keys),
  [P2b-04](P2b-04-rollouts-delivery.md) (rollout controls, `deliveryUrl`),
  [P2b-05](P2b-05-storefront-feeds.md) (feed URLs, if landed; it is not a dependency),
  [P2-01](P2-01-blob-store.md) (the bytes-host allowlist), [P2-07](P2-07-console-builds.md)
  (builds and SHA-256 components).
- Code: `packages/worker/src/router.ts:133-136` (the product-path regex), `src/securityHeaders.ts:121`
  (`secureResponse`: a script-free CSP for any HTML without its own policy),
  `src/services/release/install.ts` (safe string rendering); `packages/admin/src/route.ts`
  (the Distribution section P2b-01 added), `src/lib/docsLinks.ts`, `src/views/`.

## Scope

**In:**

- **Page routes** (rule 10), served **only** on the bytes host (P2-01's allowlist):
  `GET /{product}/distribution/download` (HTML) and `GET /{product}/distribution/download.json`
  (the model the page renders), plus the alias `/{product}` → the page on the bytes host
  (`ALIAS_PATHS`). On the console host both are the not-found body.
- **Page content:** platform detection with User-Agent Client Hints and a UA fallback (iPadOS
  reports `MacIntel`; use `maxTouchPoints > 1`); a primary action for the detected platform;
  store links from outlet identities (App Store `https://apps.apple.com/app/id<appleId>`, Google
  Play `…/store/apps/details?id=<packageName>`, Microsoft Store `https://apps.microsoft.com/detail/<productId>`,
  Steam, itch); "Other ways to get it": AltStore and SideStore add-source links and QR codes,
  the Obtainium add-link (with the `apps.obtainium.imranr.dev/redirect` fallback), the F-Droid
  repo link, QR and fingerprint, the Scoop command, AppImage/Flatpak/Snap and web links when those
  outlets exist; per build: version, size, SHA-256, minimum OS; signer fingerprints from the key
  inventory; the release's summary.
- QR codes as inline SVG generated server-side (a small, reviewed dependency or a vendored
  encoder; deterministic output).
- **Console matrix:** admin endpoint `GET …/distribution/matrix?deliverable=app&limit=20`
  (narrative-only) composing release rows (through `releaseCatalog`) × declared outlets with
  availability, submission and rollout per cell; a "Matrix" tab in the Distribution section with
  per-cell pause, resume, halt and complete (P2b-04's admin routes), confirmation dialogs, and the
  P2-07 artifact/SHA-256 components for the row header.
- Docs: `users/downloads.md` (the page, adding a source, Obtainium, F-Droid), and
  `admin/distribution-matrix.md`, linked from the tab through `route.ts`/`docsLinks.ts`.

**Out** (and where it belongs instead):

- Links shown only to entitled accounts (TestFlight, Play testing, beta repos): they need a
  sign-in on the bytes host, which is cookie-free by design (README §6.3; no owner, see the report).
- Official store badge artwork (brand rules; text links in v1). Beta channels on the page.
- The portal's own Downloads problems (README §9.1 #22) and a "Play now" hosted web build
  (→ [P6-04](P6-04-hosted-web.md)).
- Packs in the matrix and readiness holds (→ P4-14); store-mirrored states (→ P5-02 to P5-04).

## Design notes

- **Never on the console origin.** The page is the first HTML a stranger can load that shows
  repo-authored text; serving it next to `/manage` would be script execution against the control
  plane's origin (notes/A3 §7.2). The bytes host sets and reads no cookies.
- **Escape everything.** Listing fields come from `.pkey/distribution`, which any repo writer can
  push. Render with an escaping template (as `install.ts` refuses unsafe values) and test a listing
  containing `<script>`, quotes and `javascript:` URLs; URLs must be `https:` or a known deep-link
  scheme built by the Worker, never taken verbatim.
- **CSP.** Set the page's own policy: `default-src 'none'`, inline style and the one detection
  script by hash, `img-src 'self' data:`; no third-party requests. `secureResponse` otherwise
  forces a script-free policy on HTML.
- **Only public, live, unyanked releases**, chosen with the same rules as P2b-05's feeds (live on
  the outlet, not held by a paused or halted rollout); a non-public deliverable has no page.
- **Deep links** are built by the Worker from feed URLs (E1 §B5, E2 §B3, §C2); if P2b-05 has not
  landed, omit those rows rather than linking to routes that do not exist.
- **Matrix honesty.** A halt is shown with the P2b-04 caveat (it reaches devices with the signed
  feed, P3-03); mirrored store rollouts show their source and disable direct controls.
- The page model (`download.json`) is the single source for the HTML, so tests assert the model and
  a smaller set of HTML properties.

## Steps

1. Page model builder over the hooks, with tests (platform grouping, outlet links, fingerprints).
2. HTML renderer, QR SVG, detection script with CSP hash; escaping tests; bytes-host-only routing.
3. Routes, alias, OpenAPI entries, `routeCoverage`, `docs gen`.
4. Matrix endpoint and the console tab with controls; admin tests.
5. Docs pages and help links.

## Acceptance criteria

- [ ] On the bytes host `GET /{product}/distribution/download` returns HTML with its own CSP, no
      `Set-Cookie`, and one primary action per platform fixture; on the console host it is
      not-found; `/{product}` on the bytes host serves the same page.
- [ ] A listing with `<script>`, quotes and a `javascript:` URL renders inert (test).
- [ ] The model lists SHA-256, size and minimum OS per build and the key inventory's
      fingerprints; a yanked, non-live or halted release is absent.
- [ ] The matrix shows availability, submission and rollout per (release, outlet) and each
      control calls the right P2b-04 route; mirrored rows have controls disabled.
- [ ] `routeCoverage`, the docs-link drift test and `pnpm --filter @polaris-key/admin build` pass.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- downloadPage routeCoverage docsLinks
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- distribution
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `download.json` is reusable by SDK "get it here" prompts and by P6-04's "Play now" link.
- The matrix endpoint and tab are what P4-14 (readiness, pack rows) and P5-02 to P5-04 (store
  states) extend; §6.2 item 3 (outlets and credentials) builds beside it.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-06 done`.
