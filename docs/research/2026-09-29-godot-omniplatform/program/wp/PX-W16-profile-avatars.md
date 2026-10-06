# PX-W16 Profile import and avatars (G32, G33): claims at link time per provider, profile record with explicit flags, refresh until chosen, server-side fetch with host allowlist, re-encode, R2, media route, upload

| Field       | Value                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                                        |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                         |
| Depends on  | [PX-W1](PX-W1-library-api-media.md), [I-06](I-06-login-providers.md)                                                                                                                                                           |
| Unblocks    | [PX-21](PX-21-email-gate-ui.md), [PX-22](PX-22-account-profile.md)                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                             |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); D1 migration (next free number at the final gate); `TABLE_OWNERS`; THREAT-MODEL; CSP browser test (zero violations); `typecheck:workerd` and `test:workerd` |
| Human input | an R2 bucket or prefix for copied avatars per environment (shared with I-07's request)                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                      |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Profile import and avatars are already built on `wp/I-07-login-card-email-gate` (`card/profile.ts`, `card/avatars.ts`). Reconcile with them before building; copy per SIGN-IN.md §3.5 (`signin.profile.*`).

## Goal

Provider profile claims are stored per identity link at link time; the account has a `profile` with sources and explicit flags, refreshed on sign-in only while not explicit; `GET/PATCH /api/me/profile` and `POST /api/me/profile/picture` exist; provider pictures are fetched server-side from allowlisted hosts, re-encoded to WebP and PNG at 256 and 96 px, stored content-addressed in R2 and served same-origin through `GET /media/avatar/:asset`.

## Why

Owner decision: import profile data from identity providers ([PORTAL.md §4.30](../../../../design/PORTAL.md#430-account--profile), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G32, G33). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.30](../../../../design/PORTAL.md#430-account--profile), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §7](../../../../design/PORTAL.md#7-layout-and-visual-details)
- `wp/I-06-login-providers.md`, `wp/I-07-login-card-email.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- Claims capture per provider (Google, Apple first-authorisation name, Steam persona and avatar); profile record; profile routes; avatar fetch, re-encode, R2 and media route; upload with a per-account rate limit; GC of old assets.

**Out** (and where it belongs instead):

- UI (→ PX-21, PX-22)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Slug:** `avatar` is already a reserved product slug (portal wave 1 integration), so `/media/avatar/:asset` cannot collide with a product's `/media/<product>/<asset>`.
- **THREAT-MODEL:** SSRF on fetch (allowlist `lh3.googleusercontent.com`, `avatars.steamstatic.com`), image-parser bugs, storage abuse; profile claims are untrusted display data.
- **Overlap with the re-cut S-16/S-17 graph:** I-07 also names profile import with avatars in R2. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W16:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W16 in-review`.

## Acceptance criteria

- [x] Explicit choices survive re-sign-in (test): `test/portalProfile.test.ts` ("explicit choices survive re-sign-in": typed name, picked name, picked picture, Initials, upload) and the gate's typed name in `test/identityCardProfile.test.ts`.
- [x] Fetch refuses non-allowlisted hosts (test: off-list host never dialled, an allowlisted host redirecting elsewhere refused at the hop); a CSP browser test shows proxied avatars with zero violations (`packages/admin/e2e/portalAvatar.e2e.test.ts`, run with `test:e2e`; the gate script does not run it).
- [x] The migration (`00XX_account_avatars.sql`, number for the lead) and `TABLE_OWNERS` entry land together; OpenAPI and `routeCoverage` cover every route.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass (new `test-workerd/avatars.test.ts`); `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header. With the `00XX` placeholder, `test/recordDeploy.test.ts` refuses `LATEST_MIGRATION` until the lead assigns the number (the gate was run with it provisionally numbered).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## S-20 note (2026-10-05)

The avatar copy reuses S-20's ingest core, `core/safeFetch.ts` and `core/hostedAssets.ts` from
[HA-01](HA-01-hosted-asset-core.md), with an `avatar` slot space. It must not build a second
outbound fetcher. The provider host allowlist stays specific to this route
([notes/S-20 §8](../../notes/S-20-hosted-assets.md#8-interactions-with-other-plans)).

## Corrections against the code (PX-W16 builder, 2026-10-06)

- **I-07 landed first** and owns the shared code: claims capture per provider (`providers/*.ts` →
  `card/gate.ts` → `card/profile.ts`), the profile record (`accounts.display_name`, `avatar_key`,
  `locale` with sources and explicit flags in `details_source_json`, per-link imports in
  `account_links.profile_json`), `GET /media/avatar/…` and the deletion hook. PX-W16 narrows to
  what was left: the fetch moved onto `core/safeFetch.ts`, re-encoding, content-addressed storage,
  the profile routes, upload, GC, and the media route serving only re-encoded renditions.
- **Not an `avatar` slot space in `core/hostedAssets.ts`** (S-20 note above). The hosted-asset
  store writes the original under `blobs/sha256/`, which carries a 180-day R2 age lock
  (`docs/DEPLOYMENT.md`), so a deleted account's picture could not be erased for six months; its
  rows, refs and audit are product-scoped, and an avatar belongs to an account. Avatars therefore
  keep I-07's `avatars/` prefix in `BLOBS` (no lock; the human input, settled by I-07) and reuse
  the S-20 substrate below the store: `safeFetch` (the one outbound fetcher, with this route's
  own `allowHost`), `core/sniff.ts`, and the Images binding HA-03 binds. No second fetcher.
- **Re-encoding uses the `IMAGES` binding** (already bound for prod, staging and dev). WebP and
  PNG output always discards metadata. Without the binding nothing is copied and the account shows
  initials; an avatar is never stored as fetched.
- **Content-addressed, peppered.** The asset id is `HMAC(KEY_HASH_PEPPER, account ‖ SHA-256 of
the source)`, so the same picture is stored once per account and the id is not computable from a
  public provider picture. A migration adds `account_avatars` (one row per asset) for deletion and GC.
- **Refusals use registered codes.** Every `error` the Worker answers must be in
  `conformance/parity/errors.json`, and each code there needs copy in all eight locales and a
  regenerated copy module in every SDK. The profile routes therefore answer `bad_request`,
  `not_found` and `body_too_large` with a `reason` field naming the case (`invalid_name`,
  `unknown_source`, `no_name`, `no_picture`, `unknown_upload`, `too_large`, `unsupported_type`,
  `unreadable_image`) rather than eight new codes.
- **Rule 10 for portal routes** is the OpenAPI spec (tag `portal`) plus `PORTAL_KIND_PATHS` in
  `routeCoverage.test.ts` (PX-W1 changed this; PORTAL.md §10.1's "narrative only" sentence is
  older), and the docs site's portal page.

## Hand-off

PX-21 shows `ProfileImport`; PX-22 builds `ProfileEditor` and `Avatar`.

The role agent sets `--set PX-W16 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W16 done`.
