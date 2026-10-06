# HA-04 Manifest asset refs: `.pkey/product` `presentation { icon, accent, accentDark }` and `.pkey/distribution` listing `icon`, `header`, `screenshots[]` taking an https URL or a repo path; `iconUrl`/`headerUrl` as deprecated aliases

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 1: substrate)        |
| Size        | 0.6–0.9 engineer-weeks                                                                       |
| Depends on  | none                                                                                         |
| Unblocks    | [HA-05](HA-05-pull-on-sync.md), [HA-11](HA-11-presentation-discovery-plan.md)                |
| Role        | `pkey-implementer`                                                                           |
| Plan mode   | no                                                                                           |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); generated docs; Action bundle (rule 3) |
| Human input | none                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                    |

## Goal

A product can declare its icon and accent in `.pkey/product`, and its store art in `.pkey/distribution`, as either an https URL or a repo-relative path, optionally with a `sha256`. The validator, the JSON Schemas, the mutation table and the generated docs agree. Existing manifests stay valid.

## Why

Today the only image fields are three https-only URLs in the distribution listing. There is no way to point at a file in a private repo, and no icon for a product without the distribution service ([S-20 §4.1](../../notes/S-20-hosted-assets.md#41-product-presentation), decision 5).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- AGENTS.md rule 9; the `authoring-pkey-manifests` skill.
- `packages/shared-manifest/src/index.ts`, `src/distribution.ts` (`ManifestListing`, `isListingUrl`, `normalizeListing`), `schemas/v1/*.schema.json`, `test/schema-parity.test.ts`.

## Scope

**In:**

- Asset ref grammar: a string that is either `https://…` (existing rules) or a relative POSIX path. No `..` segment, no leading `/`, at most 512 chars, extension `.png|.jpg|.jpeg|.webp|.gif|.avif`. Or an object `{ src, sha256? }`.
- `.pkey/product` `presentation`: `icon` (asset ref), `accent` and `accentDark` (`#rrggbb`).
- Listing `icon`, `header`, `screenshots[]` (at most 16). `iconUrl`/`headerUrl` stay accepted, normalise into `icon`/`header`, and give a warning `listing_url_field_deprecated`. Declaring both an alias and its new field is an error.
- Normalised output carries a `kind: url|repo` per ref. Docs reference pages are regenerated.

**Out** (and where it belongs instead):

- Fetching anything (→ HA-05).

## Design notes

- The listing `icon` defaults to `presentation.icon` when absent. The resolution is done in the Worker (HA-05), not in the validator.
- Rule 5: no product-specific defaults.

## Steps

1. Grammar and validator rules with mutation-table entries.
2. Schemas.
3. Docs and Action rebundle.

## Acceptance criteria

- [ ] Every new rule has a mutation entry, and `schema-parity` passes.
- [ ] DJDL's current `distribution.yaml` validates with only the deprecation warning (fixture test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
```

## Hand-off

HA-05 resolves `kind: repo` refs at the synced commit. HA-11 reads `presentation` for discovery.

The role agent sets `--set HA-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-04 done`.

## Corrections recorded during implementation

- The normalised listing no longer carries `iconUrl`/`headerUrl` (they normalise into `icon` and
  `header`), so the three Worker readers of the stored listing (`feeds/render.ts`,
  `listing/sources.ts`, `portal/media.ts`) now read art through `listingImageUrl` /
  `listingScreenshotUrls`, which accept both the new refs and pre-HA-04 rows. They only read an
  https ref; a repo ref yields nothing until HA-05 hosts its bytes. No fetching was added.
