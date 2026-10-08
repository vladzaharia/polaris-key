# CM-29b Commerce's accent: a ninth, red-orange family

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | CM: Commerce (DX consolidation H: Channels, storefronts and commerce)             |
| Size        | 0.3–0.5 engineer-weeks                                                            |
| Depends on  | [CM-29](CM-29-commerce-service.md)                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)             |
| Plan mode   | yes: executes the approved [`plans/CM-29.md`](../plans/CM-29.md) (2026-10-08) §10 |
| Gates       | `plan-mode`, `drift-gate`, `golden-images`, `ui-snapshots`                        |
| Human input | none, unless no colour reaches the 17.0 floor (then the owner decides)            |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

The `commerce` service has its own red-orange accent family, `vermilion`, in every generated brand output, and contrast passes in both themes. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner chose "Add a red-orange accent" for Commerce (2026-10-08). Per-service accents belong to `@polaris-key/brand`, and the new one follows the brand rollout's accent rules ([`BRAND.md`](../../../../design/BRAND.md) §5).

## Read first

- `AGENTS.md` (always).
- [`plans/CM-29.md`](../plans/CM-29.md) §10 ("CM-29b").
- [`docs/design/BRAND.md`](../../../../design/BRAND.md) §5 (section accents and the rules they satisfy).
- `packages/brand/src/tokens/source.ts`, `packages/brand/test/accents.test.ts` and `contrast.test.ts`.

## Scope

**In** (`plans/CM-29.md` §10):

- **Tokens.** `ACCENT_FAMILIES` gains `vermilion`; `SERVICE_IDS`, `SERVICE_FAMILY` (`vermilion`), `SERVICE_MARK` (`key`) and `SERVICE_LABEL` gain `commerce`; the family gets dark and light `solid`, `fg`, `on` and `subtle`.
- **Measurement.** `tune-accents.ts` searches OKLCH hue 26–50° under every `contrast.test.ts` rule (`solid` 3:1 on every surface and on `subtle`; `fg` and `on` 4.5:1), the gamut, lightness band, chroma floor and rose band, maximising the minimum ΔE00 to the other accents, the violet, the rose and the danger tokens.
- **Floors.** `DE00_FLOORS.services` and `.references` drop to one tenth below the chosen colour's measured minimum, only if that is under 17.5, and never below 17.0. The ΔEOK (0.085) and violet (13) floors stay. The family test pins `SERVICE_FAMILY.commerce`.
- **BRAND.md** §5: the floors and their measurement, the table row, and the owner's decision.
- **Generated outputs.** `gen:brand` regenerates the CSS, `tokens.json`, the Swift and Godot brand tokens and `[data-service="commerce"]`; `brand proofs` re-renders `preview/proofs/accents-{dark,light}.png`; the preview is rebuilt.

**Out** (and where it belongs instead):

- The `commerce` service itself (→ CM-29).

## Design notes

- Runs on CM-29's branch: `packages/brand/test/services.test.ts` pins `SERVICE_IDS` to `tools/services.json`, which CM-29 changes. The lead sets both packages done in that PR.
- If the search cannot reach 17.0, stop and ask the owner; never lower a floor further.
- `pkey-ux-reviewer` reviews the proofs in both themes.

## Steps

1. Run the search and record the chosen colour and its measured minimums in the PR.
2. Apply the tokens and floors, regenerate, re-render the proofs; run the green gate; hand off.

## Acceptance criteria

- [ ] `contrast.test.ts` passes for `vermilion` in dark and light.
- [ ] No floor is below 17.0, and each lowered floor is one tenth below the measured minimum.
- [ ] `pnpm gen:brand -- --check` and `pnpm --filter @polaris-key/brand test` pass.
- [ ] `pkey-ux-reviewer` passes the accent proofs in both themes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm --filter @polaris-key/brand test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set CM-29b in-review` when it hands off. After review, the lead adds the last commit of CM-29's PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-29b done`.
