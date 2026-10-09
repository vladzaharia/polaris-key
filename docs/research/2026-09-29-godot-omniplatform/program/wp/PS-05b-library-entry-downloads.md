# PS-05b Storefront library entries: downloads and listing (Worker): a shown library entry opens the downloads view, the download-token mint and redemption for `public` and `authenticated` deliverables only, and the entry's product view carries `description`, `screenshots` and `shortDescription`

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 2: engine and portal)                     |
| Size        | 0.4–0.8 engineer-weeks                                                                                                    |
| Depends on  | [PS-04](PS-04-storefront-portal-api.md), [PS-05](PS-05-storefront-portal-ui.md), [A-26](A-26-customer-channel-actions.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-32](PX-32-storefront-decision-panel.md)                                       |
| Role        | `pkey-implementer`                                                                                                        |
| Plan mode   | no                                                                                                                        |
| Gates       | rule 10 (OpenAPI and `routeCoverage`); THREAT-MODEL                                                                       |
| Human input | none                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                 |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Library entry downloads read A-26's customer channel actions and reuse P2-13's channel picker.

- Depends on: added A-26.

## Goal

An open product someone added to their Library (a `library_entries` row, PS-04) can be
downloaded from its page. A shown entry counts beside a linked licence at every portal download
gate, for deliverables in delivery mode `public` or `authenticated` only. The entry's product
view carries the listing text and screenshots that the storefront page shows, so its page is more
than a name.

## Why

S-21 §6.4 says an entry is shown in the Library "with 'Free to use' and Get it", and §6.5 says
"its page shows Get it and the listing". PS-04 built entries, but every download gate still asks
`hasLinkedProductLicense`, so an entry gets the stranger's `404` everywhere. `GET /api/products/<p>`
for an entry also carries only the presentation. PS-05's hand-off (2026-10-07) found both gaps.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block, §6.3 (the
  `open` path: licence service off and every deliverable `public` or `authenticated`), §6.4, §6.5
  and §6.9.
- `wp/PS-04-storefront-portal-api.md` (corrections) and `wp/PS-05-storefront-portal-ui.md` (as
  built and hand-off).
- `packages/worker/src/services/identity/portal/library.ts` (`shownEntries`, `entryFields`,
  `entryProductView`, `productView`).
- `portal/api.ts`: `hasLinkedProductLicense`, `accountMayDownload`, `downloadTarget`,
  `MINT_REFUSAL`, `handleReleases` (the token branch), `handleEmailDownload` and
  `handlePortalDownload`. Also `portal/downloads.ts` (`handleProductDownloads`,
  `productDownloads`, `PortalFileReason`).
- `portal/discover.ts`: the storefront product page's `description`, `screenshots`
  (`screenshotUrlsFor`) and `shortDescription` (the listing's `subtitle`).
- `packages/worker/openapi/polaris-key.v3.yaml` (`/api/products/{product}`) and
  `test/routeCoverage.test.ts`.
- THREAT-MODEL "Discover: free offers and "Add to library" (PX-W10, PS-03, PS-04)" and "Licensed
  portal downloads (PX-W3)".

## Scope

**In:**

- **One access predicate.** Add a single-product check for a shown entry beside
  `hasLinkedProductLicense` (from `shownEntries`: the entry exists, the account holds no licence
  for the product, the product exists and the portal is on for it). Every portal download gate
  then asks "a linked licence or a shown entry":
  - the downloads view, `GET /api/products/<p>/downloads` (`handleProductDownloads`);
  - the download-token mint, `POST /api/releases/<p>/<release>/artifacts/<artifact>/token`
    (`handleReleases`);
  - redemption, `GET /download/<token>` (`handlePortalDownload`), for the token's account;
  - "Email me the download", `POST /api/products/<p>/email-download` (`handleEmailDownload`).
    This is the fourth `hasLinkedProductLicense` site, verified against the code on 2026-10-07.
    It follows the same rule so the page never offers a button that one route refuses.
- **`public` and `authenticated` only.** After the gate, `accountMayDownload` decides per release,
  as it does now. An entry account holds no licence for the product, so `licensed` and `entitled`
  answer false. Keep that true by construction, and test it.
- **The entry's product view.** `GET /api/products/<p>` for an entry gains `description`,
  `screenshots` and `shortDescription`. Read them from the product's listing with the same
  helpers `GET /api/discover/<p>` uses (`null` and `[]` when the listing lacks them); share the
  helpers rather than copy them. The OpenAPI schema for `/api/products/{product}` gains the three
  fields.
- THREAT-MODEL line and the tests in the acceptance criteria.

**Out** (and where it belongs instead):

- The portal UI: the entry page's Get it and listing (→ PS-05 and its follow-ups).
- The account-wide release listing, `GET /api/releases` (`listLinkedProducts`): it lists products
  with a linked licence, and entries stay out of it. Raise a follow-up if PS-05's Downloads tab
  needs them.
- The licence product view's listing fields (not asked for).
- Any change to which products can become entries (PS-03's `open` path).

## Design notes

- **Rule 10:** no new route. The changed response (`/api/products/{product}`) is updated in the
  spec in the same change, and `routeCoverage` stays green.
- **Refusal reasons.** For an entry, a file on a `licensed` or `entitled` deliverable reads
  `license_inactive`, both in the listing and in the mint's refusal (`MINT_REFUSAL`). The portal
  draws that as "Needs an active license". `not_entitled` claims a licence exists, so an entry
  never gets it. There is no new `PortalFileReason`, so the shipped portal needs no new copy.
- **Order of checks and limits are unchanged.** The three portal and Release gates come first,
  then ownership (now a licence or a shown entry), then the per-product limit (`portalDownloads`,
  `portalDownloadToken`, `portalEmailDownload`), charged only once ownership is proven (R5-05).
  A caller with neither a licence nor a shown entry gets the same `404` as today.
- **Redemption re-checks.** `handlePortalDownload` reads the delivery mode live. A token minted
  for an entry is refused at redemption if the deliverable has since become `licensed` or
  `entitled`, if the entry was removed, or if the portal was turned off.
- **THREAT-MODEL line** (Discover: free offers and "Add to library"): an entry opens portal
  downloads only for `public` and `authenticated` deliverables; the mode is read live at listing,
  mint and redemption; `licensed` and `entitled` still need a usable licence; an entry made while
  the product was open grants nothing once a deliverable is made `licensed`; a stranger still
  learns nothing.

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

1. Re-read the S-21 sections above; verify this brief against the code and record any correction
   here.
2. Implement the **In** list in small commits prefixed `PS-05b:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-05b in-review`.

## Acceptance criteria

- [ ] An account with a shown entry and no licence downloads a `public` and an `authenticated`
      deliverable. The downloads view offers the file, the mint answers a token, redemption
      serves it, and "Email me the download" sends (tests).
- [ ] An entry for a product whose deliverable is `licensed` (and one that is `entitled`) is still
      refused. The listing marks the file `license_inactive`, the mint refuses with
      `license_inactive`, and a token minted while the deliverable was `authenticated` is
      refused at redemption once it becomes `licensed` (tests).
- [ ] An entry that is not shown (removed, product deleted, portal off), and a caller with
      neither entry nor licence, get the same `404` at all four routes (tests).
- [ ] `GET /api/products/<p>` for an entry carries `description`, `screenshots` and
      `shortDescription`, matching `GET /api/discover/<p>` for the same listing (test). OpenAPI
      is updated; `routeCoverage` passes.
- [ ] THREAT-MODEL carries the line above.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal routeCoverage
```

## Hand-off

PS-05's entry page can draw Get it and the listing on these answers. PS-11 documents it.

The role agent sets `--set PS-05b in-review` when it hands off. After review, the lead adds the
last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-05b done`.
