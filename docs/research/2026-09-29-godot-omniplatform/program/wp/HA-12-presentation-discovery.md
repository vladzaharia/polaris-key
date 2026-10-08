# HA-12 Discovery `core.presentation` in the Worker: contract text, `shared-protocol` type, transcripts and mirrors

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                                                                                                                                                                                                                                                                                                                                                                                   |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-02](HA-02-img-host.md), [HA-07](HA-07-serve-hosted-copies.md)                                                                                                                                                                                                                                                                                                                                                                   |
| Unblocks    | [P0-15](P0-15-platform-primitives-duplicate-helper.md), [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md), [P0-42](P0-42-generator-registry-pnpm-gen.md), [P0-44](P0-44-corpus-generator-split-corpus-lane-right.md), [I-08](I-08-app-passthrough.md), [I-29](I-29-retire-product-account-toggles-one-app.md), [A-27](A-27-one-listing-truth-absorbs-st-13.md), [ST-42](ST-42-create-defaults.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md) through [`plans/HA-12.md`](../plans/HA-12.md)                                                                                                                                                                                                                                                                                                                                                                     |
| Gates       | plan mode; corpus and transcripts (rule 1); drift gates; generated docs                                                                                                                                                                                                                                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Merged into integ/batch-6 as reviewed (6cc235aa3) and stamped done there (e4a527fee); done on main when batch 6 lands. core.presentation is the one name/icon/accent source (sign-in header, consent, emails, portal, kits, Discover). P0-44 runs right after it in the corpus lane.

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

## Execution notes (HA-12, 2026-10-06: where the code differed from the plan)

- **The migration is `0106_products_presentation.sql`.** That is the lead's number: `0104` is
  LX-30's, and `0105_a` to `0105_m` are LX-08's. It was never a `00XX` placeholder, because
  wrangler orders migrations by `parseInt` of the leading number. A `00XX` file sorts as 0 and
  runs first, so an `ALTER TABLE products` in it fails before `products` exists
  (`test/checkRepresentable.test.ts`, and a real `d1 migrations apply`). `LATEST_MIGRATION` and
  the data-model page follow the number.
- **No client-core export-layout test exists** (plan §2.6). `./presentation` is added to
  `package.json` `exports`; the matrix test imports the module directly.
- **The usable-URL rule is written portably** (§5.5 rule 5), with no URL parser, so GDScript
  applies the same test:
  - printable ASCII, with no `#` and no `\`;
  - an `https://` prefix, or `http://` for the loopback hosts only;
  - an authority of a host and an optional port of 1 to 5 digits, at most 65535;
  - a host that is `[::1]`, `127.0.0.1`, or `[a-z0-9-]` labels whose last label is not all
    digits;
  - an origin compared as the lower-cased `scheme://authority` string.

  The `url` template must begin with the original's origin and then `/` or `?`, so `{w}` can
  never change the host or the port. The matrix pins each rule (review fix round). No matrix row
  holds U+0000, which a Godot `String` cannot, and the generator refuses one.

- **Lone surrogates are not in the matrix.** §5.5 makes text with a lone surrogate invalid, but
  JSON decoders differ on one, so the matrix does not carry it. client-core pins the rule in its
  own test (`packages/client-core/test/presentation.test.ts`, "a lone surrogate is not text"), and
  each SDK pins it the same way. An invalid `name` falls back to the document's `name` only when
  that passes the same rule, and the matrix pins that.
- **The codec lives in `core/products.ts`** (`parseStoredPresentation`, `serializePresentation`),
  so the writers (`linkRepo`, `resyncRepo`, `linkSystemProduct`) and the column adapter import it
  without an import cycle through `core/presentation.ts`.
- **`PRESENTATION_MATRIX_VERSION`** is generated beside the other corpus versions, so the SDK
  matrix runners (HA-13, HA-14) assert the file's version as they do the others'.
- **A failed presentation read never fails discovery.** `resolvePresentation` answers `null` (the
  member is omitted) when the listing or the hosted-copy read throws.

## Steps

1. Per the plan.

## Acceptance criteria

- [x] `pnpm gen:corpus -- --check` covers `presentation-matrix.json` and its Swift and Godot mirrors; `pnpm gen:constants -- --check`, `pnpm gen:settings -- --check` and `pnpm parity:check` are green.
- [x] A product with only a listing icon and `tintColor` (no manifest `presentation`) emits `core.presentation` with that icon and accent (test).
- [x] `pnpm gen:transcripts -- --check` and `pnpm gen:corpus -- --check` are green after regeneration.
- [x] Discovery for a product with no presentation omits the member (test).
- [x] The `core.presentation` registry entry has no `pending` marker and its storage is the store HA-11's plan names; `pnpm gen:settings -- --check` is green.
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header.

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

Follow-up (review): the resync dry run (`planRepoManifest`) does not yet show a change to
`presentation`, though the apply writes and audits it as `core.presentation`.

The role agent sets `--set HA-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-12 done`.
