# HA-12 Discovery `core.presentation` in the Worker: contract text, `shared-protocol` type, transcripts and mirrors

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                 |
| Size        | 0.6–0.9 engineer-weeks                                                                                           |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-02](HA-02-img-host.md), [HA-07](HA-07-serve-hosted-copies.md) |
| Unblocks    | [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md)                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                            |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md) through [`plans/HA-12.md`](../plans/HA-12.md)   |
| Gates       | plan mode; corpus and transcripts (rule 1); drift gates; generated docs                                          |
| Human input | none                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                        |

## Goal

Discovery emits `core.presentation` per the approved plan. The contract text and the protocol types document it. Transcripts are regenerated with their mirrors.

## Why

This is the server half of decision 10 ([S-20 §6.9](../../notes/S-20-hosted-assets.md#69-sdks-and-ui-kits-icon-and-accent-with-zero-integrator-work)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- `plans/HA-11.md` (approved) and `plans/HA-12.md` (approved 2026-10-06), whose §0.2 amends HA-11's text.
- `src/core/discovery.ts`, `packages/shared-protocol`, `packages/worker/test/transcripts/`.

## Scope

**In:**

- Exactly the plan's Worker, contract and transcript steps.

**Out** (and where it belongs instead):

- SDKs (→ HA-13, HA-14).

## Design notes

- Follow the plan. Any deviation goes back to the planner.
- **The settings-registry entry is provisional.** ST-06 registered `core.presentation` in `CORE_SLICE` (`packages/worker/src/core/settings/core.ts`) so the coverage test has a home for `.pkey/product` `presentation`: manifest-owned, `json` value (`ManifestPresentation`), carried in discovery, with `pending: { wp: "HA-12" }` and a provisional `scalar` storage in `product_settings` ([ST-06](ST-06-settings-docs-coverage.md#design-notes), fix round 1). When discovery serves it, remove the `pending` marker and set the entry's storage to the store HA-11's plan picks; regenerate the settings page and ⌘K index (`pnpm gen:settings`).

## Approved plan (2026-10-06)

[`plans/HA-11.md`](../plans/HA-11.md) is approved with every recommendation. This package does §2, §3, §4 and §6 of the plan:

- **Migration.** `packages/worker/migrations/<NNNN>_products_presentation.sql` adds
  `products.presentation_json`. `<NNNN>` is the next free number at merge time, and the lead
  assigns it (0079–0088 are claimed). The column is written in the batch of `resyncRepo`,
  `linkRepo` and `linkSystemProduct`.
- **Settings.** In `core/settings/core.ts`, the `core.presentation` storage becomes
  `{ kind: "column", table: "products", column: "presentation_json" }`. Its readers are set and
  `pending` is removed. Run `gen:settings`.
- **Resolver.** New `core/presentation.ts` `resolvePresentation(ctx)` follows the plan's §2.1
  emission rule:
  - name: the listing's, else the product's;
  - developer: the listing's `developerName`;
  - accent: `presentation.accent`, else the listing's `tintColor`;
  - icon: `presentation.icon`, else `listing.icon`, from `hosted_assets` with the WebP `sizes`.

  The member is emitted only when something beyond the name resolves. Discovery and the portal's
  `presentationFor` both use the resolver.

- **Contract and shared code.**
  - `WIRE-CONTRACT-V4.md`: §5.5 (not §5.3, which PX-W9 holds), plus additions to §9 and §10.
  - `shared-protocol/src/core.ts`: the presentation types and `PRESENTATION_*` constants, emitted
    by `gen:constants`.
  - New `packages/client-core/src/presentation.ts`, exported as
    `@polaris-key/client-core/presentation`: `parsePresentation`, `pickIconSize`, `iconMatches`
    and the `PresentationSource` seam type.
- **Corpus.** `tools/presentation-matrix.ts` produces `presentation-matrix.json`
  (`presentationMatrixVersion: 1`) through `sign-corpus.ts`, with both mirrors. It checks its rows
  against its own generator-local reference, which imports nothing it checks; client-core is
  proven by its own matrix test against the file (`plans/HA-12.md` Q2). Add the file, and the
  missing `device-label.json`, to AGENTS.md rule 1, and the file to `contribute/corpus.md`.
- **Transcript.** `discovery-presentation.json`, two steps: the member is present, then gone.
- **Parity.** A `core.presentation` row in `features.json`, set to `planned` in all six
  `parity.json` files.
- **Docs and spec.** The OpenAPI `DiscoveryDocument` schema, the `services/core/discovery.md`
  "Presentation" section and one THREAT-MODEL row.

## Plan amendments ([`plans/HA-12.md`](../plans/HA-12.md), approved 2026-10-06)

`plans/HA-12.md` is the execution plan; where it differs from the list above, it wins (its §0.2).

- **Hosted copies.** `core/hostedImages.ts` `HostedImage` gains `contentType` and per-size
  `variants` (`{w, sha256}`, WebP, deduplicated, ascending); `widths` is derived from them. The
  icon is `firstHostedImage(…, PRESENTATION_ICON_SLOTS)`, read only while `hostedImageOrigin(env)`
  is non-null. A slot with no hosted copy has no icon in discovery; the `/media` proxy never
  appears (Q3).
- **Settings.** A decode-only `core.presentation` column adapter (no `set`, so a console write is
  refused) and a `core.presentation` probe in `settings-discovery.test.ts`.
- **Writers.** `repo.ts` `ProductRow`, `stmtInsertProduct` and `insertProduct` gain
  `presentation_json`; resync's `productFields` gains a manifest-only row with an explicit audit
  key (`core.presentation`, not the `core.adminGroup` fallback); `linkSystemProduct` writes the
  column in its first `UPDATE`.
- **Portal.** The portal shares only the resolver's text half (`presentationText`: name,
  developer, accent as its tint). Its art and §12.7.2's client record `iconUrl` do not change.
- **Constants (Q6).** `PRESENTATION_ICON_MAX_DIMENSION` 16384,
  `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS` 10 and `PRESENTATION_CACHE_MAX_FILES` 4 join HA-11's
  six, generated into every SDK.
- **No ETag (Q4).** Discovery keeps `public, max-age=300` and gains no ETag.

## Steps

1. Per the plan.

## Acceptance criteria

- [ ] `pnpm gen:corpus -- --check` covers `presentation-matrix.json` and its Swift and Godot mirrors; `pnpm gen:constants -- --check`, `pnpm gen:settings -- --check` and `pnpm parity:check` are green.
- [ ] A product with only a listing icon and `tintColor` (no manifest `presentation`) emits `core.presentation` with that icon and accent (test).
- [ ] `pnpm gen:transcripts -- --check` and `pnpm gen:corpus -- --check` are green after regeneration.
- [ ] Discovery for a product with no presentation omits the member (test).
- [ ] The `core.presentation` registry entry has no `pending` marker and its storage is the store HA-11's plan names; `pnpm gen:settings -- --check` is green.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:settings -- --check
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
```

## Hand-off

SDK porters replay the new transcripts.

After the deploy, the lead resyncs DJDL (S-20 §6.8, "pull on first resync"): HA-05 then pulls its
art, and the icon appears in discovery within 300 s (`plans/HA-12.md` §7).

The role agent sets `--set HA-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-12 done`.
