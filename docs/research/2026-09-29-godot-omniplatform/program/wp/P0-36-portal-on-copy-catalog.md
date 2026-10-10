# P0-36 Portal on the copy catalog

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                    |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                   |
| Depends on  | [UK-14](UK-14-node-terminal.md), [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md)                                                              |
| Unblocks    | [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [P0-51](P0-51-1-0-readiness-review.md), [PX-12](PX-12-login-card-v2.md), [LX-15](LX-15-portal-licensing.md) |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                       |
| Gates       | `portal-e2e`, `console-csp-parity`                                                                                                                       |
| Human input | none                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Extend ST-37's copy lint (`packages/admin/test/copyLint.test.ts`) to the portal. The portal still shows "Automatic Grant" (`AUTOMATIC_GRANT` in `portal/model/library.ts`); it becomes "Automatic grant".

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: after a copy edit, regenerate `ui-matrix.json` with `pnpm gen corpus` without holding the corpus lane (D13).

## Goal

Portal on the copy catalog, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQF-06**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- lib/copy.ts t() over @polaris-key/brand/kit-copy with an ICU-subset formatter; replace the 41 verbatim strings, the signin.\* placeholders and the 24 refusal-code wordings; origin word 'Automatic grant' from the catalog; ui-qa portal board over e2e/portalStates.ts. Rebases after UK-14's kit-copy edits.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-06**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

### Corrections found in the code (builder, P0-36)

- `lib/copy.ts` is built: `t(key, args)` over `KIT_COPY_EN` with ui-core's `Copy` formatter (UK-03 landed first, so no formatter ships here), plus `tParts` for a sentence that holds a rendered argument (the bold address in `signin.code.sent`). `@polaris-key/ui-core` is a new admin dependency.
- The "41 verbatim strings" were about 130 sites by an exact match against the catalog; the lint (`test/copyLint.test.ts`, "the portal copy lint") now fails on any, with a negative control. Six catalog keys and one sentence are listed as same words, another sentence, each with its reason.
- The "24 refusal-code wordings" are not retyped catalog text: the portal words its own browser errors (`portal/errors.ts`), and only three titles equal catalog titles (`signin.network.title`, `signin.console.signedOut`, `core.fallback.title`). Those three read the catalog; the rest need the owner's call (the portal's wording is for a browser, `core.codes.unauthorized` says "this device"). The `codeErrorText` triple is one module, `portal/copy/codeEntry.ts`.
- About 35 `signin.*` placeholders and the `profile.*` and `getIt.*` tables have **no catalog key**; they stay in the portal under the key they will take, and the lint cannot flag them until the catalog holds them.
- "Automatic grant" needs a catalog edit (`signin.choice.origin.signIn`, "From signing in" today) and a validator exception ("grant" is banned vocabulary in `packages/brand/scripts/kit-copy.ts`), then `pnpm gen`, which rewrites every SDK table. That is outside the portal tree and was not done here; the portal says "Automatic grant" in sentence case from its own constant until it is.
- The ui-qa `portal` board over `e2e/portalStates.ts` is in `packages/ui-qa`, outside the portal tree: not done here.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 6 mockup item(s):** `portal.library`, `portal.library-12`, `portal.discover`, `portal.free-device`, `portal.license`, `portal.license-lapsed`.
- `B13.1`, `OR-terse-copy`: Not mechanisable: enforced by the acceptance block's copy row plus the recorded pkey-ux-reviewer pass (ux-reviews.json).
- `doc:PORTAL#6.1`, `doc:PORTAL#6.2`: P0-36 moves the portal to the copy catalog: it must delete the 'until UK-02a' inline copy in SignInPage.tsx and CodeCells.tsx and adopt the 6.1/6.2 rules.

## Acceptance criteria

- [x] No verbatim customer-facing string in the portal (lint): every string equal to a catalog message; strings the catalog lacks are listed above
- [ ] 'Automatic grant' comes from the catalog in sentence case (sentence case done; the catalog edit is open, see Corrections)
- [x] ST-36's e2e assertions (e2e/portal.e2e.test.ts) and PORTAL.md updated to 'Automatic grant'
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-36 done`.
