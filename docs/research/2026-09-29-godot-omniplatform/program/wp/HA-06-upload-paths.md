# HA-06 Files that are not on the web: console upload (claims a slot, Revert returns to the manifest), `pkey assets push`, publish Action `assets:` input, CI scope `assets:write`, Presentation page with delete-a-copy

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 2: ingest)            |
| Size        | 1–1.5 engineer-weeks                                                                          |
| Depends on  | [HA-02](HA-02-img-host.md), [HA-05](HA-05-pull-on-sync.md)                                    |
| Unblocks    | [HA-17](HA-17-store-video-slots.md)                                                           |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | rule 10 (OpenAPI + routeCoverage); console CSP parity; Action bundle (rule 3); generated docs |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

An operator can upload any slot's file in the console. CI can push one with `pkey assets push <file> --slot <slot>` or the Action's `assets:` input. The product's Presentation page shows every slot's source, status, size and media-host preview, with Replace, Revert to manifest and Delete copy.

## Why

Some art is never on the web. The listing model already anticipates `source = 'admin'` rows but has no writer ([S-20 §4.2](../../notes/S-20-hosted-assets.md#42-storefront-listing-assets-s-15--a-18) L1).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.3, decision 11.
- `src/services/distribution/listing/assets.ts` (ticket, promote), `packages/cli/src/listingAssets.ts`, `actions/publish/action.yml`, `src/core/ciVocabulary.ts`.

## Scope

**In:**

- `POST /admin/products/:p/assets/:slot`: streaming body, then ingest, then claim. `DELETE` drops the claim, or the copy for an unclaimed slot.
- `POST /<p>/assets` for CI with scope `assets:write` (new vocabulary entry), staged through the existing upload ticket.
- For A-18 slots, write `dist_listing_assets` with `source = 'admin'` (console) or `import` (CI), so A-18j uses this path.
- Console Presentation page under the product, with the media origin in `img-src` for the console CSP (parity test).
- `pkey assets push` and the Action input. Rebundle the Action.

**Out** (and where it belongs instead):

- Store pushes (A-18e/f/m). Video (→ HA-17).

## Design notes

- Precedence: console claim, then manifest, then CI (S-20 §6.3).
- Upload size limit: the slot cap from HA-01, enforced while streaming.

## Steps

1. Admin route.
2. CI route and scope.
3. CLI and Action.
4. Console page.

## Corrections from the code (recorded by the implementer)

- **The console route is `/manage/api/products/:p/assets/:slot`**, the admin API's prefix (the
  brief's `/admin/products/…` is the same route); `?locale=` names a locale. `DELETE` is Revert
  for a console claim whose source the manifest still names, and delete-a-copy otherwise.
- **The console CSP already admits the image host.** The console product card (2026-10-06) added
  `IMG_ORIGIN` to the shell's `img-src` with its parity test; the Presentation page loads its
  previews from there and changes no policy.
- **Revert drops the console's copy at once** and queues one pull of the manifest's ref (`reason:
"operator"`); the slot shows nothing until it lands. Keeping the console's bytes serving under a
  manifest origin would let a failing source pass them off as the manifest's last good copy.
- **Precedence needed an atomic guard in `ingest`.** A pull that was in flight when an operator
  uploaded would have overwritten the claim, so `ingest` gained `yieldsTo` (re-checked inside the
  batch that writes) and `recordRefusal: false` (an upload's refusal never marks the slot's copy
  failed). HA-05's pull consumer now passes `yieldsTo: ["console"]`.
- **The CI ticket is Release's.** P2-02's uploads route lives under `release/publish/uploads`, so a
  CI push needs Release on for the product, as A-18d's listing register does.
- **No migration.** `hosted_assets.origin` and `dist_listing_assets.source` already allow
  `console`/`ci` and `admin`/`import`.

## Acceptance criteria

- [x] An uploaded icon survives a resync, and Revert restores the manifest's copy (test:
      `packages/worker/test/hostedAssetUploads.test.ts`, first block).
- [x] A CI push never overwrites a console claim (test: same file, "a CI push never overwrites a
      console claim", including the in-batch race).
- [x] Rule 10 and console CSP parity pass.
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

## Hand-off

A-18j's slot board calls these routes.

The role agent sets `--set HA-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-06 done`.
