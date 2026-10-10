# I-09 license_owned refusal, attach and sign-out (consolidated spec)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                        |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md), [ST-04](ST-04-settings-resolver.md), [I-27](I-27-plan-identity-consolidation.md)                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-08](I-08-app-passthrough.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-24a](I-24a-named-user-seats-server.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md), [LX-10](LX-10-anchor-choice.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                         |
| Plan mode   | yes: executes the approved [`plans/I-09.md`](../plans/I-09.md), as [`plans/I-27.md`](../plans/I-27.md) (2026-10-08) §3 and §7.2 amend it, refining [`plans/I-04.md`](../plans/I-04.md)                                                                                                                                                                                                                        |
| Gates       | plan mode; `errors.json` (rule 3); transcripts (rule 1); `gen constants --check`; rule 9 (validator rules, mutation table, schema) and `bundle:action -- --check`; rule 10 (OpenAPI + `routeCoverage`); D1 migration; `TABLE_OWNERS`; THREAT-MODEL                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                     |

## Goal

An owned licence never moves by key: key entry of an in-account licence on a device not enrolled on it answers `license_owned` with `signInUrl`. A signed-in device can attach its floating licence (`POST /<p>/identity/attach`), read its pairwise subject and sign out. Sign-in binds a device only to the licence the person chose. The `identity:` manifest block declares the key-entry, terms and redirect-path settings in their final shape. All of it runs only while the product's Identity service is on, and existing installs are never affected.

## Why

The owner made the legacy key flow a limited on-ramp to accounts ([S-16 owner decisions](../../notes/S-16-identity-service.md)), only for products with Identity on: without Identity a key is the app's only activation path. A new refusal on an existing device route is plan mode ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)). I-09 is second in the W-ID train (I-27 → I-09 → I-08) and gives I-08 `rankAnchorCandidates` and `bindSignedInDevice`.

Sources: [`plans/I-09.md`](../plans/I-09.md) (approved 2026-10-05, every recommendation accepted), [`plans/I-27.md`](../plans/I-27.md) §3, §7.2 and Q4, [`plans/I-04.md`](../plans/I-04.md) §2.2, §2.3, §F, [`plans/PX-W9.md`](../plans/PX-W9.md), [`plans/PX-W8.md`](../plans/PX-W8.md) and [`plans/I-24.md`](../plans/I-24.md); the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md).

## Read first

- `AGENTS.md` (always), `CLAUDE.md` (plan mode), and the skill `authoring-pkey-manifests`.
- [`plans/I-09.md`](../plans/I-09.md) §2–§7 and its two owner-decision sections; [`plans/I-27.md`](../plans/I-27.md) §3 and §7.2.
- `packages/worker/src/services/license/activation.ts:153`, `packages/worker/src/core/devices.ts`, `packages/worker/src/services/license/enroll.ts:63`, `conformance/parity/errors.json`, `tools/services.json`.

## Scope

**In:**

- **Step 3 of key entry (WIRE-CONTRACT-V4 §12.2, which PX-W9 wrote with step 3 reserved).** On `POST /<p>/license/activate` and `POST /<p>/identity/session/license`, after the enrolled-device check: if `licenses.account_id IS NOT NULL`, answer `403 license_owned` with `signInUrl` = `<origin>/signin?product=<slug>` (a root path, from PX-W8's builder). It runs before PX-W9's step 4 (the counter and `key_entry_limit`), only with Identity on and while `identity.keyEntryRefusals` (PX-W9's platform switch) is on; I-09 adds its own reader for it and registers nothing. Nothing is counted. Re-entry on an enrolled device and existing installs keep working.
- **`license_owned` everywhere an owned licence would move by key:** on attach and on the portal's Activate License path, for every product (the platform claim rule, not a key-entry refusal).
- **Attach, subject and sign-out (§12.3).** `Authorization: Bearer pkeyt_…` and `X-PKey-Device`, `no-store`, CORS for `core.web.origins` without credentials; Identity off answers `404 not_found`.
  - `POST /<p>/identity/attach` `{confirm}`. The holder is `accountForSubject(resolveSubject(devices.subject))`, never `licenses.account_id`; none answers `403 account_required`. `confirm: false` answers `200 {status: "confirm", license: {id, tierId, name|null}}` and writes nothing; `confirm: true` calls `attachLicenseAccount`, rotates the token and answers the activation response plus `subject` and `"attached": "claimed"`. Refusals: `license_owned` (another account; no `signInUrl`), `license_email_bound` (a buyer email with no matching verified email, unless `identity.keyEntry.claimByKey`), `404 not_found` (no licence on the device). Attach never changes the device's anchor.
  - `GET /<p>/identity/subject` answers `{subject: "ps_…" | null}`.
  - `POST /<p>/identity/signout` runs `clearDeviceSubjects(…, "signout")` and answers `{released}`; `released` is true only for a `bound_by = 'signin'` device whose anchor belongs to the signed-out account, which is then deauthorized.
- **Discovery (§12.6, I-09's part).** With Identity on: `"account": true`, `"keyEntryLimit"` (from PX-W9's `keyEntryLimit()`, so the published value is the enforced one) and the endpoints `attach`, `subject`, `signout` and `accountPortal` (`<origin>/#/p/<slug>`). Recorded in a new `discovery-identity.json`.
- **Sign-in licence choice (`core/anchor.ts`).** `rankAnchorCandidates(db, product, accountId, now)` returns the ordered candidates with their seat state (full licences listed as `full`, never hidden), the device's own candidate marked `current`, `keep` only for a licence outside the candidates, `create` and `preselected` (the current row, else Keep, else the first free row; a higher rank never preselected over the current licence; every tier ranks 0 until LX-08's `tiers.rank`). `bindSignedInDevice(…, choice)` binds only to the explicit choice, sets `devices.subject` with `bound_by = 'signin'`, and mints only when there is no candidate or on `kind: "create"`. A device already running on a usable licence keeps it. LX-10 later swaps the body without changing the signature; I-24a uses the candidate hook for seat holders.
- **Sign-in licences.** `licenseAccess(db, license)` in `core/anchor.ts` (the fact behind the origin "From signing in" and the mixed rule, never a displayed type), and `access` on `shapeLicenseSummary`. Sign-in licences stay device-limited, so `authorizeDevice` does not change.
- **`enrollFate`** (`services/license/enroll.ts:63`) answers `claimed` when `row.sub !== null || row.account_id !== null`.
- **The `identity:` manifest block (I-27 §3, Q4),** in its final nested shape, persisted as claimable `product_settings` rows (ST-01b's table): `identity.keyEntry.limit` (1 to 100, default 10; `IDENTITY_KEY_ENTRY_LIMIT` in `shared-manifest`), `identity.keyEntry.claimByKey` (read through a column adapter on `portal_product_settings.claim_by_key` until ST-14), `identity.terms {version, url?}` and `identity.redirectPaths` (critical). Rules, each with a mutation-table row and the schema change: `invalid_identity` (allows `keyEntry`, `terms`, `redirectPaths`), `invalid_identity_terms`, `invalid_identity_key_entry_limit`, `invalid_identity_claim_by_key`, `invalid_identity_redirect_paths`, and the warnings `identity_redirect_paths_without_origins` and `identity_block_without_service`. `invalid_oidc` no longer fires just because Identity is on without an `oidc` block. `identity.native` and `identity.requireTerms` are never registered. Drop `pending` on `identity.keyEntry.limit`.
- **A terms reader** answering a `TermsRequirement` (`{url, version}`) or `null`, passed as `product.terms` into `beginProviderSignIn` wherever a product-context sign-in starts from I-09's surfaces (the `signInUrl` card). Acceptances live in `account_terms_acceptances`.
- **Verified email.** Each verification point I-09 adds calls `onAccountEmailVerified`; whichever of I-08 and I-09 lands second drops the per-request sweep from `portal/api.ts`.
- **Contract artefacts.** WIRE-CONTRACT-V4 §12 opens (§12.1, step 3 in §12.2, §12.3, I-09's part of §12.6), a §8 registry row for the pairwise subject and a §9 sentence; `@polaris-key/protocol/identity` (`IdentityDiscovery`, `LicenseOwnedBody`, `AttachRequest`, `AttachPreview`, `AttachResult`, `SubjectResponse`, `SignOutResponse`, `PAIRWISE_SUBJECT_PATTERN` moved from the Worker). `errors.json`: `license_owned`, `license_email_bound`, `account_required` (I-09's own codes only). Transcripts `keyentry-owned.json`, the attach, subject and sign-out transcripts (the attach one, `identity-attach.json`, seeded until I-08 re-records it; its text records `profile.user = {"subject": "ps_…"}` in the licence document from the start, as approved `plans/SP-54.md` (2026-10-09) says: the signed-in device's document carries the member, so SP-54 adds no rows to this transcript later) and `discovery-identity.json`; the `identity.keyentry` parity note gains `license_owned`. OpenAPI and `routeCoverage` for the three routes; table owner `core`.

**Out** (and where it belongs instead):

- The key-entry counter, `key_entry_limit`, `keyEntries`, `keyentry-limit.json`, `keyentry-identity-off.json` and `keyentry-refusals-off.json` (→ PX-W9, done); flipping `license_owned` per product (→ LX-39).
- The card, the choice API and the first automatic licence (→ I-08); SDK handling and kit screens (→ I-10a, I-10b); the portal's Activate License modal (→ I-11); `methods`, `connections` and `claims` in the manifest block (→ I-35).

## Design notes

- **Settings as rows (S-18).** No `identity_product_settings` table.
- **Existing installs are never affected:** tokens, refresh, offline grace and the signed licence document stay as they are; a test proves attach, sign-in binding and counting leave every document's content unchanged.
- **Neither refusal is an auth failure.** The URLs never carry the key; a device that already holds a token for the licence never sees either.
- **With Identity off,** devices behave exactly as today: key entry of an owned licence on a new device is still accepted.

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

1. Contract text, `shared-protocol` types and `errors.json` codes.
2. Step 3, attach, subject and sign-out, with tests.
3. `rankAnchorCandidates`, `bindSignedInDevice` and `licenseAccess`.
4. The manifest block and its rule-9 rows; discovery; transcripts; OpenAPI.

## Acceptance criteria

- [ ] Key entry of an owned licence on a new device answers `license_owned` with `signInUrl`; re-entry on an enrolled device still succeeds; nothing is counted (tests).
- [ ] With the Identity toggle off, activation behaves exactly as before (tests against the existing transcripts).
- [ ] Attach refuses an owned licence, and an email-bound licence without a matching verified email unless `claimByKey`; attach never changes the anchor (tests).
- [ ] No second automatic licence is minted while a usable one exists, and `rankAnchorCandidates` lists full licences as `full` (tests).
- [ ] `enrollFate` answers `claimed` for an `enroll` licence in an account with no `sub` (test).
- [ ] Every new manifest rule has its mutation-table row and schema change; `bundle:action -- --check` passes.
- [ ] Transcripts recorded; `errors.json`, OpenAPI and `routeCoverage` updated; `PROTOCOL_VERSION` unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license activation identity attach enroll
mise exec node@22 -- pnpm --filter @polaris-key/shared-manifest test
mise exec node@22 -- pnpm gen transcripts --check
```

## Hand-off

I-08 builds the card on `rankAnchorCandidates` and `bindSignedInDevice`; I-10a and I-10b surface `license_owned`, attach, subject and sign-out in every SDK and kit; I-11 builds the Activate License modal; I-35 adds the rest of the `identity:` block.

The role agent sets `--set I-09 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-09 done`.
