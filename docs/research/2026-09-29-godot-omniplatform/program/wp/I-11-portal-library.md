# I-11 Account data lifecycle: export, removal, support code, revocation hook

| Field       | Value                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                        |
| Size        | 1.6–2.25 engineer-weeks                                                                                                                                                                       |
| Depends on  | [I-05](I-05-accounts-core.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md)                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [I-34](I-34-granular-consent-connected-apps.md), [U-12](U-12-privacy-settings-portal.md) |
| Role        | `pkey-implementer`                                                                                                                                                                            |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                      |
| Gates       | D1 migration; `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; privacy docs; console CSP parity                                                                             |
| Human input | none                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-24.md`](../plans/I-24.md):** the seat panels (holders, invites at the root path `/join/<token>`).
- **[`plans/I-09.md`](../plans/I-09.md):** the portal Activate License surface counts through PX-W9's `core/keyEntries.ts` with surface `portal`.
- **[`plans/PX-W8.md`](../plans/PX-W8.md) and owner:** portal paths are root paths (`/activate`, `/signin`), not `/portal/…`.
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** `/signin` reads `error=identity_disabled`.

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Download my data includes the profile** ([PX-W16](PX-W16-profile-avatars.md)). The full export
  carries the account's profile: `display_name` and `locale`, the picture in use and every copied
  or uploaded avatar (`account_avatars`, the renditions `/media/avatar/<asset>` serves), each
  value's source and explicit flag (`details_source_json`), and each sign-in method's import
  (`account_links.profile_json`). The portal's `YourData` section has no export yet; its comment
  still points at "I-15's export", an id from before the re-cut. The full export is this package's.
- **A merge must keep the survivor's explicit Initials** ([PX-W16](PX-W16-profile-avatars.md)). Still
  open on `main`: `mergeAccounts` (`accounts/merge.ts`) fills the survivor's `avatar_key` from the
  absorbed account with `COALESCE`. A survivor that chose Initials (no `avatar_key`, and
  `details_source_json` says `picture: { source: "initials", explicit: true }`) therefore takes the
  absorbed account's picture,
  and its record disagrees with itself. `fix/followups-sweep-1006` owns the fix. If it has landed
  when this package starts there is nothing to do; otherwise the link-existing-account merge's
  tests pin it.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Narrowed to the account data lifecycle (C-44): per-product export and removal, the support code, full export, soft deletion and the one Core revocation hook. Library, Discover, Activate and account settings already shipped (PX-02..PX-24, PS-04/05). Connected apps move to I-34.

- Title: was "Portal as the Library: Library, Discover (Add to library), Activate License modal, product pages with a reserved Cloud Sync section, account settings (sign-in methods, Profile, devices and sessions, connected apps), export and deletion, the one Core revocation hook".

## Goal

The customer portal becomes the account's home, a proto-Steam Library: Library (default), Discover with "Add to library", the Activate License modal, product pages with a reserved Cloud Sync section, and account settings (sign-in methods, Profile, devices and sessions, connected apps, privacy), with per-product and full export and deletion. It owns the one Core revocation hook.

## Why

The owner chose a Steam-like account home ([S-16 owner decisions](../../notes/S-16-identity-service.md)); the portal is a platform concern for every product (G10, D7). The account is platform-level, part of Core and the portal, and never a per-product toggle (owner, 2026-10-04), so everything here runs for every product whether or not its Identity service is on. The Activate License modal is where key entry turns into accounts, and the Library must be live before S-17's migration notice starts ([S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block: portal, the 2026-10-04 account/service split and key-entry limits only with Identity on), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes) (registry tokens), [S-16 §5.7](../../notes/S-16-identity-service.md#57-portal-surface), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-11, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 12; [S-17 §5.15](../../notes/S-17-user-data-sync.md#515-how-it-composes) (portal).
- [`plans/F-20.md`](../plans/F-20.md) and the F-21 brief; `packages/worker/src/services/identity/portal/{session,repo,api,auth}.ts`; `docs/design/BRAND.md`.

## Scope

**In:**

- **Library:** every licence attached to the account, grouped by product: tier, entitlements, devices (with remove), downloads, support link. Floating licences appear only once attached.
- **Discover:** products whose auto-issue policy makes this account eligible; Add to library mints the licence through the sign-in auto-issue path.
- **Activate License modal:** paste a key; if not signed in, each entry prompts the account upgrade; the licence then attaches under the claim rules; `/activate?product=<slug>` deep links preselect the product. **For a product with Identity on**, entries count (D20) and the prompt is skippable while entries remain and forced at the limit. **For a product without Identity** (owner, 2026-10-04), entries are not counted and the upgrade is always offered and never forced, because the key is that app's only activation path.
- **Product page:** licence details, devices, downloads, the person's short support code for this product (their pairwise subject's support form, which the developer's relink tool accepts; I-12), shown for every product so Identity-off products have a relink path (created only by an explicit, rate-limited "Get a support code" action; a subject with no licence, sign-in or data is not listed on the console's Users page, S-16 §5.2), export my data for this product, remove my data from this product (with "also remove the licence from my Library", D25, accepted), and a reserved Cloud Sync section shown only when the product has that service on (filled by U-12).
- **Account settings:** sign-in methods (connect and disconnect under step-up, last-method guard, audited and emailed; link-existing-account merge; QR sign-in on another device), Profile (choose a linked provider's name or picture, or upload), devices and sessions with sign out everywhere, connected apps (products the person continued to through passthrough, D22) with consented claims and revoke, privacy (full export; account deletion soft for 14 days, then hard).
- Per-product and full export and deletion call I-05's deletion registry (Cloud Sync and account overrides hook, U-12).
- The one Core revocation hook (licence detached or account deleted) against I-04's contract; extend F-21's if it landed first.

**Out** (and where it belongs instead):

- The Cloud Sync section's content (→ U-12); console pages (→ I-12).

## Design notes

- **Portal UI follows the brand system** (`docs/design/BRAND.md`, and `docs/design/PORTAL.md` once it lands); do not invent a parallel design.
- F-21 is a soft dependency only: whichever lands first writes against I-04's hook contract ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 12).
- Cloud Sync appears only on product pages of products with the service; never a global Cloud Sync page. A product with Cloud Sync always has Identity on, because Cloud Sync needs sign-in (owner, 2026-10-04, final answers).
- The link-existing-account merge follows D21 (accepted): the survivor's pairwise subject wins per product, the other becomes an alias, the developer gets `subject.merged`.
- Account deletion: removes the account and all links, cascades to sessions, passkeys, grants, personal details and R2 avatars, every pairwise subject and all account × product data, detaches licences (D27, accepted pending a legal review), scrubs audit rows to a tombstone id, and records a tombstone re-applied after any D1 restore ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. API and data for Library, Discover and product pages.
2. Activate License with the upgrade prompt and limit.
3. Account settings, merge flow and sessions.
4. Export, deletion and the revocation hook.

## Acceptance criteria

- [ ] For a product with Identity on, at the entry limit the modal cannot be skipped and the licence attaches only under the claim rules (tests).
- [ ] For a product with Identity off, entries are never counted and the upgrade prompt can always be skipped (test).
- [ ] Add to library mints a licence only for eligible auto-issue products (test).
- [ ] The product page shows a support code the console's relink tool accepts, for a product with Identity off (test).
- [ ] Removing the last sign-in method is refused; every link change needs step-up and sends an email (tests).
- [ ] Per-product removal deletes account × product data and the subject but keeps the licence unless chosen (test).
- [ ] Account deletion cascades as above and survives a simulated restore through the tombstone list (test).
- [ ] Detaching a licence revokes F-20 licence-bound tokens through the one hook (test).
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): `help/your-data` (self-serve export); the export task in `operate/console/help-a-customer`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal identity revocation
```

## Hand-off

- U-12 fills the Cloud Sync section and the export and deletion hook; U-03's migration notice starts only once I-07 and I-11 are live.

The role agent sets `--set I-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-11 done`.
