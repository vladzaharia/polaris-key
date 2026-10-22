# F-34 Feeds that provision themselves, Customers by default

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)                                                                     |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                               |
| Depends on  | [F-33](F-33-personal-tokens-pkeyp-packages-read.md)                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [F-35](F-35-publish-public-registries-absorbs-dc-13.md) |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                   |
| Gates       | `threat-model`                                                                                                                                       |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-33.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Goal

Feeds that provision themselves, Customers by default, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, §4.4, for **FX-02**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- Manifest ingest writes dist_registry_owners and dist_registry_feeds for declared package ecosystems at Customers with derived exact-name namespaces; packageFeeds becomes an off switch; feed settings cut to four sections (Upstream, Untagged manifests and the asset-listing fields go; hide-yanked becomes a default); feed access is Public or Customers only: before the feed-level Entitled option goes, each entitled feed's mode and flag move onto every deliverable's dist_access (the stricter-of rule in registry/authorize.ts:14-30,304-330 then holds per deliverable), with a P0-49 report; Packages empty state 'Waiting for the first package...' (UX-33). Existing public feeds are not flipped. Registers its keys through ST-05a (no ST-09 wait).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-02**; DX consolidation I: Packages, updates and packs.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 8 mockup item(s):** `licenses.access`, `packages.feeds-empty`, `packages.feeds-install-refused`, `packages.feeds-off`, `packages.feeds-turn-off`, `packages.feeds`, `packages.portal-packages`, `packages.public-registry`.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Corrections (2026-10-22)

The code is the fact; these replace the brief where they disagree (slice plan `P0-27-F-34-slices.md` §0).

- **E1. Copy debt.** The `debt` list in `packages/admin/test/copy.debt.json` is empty; there is nothing to clear.
- **E2. Feed settings today.** Sections: General, Access, Namespace, Limits, Yank policy, plus the ecosystem panel. Upstream is gone from the UI (the column is pinned to `'none'`, `console/lib/feedModel.ts`). "Untagged manifests" is OCI's `retainUntaggedDays` extension key, "Asset listing" is Godot's `categoryId`, and hide-yanked is Maven's `yankHidesFromIndex` (on by default).
- **E3. No feed-level entitlement flag.** The flag is each deliverable's own `dist_access.entitlement`; a package with no own row inherits the `app` row's mode and has no flag, so licences are refused (fail closed). "Move the mode and the flag" means one own `dist_access` row per package deliverable, mode `entitled`, the existing own flag kept (a null flag stays null).
- **E4. `authenticated` and `licensed` are one strictness** on the ladder (`authorize.ts` step 5); rewriting one to the other changes no answer.
- **E5. A manifest never writes feed rows today** (`registryFeeds.ts`, the manifest `packages` comment, THREAT-MODEL). The system-product bootstrap writes `public`; owner decision O1 keeps the SDK feeds public.
- **E6. `ReleaseAccess` is the wire enum** (`shared-protocol/src/release.ts`) and stays at four values.
- **E7. The Packages nav item shows only while `packageFeeds` is on**; the off and empty mockups need it visible regardless.
- **E8. No install-refusal counter exists**, so `packages.feeds-install-refused` has nothing to read.
- **E9. Writing package rows can flip PS-03's open access** (`openAccessOf`, `access.ts`); the job must report it.
- **E10. No route changes.** The console feed routes are one `${P}/distribution/feeds/**` row and `…/distribution/package-feeds` already exists.
- **E11. UX coverage.** F-34 builds `packages.feeds`, `-empty`, `-off`, `-turn-off`. `-install-refused` needs the missing counter (E8). `packages.portal-packages` was built by F-33; `packages.public-registry` belongs to F-35 and F-38; `licenses.access` to P2-10.
- **E12. New feeds default to Public today** (`console/handlers/feeds.ts`), and the write accepts all four modes.

## Acceptance criteria

- [x] A declared npm package gets a Customers feed with no console step
- [x] Four access options become two, and no principal gains read access in the migration (test)
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/packages/*`; `build/install` (private feeds); `help/packages`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-34 done`.
