# P0-32 One data layer for console and portal

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 1.2–1.6 engineer-weeks                                                                                                |
| Depends on  | [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md), [P0-39](P0-39-console-sections-move-page-budget-lead.md)  |
| Unblocks    | [P0-33](P0-33-worker-owned-dto-types-admin-portal-apis.md), [P0-51](P0-51-1-0-readiness-review.md)                    |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `console-csp-parity`                                                                                                  |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

One data layer for console and portal, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.3, for **CQF-02**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- lib/http.ts and HttpError; api.ts and portal/api.ts split per service; lib/errorCopy decoupled from api.ts (drops api.ts from the portal bundle); queryOptions factories for every read; PORTAL_MUTATIONS plus useWrite and a no-direct-write test; one ErrorState (ErrorPanel deleted); older-Worker branches removed. Must not touch the shim files P0-31 deletes.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-02**; DX consolidation B: Foundations (code quality the feature tracks build on).
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

## Corrections (2026-10-22)

The code is the fact; these replace the matching claims above (slice P0-32.1).

- **B1. Done already by P0-31.** The console client is provider-scoped (`console/data/queryClient.tsx`, `ConsoleQueryProvider`). `context.tsx`, `AdminProvider` and every explicit `queryClient` argument are gone; `useMe` exists. P0-31 is done, so "must not touch the shim files P0-31 deletes" is moot.
- **B2. Fetch.** Only three call sites: `api.ts:4929` (console `send`), `portal/api.ts:1251` (portal `send`) and the portal's raw `/logout` (`portal/api.ts:1739`, `redirect: "manual"`, no CSRF, any status accepted).
- **B3. Console reads.** 153 `queryFn` sites in 65 files; about 60 console files call `api.*` outside a data module. Section `data.ts` exists only for config, distribution, feeds, release, storefronts and sync. Duplicate hooks for one key still exist: `useCatalog` (config, distribution), `useProfiles` (license `components/shared.tsx`, config), `useDeliverables` and `useReleaseStore` (release, distribution).
- **B4. Console writes.** `MUTATIONS` + `mutate`/`mutateEach` and the AST "no write around mutate" test (`test/mutations.test.ts:150-295`) are in place and stay the pattern.
- **B5. Portal reads and writes.** `portal/data.ts` has 17 reads, 25 `useMutation` hooks, its own `qk` plus the `portalKeys` alias table; `portal/requestData.ts` has 4 reads plus `requestKeys`. 45 direct `portalApi` writes sit in 11 files (`SignInPage`, `signin/{FinishStep,DeviceStep,HintStep,RequestFlow,usePasskeySignIn}`, `account/{StepUp,SignInMethods}`, `LinkAccountsDialog`, `ApproveDeviceDialog`, `App.tsx`), with ad hoc cache calls in 10 files. `StepUp.tsx` invalidates everything. About 49 `portalApi` methods write.
- **B6. Two error classes.** `ApiError` (`api.ts:4870`, positional constructor): 86 `instanceof` sites, 53 test constructions. `PortalApiError` (`portal/api.ts:1198`, `(status, code)`): 91 `instanceof` sites, 21 constructions. The console tags a network failure `isFetchFailure` (read by `lib/errorCopy.ts:327`); the portal uses status 0, code `network`. Held F-34.8 adds `packageFeeds` to `ApiError` and to `send()`.
- **B7. Errors on screen.** `ui/ErrorState.tsx` is console-voiced (through `lib/errorCopy`). `ErrorPanel` (`portal/components/States.tsx:22`, voiced by `portal/errors.ts`) is used in 11 portal files. EXPERIENCE.md §3 wants `ErrorState` with "one interface, a portal voice table" and `ErrorPanel` deleted.
- **B8. Boundary edges P0-32 owns.** `lib/errorCopy.ts -> api.ts` and `ui/form.tsx -> api.ts`. The other five `-> api.ts` edges are type-only and P0-33's. The rule-4 probe test asserts `portalReach().has("lib/errorCopy.ts -> api.ts")`; it is rewritten when the edge goes.
- **B9. Older-Worker runtime branches.** Console: `core/pages/Settings.tsx:160`, `license/pages/LicenseDelete.tsx:115`, `license/components/shared.tsx:294`, `license/components/holders.tsx:48,287`, `license/pages/LicenseDeviceLimit.tsx:47,162`. Portal: `api.ts` `legacyPath` (:750), `pages/SignInPage.tsx:1364`, `pages/ProductPage.tsx:291`, `model/owned.ts:5`, `model/library.ts:327`, `product/RemoveLicenseDialog.tsx:50`, `account/SignInMethods.tsx:103`. About 30 more are optional-field comments in the two `api.ts` files (P0-33's DTOs replace those mirrors). Held U-05 adds one more (`cloudSyncWrite?`).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One HTTP client and error class
- [ ] No direct fetch in pages (test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-32 done`.
