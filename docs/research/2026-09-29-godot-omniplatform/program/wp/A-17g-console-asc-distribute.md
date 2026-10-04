# A-17g Console: App Store Distribute flow and App Store products

| Field       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                          |
| Size        | 1–2 engineer-weeks                                          |
| Depends on  | [A-17d](A-17d-asc-distribute.md), [A-17e](A-17e-asc-iap.md) |
| Unblocks    | none                                                        |
| Role        | `pkey-implementer`                                          |
| Plan mode   | no                                                          |
| Gates       | docs help-link drift gate; console CSP parity               |
| Human input | none                                                        |
| Repo        | `vladzaharia/polaris-key`                                   |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17g and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17g: the Distribute flow (T6) in the product's Distribution App Store panel, and
**App Store products** (T2) in Commerce.

## Changes required by S-15

- Distribute's release-notes step edits the shared per-locale notes
  (`dist_listing_release_notes`, A-18b), the same notes every store reads. App Store products
  default their localizations from the model.
- Reuse the console's shared components; capability and status badges are the ones A-18j and F-11
  share.

## Acceptance criteria

- [ ] S-14 §10's A-17g row is met.
- [ ] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17g in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17g done`.

## Corrections (A-17g as built, 2026-10-04)

Where the build departs from S-14 §8.2, §8.3 and §10 and from S-15 §11, the code is the fact:

- **There was no "Distribution App Store panel" and no Commerce page.** P5-02's App Store state
  is a connector card on Outlet credentials, and the commerce map had no console surface. A-17g
  adds two Distribution pages: **App Store** (`distribution/app-store`, the Distribute flow, T6,
  with App Store Connect's versions and review submissions in an aside) and **Commerce**
  (`distribution/commerce`, App Store products, T2). The Outlet credentials App Store card links
  to Distribute. Both pages are documented in a new admin docs page, `/docs/admin/app-store/`
  (the nav's help link and the docs help-link gate); Commerce's help link is the existing
  `/docs/services/distribution/commerce/`. ADMIN.md §2.3, §5.2, §5.9 and §6.4 are amended.
- **Release notes (S-15 §11).** A-18b has not landed, so there is no
  `dist_listing_release_notes` to read or write, and the admin API does not expose a release's
  notes. The step starts from `releaseNotesSeed(releaseId)` (one empty `en-US` row) and keeps the
  draft in `sessionStorage`; App Store products start from `iapLocalizationSeed(product)`. Both are
  marked as the A-18b seam in `ascShared.tsx` and `CommercePage.tsx`. The same per-locale notes
  feed TestFlight's What to Test (Release notes step) and the version's What's New (Version step).
- **Confirmation levels.** Typed with the app's name (L3): submit for review
  (`connector.submitReview`, new), an IAP price change (`connector.iapPriceChange`, new), release,
  phased-release complete and IAP availability (the existing `connector.*` L3 actions, reused).
  Export compliance is L2 (`connector.exportCompliance`): the API cannot change an answer. Every
  other step is L1, S-14 §7.1's "plain confirm". The first IAP price is L1 (`connector.iapPrice`),
  matching the Worker's `initial`.
- **Idempotency.** Every write sends `Idempotency-Key` (a UUID made when the dialog opens and kept
  across retries in it, so a refusal or lost connection resumes the ledger steps); a multi-locale
  save sends its calls under one key. `api.connectorControl` gained the optional key and
  `api.connectorRead` serves A-17d/A-17e's `GET` reads.
- **Release controls on the page** (Release…, phased Pause/Resume/Release to everyone…) use
  P5-02's controls, which take the Polaris Key `releaseId`: they are enabled only when the
  version's build is linked to a release.
- **Shared badges.** The capability and status badge A-18j and F-11 are to share does not exist
  yet (A-18j owns it); A-17g uses the kit's `StatusPill`.
- **Deep links.** A-17f's constant table does not exist (A-17f is todo), so the console's links are
  one table, `ASC_LINKS` in `ascShared.tsx`, for A-17f or A-18j to move into
  `core/storefront/deeplinks.ts`.
- **Not in A-17g:** editing the commerce map itself (`PUT`/`DELETE …/distribution/commerce/products`)
  has no console surface; the App Store products table lists what is mapped and its empty state
  explains mappings. No Worker, route, migration or wire change.
