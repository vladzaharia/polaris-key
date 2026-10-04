# A-18d Listing asset derivation: `pkey listing assets` icons, composed store art and screenshot fit

| Field       | Value                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Phase       | A: Admin: store provisioning (storefronts)                                                                   |
| Size        | 1–2 engineer-weeks                                                                                           |
| Depends on  | [A-18b](A-18b-listing-model.md), [P2-01](P2-01-blob-store.md)                                                |
| Unblocks    | [A-18g](A-18g-steam-adapter.md), [A-18m](A-18m-apple-listing-push.md)                                        |
| Role        | `pkey-implementer`                                                                                           |
| Plan mode   | no                                                                                                           |
| Gates       | golden-image tests (pixel hashes); CLI docs drift gate (generated CLI reference); CLI bundle                 |
| Human input | none for the pipeline; each product's key art, wordmark, screenshots and trailers are human-made (S-15 §7.4) |
| Repo        | `vladzaharia/polaris-key`                                                                                    |

## Goal

`pkey listing assets` turns one icon master, one logo-free key art and one wordmark into every
store's derived and composed listing assets, deterministically, and uploads them to the blob store
with their SHA-256 into `dist_listing_assets`. Screenshots get a per-store fit check and a crop
proposal the operator accepts per image.

## Why

Every icon size can be derived from one 1024² master, and most store art is key art plus a
wordmark laid out by rule ([S-15 §7.4](../../notes/S-15-storefront-provisioning.md#74-assets-derive-compose-or-require)).
Apple screenshots do not fit Play or Steam as they are (§5.6). Doing this in CI, with goldens,
makes it reproducible.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) §5.4, §5.6, **§7.4**, §11 (A-18d),
  owner decision 2.
- `packages/brand` (the kit README, its `sharp` generators, `kit/05-app-icons`).
- P2-01's blob store client; A-18b's `dist_listing_assets` and slot list.

## Scope

**In:**

- CLI `pkey listing assets` (Node, `sharp`), reusing the brand kit's generator code.
- **Derive:** every store icon from the master (Play 512, Microsoft tile 300, Steam 184 JPG and
  256, Flathub, Snap, winget, F-Droid). Android adaptive layers only if the master's mark sits
  inside the central ~61 %; otherwise mark the slot human.
- **Compose** with `textAllowed` per slot: Play and F-Droid feature graphic; Steam header, main,
  vertical, small capsules and the library set (hero is key art only; logo is the wordmark
  export); Microsoft super hero (no text), poster and box art (title required); itch.io cover;
  Snap banner. Crop to ratio around an operator-set focal point, then place the wordmark by rule.
- **Screenshots:** a fit check per target store and a proposed crop or pad (iPhone 6.9″ to ≤ 2:1
  for Play; Mac 16:10 to 16:9 for Steam), accepted per image. Never silent.
- Upload outputs to the blob store with SHA-256, width, height, alpha and `derivedFrom`.
- Play outputs carry `aiGeneratedState = NotAiGenerated` metadata for the adapter.
- A downloadable per-store asset pack (Steam needs it, A-18g).

**Out:**

- Pushing assets to any store (→ A-18e, A-18f, A-18m). Console slot board (→ A-18j).

## Design notes

- **Decision 2:** listing assets are pushed from the Worker out of the blob store; this package
  produces them in CI and stores them. Binaries never pass through here.
- Runs in the CLI, not the Worker (no image library) and not the browser (results must be
  reproducible in CI).
- A composite needs layers: key art without the logo and the wordmark are stored separately, so
  one source serves "no text" and "title required" slots.
- Every output is previewed and accepted before any push; none is pushed unseen.
- A product without key art or wordmark gets icon-only fallbacks, and the fit report marks the
  dependent slots red.

## Acceptance criteria

- [ ] Golden-image tests (pixel hashes) cover every derived and composed slot from fixture inputs.
- [ ] Each output's dimensions, alpha and format match S-15 §7.4's specification for its slot.
- [ ] Screenshot fit proposals for the §5.6 cases are tested and require acceptance.
- [ ] The CLI reference is regenerated; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- listing assets
```

## Hand-off

A-18e, A-18f and A-18m push the stored outputs; A-18g offers the Steam pack; A-18j shows the slot
board and the accept flow.

The role agent sets `--set A-18d in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18d done`.
