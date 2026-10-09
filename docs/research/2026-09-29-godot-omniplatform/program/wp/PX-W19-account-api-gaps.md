# PX-W19 Account v2 gaps, Worker and controls (absorbs PX-25)

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)            |
| Size        | 0.4–0.8 engineer-weeks                                                             |
| Depends on  | [PX-W12](PX-W12-sign-in-methods-api.md), [PX-13](PX-13-account-v2.md)              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-31](PX-31-account-composition-v3.md)   |
| Role        | `pkey-implementer`                                                                 |
| Plan mode   | no                                                                                 |
| Gates       | rule 10 (OpenAPI and `routeCoverage`); migration (`00XX_<name>.sql`); THREAT-MODEL |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Id

Filed on 2026-10-07 as "PX-W17". That id belongs to "Identity as a per-product service" (done),
and PX-W18 is taken too, so this package takes the next free Worker-addition id, as README §8
(phase PX) prescribes for later packages.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs PX-25: the Worker and the controls for Make primary, passkey Rename and the products each email brought in, in one package.

- Title: was "Account API gaps for Account v2 (PX-13): `POST /api/me/methods/<id>/primary` (step-up, an own verified email), passkey rename (`name` column, `PATCH /api/me/passkeys/<id>`, `name` in `PasskeyView`), and the products each email brought in on `GET /api/me/methods`".
- Absorbs PX-25: Same three account actions.

## Goal

The three account actions that PORTAL.md §4.26 draws and the Worker does not serve yet exist:
**Make primary** on a verified email, **Rename** on a passkey, and, on each email row, the number
of products that address brought in. PX-13's Sign-in methods page can then draw every row of the
§4.26 table on real data (PX-25 adds the controls).

## Why

PX-W12 shipped the methods API and left these three out on purpose (its brief, "Corrections from
the code": "Not in G27, left for PX-13"). PX-13 is the UI and has no Worker of its own, and its
review and hand-off (2026-10-07) found all three still missing: the Email row's **Make primary** and
"products it brought in", and the Passkeys row's **Rename**, for which `account_passkeys` has no
column ([PX-13](PX-13-account-v2.md), "Follow-ups from the 2026-10-06 reviews").

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [PORTAL.md §4.26](../../../../design/PORTAL.md#426-account) (the Sign-in methods table: the
  Email and Passkeys rows) and [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) (G27).
- `wp/PX-W12-sign-in-methods-api.md` (corrections and hand-off) and `wp/PX-13-account-v2.md`
  (follow-ups).
- `packages/worker/src/services/identity/portal/methods.ts` (`handleAccountMethods`,
  `methodsView`, `removeRefusal`, `removeMethod`); `accounts/links.ts` (the primary-email
  promotion inside `unlinkIdentity`, `STEP_UP_MAX_AGE_SECONDS`, `isFresh`); `accounts/repo.ts`
  (`EMAIL_ISSUER`, `listLinks`, `getAccountRow`).
- `services/identity/passkeys/routes.ts` (`PasskeyView`, `passkeyView`, `removePasskey`) and
  `passkeys/repo.ts`; migrations `0068_a_accounts.sql` (`account_passkeys`) and
  `0094_b_account_passkeys_details.sql`.
- `core/licenseHolders.ts` and `portal/repo.ts` (`attachWaitingLicensesByEmail`,
  `listPortalLicenses`): how a verified address brings licences in (LX-26).
- `packages/worker/openapi/polaris-key.v3.yaml` and `test/routeCoverage.test.ts`
  (`PORTAL_KIND_PATHS`, the PX-W12 and I-16 rows).
- `docs/security/THREAT-MODEL.md`: "Sign-in methods and joining accounts (PX-W12)" and "Passkeys
  on key.plrs.im (I-16)".

## Scope

**In:**

- **Make primary.** `POST /api/me/methods/<methodId>/primary` (no body). The method must be an
  `email` method (the email issuer) on the caller's own account. It needs a fresh sign-in
  (step-up) and becomes the account's primary email.
- **Passkey rename.** A migration adds a nullable `name` column to `account_passkeys`.
  `PATCH /api/me/passkeys/<passkeyId>` with `{name}` sets or clears the name: step-up, a length
  bound, and only the caller's own passkey. `PasskeyView` gains `name`, so `GET /api/me/passkeys`
  and the `passkeys` of `GET /api/me/methods` both carry it.
- **Products per address.** Each `emails[]` row of `GET /api/me/methods` gains `productCount`:
  the number of products that address brought in.
- Rule 10: an OpenAPI operation and a `PORTAL_KIND_PATHS` row for each of the two new routes, and
  the new fields in the `GET /api/me/methods` and `GET /api/me/passkeys` schemas.
- THREAT-MODEL lines and the tests in the acceptance criteria.

**Out** (and where it belongs instead):

- The UI: **Make primary**, **Rename** and the per-address counts on the page (→ PX-25).
- Connected products (`GET` and `DELETE /api/me/products`) and the account export (→ I-11).
- Link an existing account and Approve a new device (→ PX-15, on PX-W12's and PX-W14's routes).
- The AAGUID → provider-name map (→ PX-13's own follow-up).
- Promoting one of the kept account's own addresses after a join's undo (PX-W12's hand-off
  follow-up; it can reuse this package's write, but it is not in this scope).

## Design notes

- **Rule 10:** each new route gets its OpenAPI operation and a `routeCoverage` entry in the same
  change. The paths are `/api/me/methods/{methodId}/primary` (post) and
  `/api/me/passkeys/{passkeyId}` (patch beside the existing delete).
- **Make primary, request.** It sits in `handleAccountMethods` as
  `rest.length === 2 && rest[1] === "primary"`, after the session and CSRF checks every
  `/api/me/methods` route already gets. A stale session answers PX-W12's `step_up_required`
  (401, `maxAgeSeconds`). The change shares the `portalMethodChange` limit (10 a minute per
  account).
- **Make primary, which method.** An unknown id and another account's id answer the same
  `404 not_found`. The caller's own method of another kind (a passkey, a provider) answers
  `422 bad_request`. A provider's address is never an email method. An email method exists only
  once its address is verified: PX-W12 connects an address only after its code, and I-07's email
  sign-in proves it. Confirm against the code that no path writes an unverified `email` link. If
  one does, refuse such a link here and record it in this brief.
- **Make primary, write.** It sets `accounts.primary_email` to the link's subject and
  `primary_email_verified_at` to the link's `created_at`, as the promotion in
  `accounts/links.ts` does. It is one conditional statement that holds only while the link still
  belongs to the account (a compare-and-set), so a removal racing it cannot leave a primary with
  no method. When the method is already primary, the request answers `200` and writes nothing:
  no audit and no notice.
- **Make primary, consequences.** The primary is where security notices go. Products read it
  through the consent view's `email` (`passthrough/routes.ts`), and developers read it through
  the product-user contact (`accounts/productUsers.ts`). A change therefore writes an audit row
  and sends a security notice (PX-W7's templates) to every verified address on the account, the
  old primary included. The answer is the same body as `GET /api/me/methods`, so the page
  re-renders from one response.
- **Rename, the column.** `ALTER TABLE account_passkeys ADD COLUMN name TEXT`. Name the file
  `00XX_account_passkeys_name.sql`; the lead assigns the number at merge (CLAUDE.md), and
  `test/recordDeploy.test.ts` refuses the file until then. `LATEST_MIGRATION` and the data-model
  page follow the number. The table already has an owner (identity), so `TABLE_OWNERS` does not
  change. A merge moves passkey rows whole and its undo moves them back by id, so the name
  travels with the row. Check that statement against `accounts/merge.ts` and `mergeUndo.ts`.
- **Rename, the request.** `{name: string | null}`, with the body read capped
  (`readBodyCapped`). The name is trimmed and must be 1 to 64 characters with no control
  characters; anything else answers `422 bad_request`. `null` or an empty string clears the
  name. An unknown passkey id and another account's answer the same `404 not_found`. The change
  needs step-up and shares `portalMethodChange`. It writes an audit row with no name in the
  summary. It sends no email notice: it changes a label, not a way to sign in.
- **Rename, the view.** `PasskeyView.name` is `null` when unset. In the methods list,
  `displayOf` prefers `name`, then `addedFrom`. The name is shown only to its owner, as text. It
  never goes into an email or an HTML template.
- **Products per address.** `productCount` counts the distinct products among the account's
  licences (`licenses.account_id`; deleted products and portal-off products excluded, as the
  Library excludes them through `groupedLicenses`) whose own `email` matches the address,
  compared case-insensitively. That is the licence `email` through which LX-26's
  `attachWaitingLicensesByEmail` brought it in. Use one grouped query for all of the account's
  addresses (`idx_licenses_email_lower`), not one per row. Return only the count; the Library
  lists the products.

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

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`;
   verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W19:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W19 in-review`.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `portal.activate`, `portal.account`.

## Acceptance criteria

- [ ] Make primary: the caller's own verified email becomes the primary
      (`primary_email` and `primary_email_verified_at`). The change is audited, and every
      verified address, the old primary included, gets a notice (tests).
- [ ] Make primary is refused with `step_up_required` on a stale session. An unknown id and
      another account's method id get the same `404`. The caller's own non-email method gets
      `422`. An already-primary address gets `200` with no write, audit or notice (tests).
- [ ] A method removed between read and write leaves the primary unchanged (compare-and-set test).
- [ ] Rename: the migration adds `name`. `PATCH` sets and clears it, with step-up, the length and
      control-character bound (`422`), and the same `404` for an unknown passkey and another
      account's. `name` appears in `GET /api/me/passkeys` and in `GET /api/me/methods` (tests).
- [ ] `productCount` per email row counts distinct products whose licences carry that address
      (case-insensitive) and leaves out deleted and portal-off products (test).
- [ ] OpenAPI and `routeCoverage` cover both new routes and the new response fields.
- [ ] THREAT-MODEL: "Sign-in methods and joining accounts (PX-W12)" gains a line for Make primary
      (step-up, own verified email only, compare-and-set, notice to every verified address,
      products see the new address on their next read). "Passkeys on key.plrs.im (I-16)" gains
      one for Rename (owner-only, bounded, rendered as text, never in mail).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
      State the migration's placeholder name in the hand-off.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- methods passkeys routeCoverage
```

## Hand-off

PX-25 adds the controls on PX-13's page. PX-19 documents sign-in methods.

The role agent sets `--set PX-W19 in-review` when it hands off. After review, the lead adds the
last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W19 done`.
