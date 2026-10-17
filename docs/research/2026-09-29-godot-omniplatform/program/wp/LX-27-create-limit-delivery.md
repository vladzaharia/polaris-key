# LX-27 Create a licence: device limit and invitation delivery

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                                                                           |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                                       |
| Depends on  | [LX-14a](LX-14a-per-license-device-limit.md), [LX-26](LX-26-licence-holders-worker.md), [I-18](I-18-email-delivery.md), [P0-21](P0-21-notification-substrate-core-notify.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-29](LX-29-new-license-wizard.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md)                                     |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; email snapshots; workerd                                                                                                  |
| Human input | none (the sending domain is I-18's)                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **A "from <Developer>" variant of the library notice** ([LX-26](LX-26-licence-holders-worker.md),
  review note N1). `licenseAddedNotice` (`portal/notices.ts`, "<Product> is in your library") is
  sent only on a portal key claim (`portal/selfService.ts`), and its copy says the licence was added
  "with a license key", which is false for an association by email. So an email attach
  (`via: "email"`) sends nothing today. When the account has already verified the address at
  creation, this package's key email ("Your <Product> license", sent in the create request) is the
  person's message. For an association that happens later, at the address's first verification
  (`onAccountEmailVerified`), add a variant that says the licence came from the developer ("From
  <Developer>", the origin wording of S-24 D21) and send it on that attach.

## Follow-up from LX-30 (2026-10-06)

LX-30 shipped before this package, so it could not wire the two console entry points that call
`send-key`. They move here, beside the route:

- **Send a new key…** in the overflow of an assigned licence's record (`LicenseRecord.tsx`), with
  **Also revoke its other keys** (`revokeOthers`), the 10-minute refusal shown inline, and its
  mutation entry (`mutations.ts`, ADMIN.md §5.4).
- **Email them the key** on the record's **Assign…** dialog (`LicenseHolderDialogs.tsx`): after the
  `PATCH` assigns the licence, a ticked box calls `send-key` (a new key, D12), off by default.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Email through core/notify (P0-21), not identity/portal/email.ts (rule 6). On Identity products delivery defaults to an invitation (sign-in link, no key); 'Also create a key' is optional; with Identity off it keeps minting a key.

- Title: was "Create a licence with a device limit and delivery: `deviceLimit` and `delivery.email` on create (lifting LX-14a's create refusal), the "Your <Product> license" key email sent in the create request, and **Send a new key** (`POST …/licenses/<id>/send-key`)".
- Depends on: added P0-21.

## Goal

An operator creates a licence with its own device limit and, for an assigned licence, has Polaris
Key email the key to the holder in the same request; later they can send a fresh key without ever
seeing the old one again.

## Why

The New License wizard's Limits and Delivery steps ([S-24](../../notes/S-24-licence-holders.md)
§8.4) need both. LX-14a adds `licenses.device_limit` but refuses it on create (its commit
`e755e88f1`), and nothing is sent on create today (H3). Keys exist in plaintext only in the create
response (`W/crypto.ts`), so the email must be sent there or with a newly minted key (D12).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §6.3, §7.1, §8.4 (D11, D12).
- [LX-14a](LX-14a-per-license-device-limit.md) (precedence, validation) on `wp/LX-14a-device-limit`.
- `packages/worker/src/services/license/admin/licenses.ts`, `services/identity/portal/email.ts`,
  `portal/notices.ts` (templates and sender, PX-W7), I-18's sender setup.

## Scope

**In:**

- `POST …/license/licenses` accepts `deviceLimit` (positive integer or absent; LX-14a's rule) and
  `delivery: {email: boolean}`, valid only with an `email`. The answer gains
  `delivered: {email: "sent" | "queued" | "failed"}`.
- The **"Your <Product> license"** email: sender "<Product> via Polaris Key" (I-18), the holder's
  name when given, the key, **Open in Polaris Key** (a portal sign-in link for that email, never a
  link that signs in by itself), the product's download link when it has one, and one line on what
  to do with the key. Plain-text and HTML parts; snapshot tests.
- `POST …/licenses/<id>/send-key` `{revokeOthers?: boolean}`: mints a new key (label "Sent by
  email"), emails it to the licence's `email`, optionally revokes the other active keys in the same
  batch; one per 10 minutes per licence (`429 rate_limited` with `retryAfter`); refused on a floating licence with the existing `400 bad_request`.
- Audit: `license.create` records `delivery`; `license.key.send` with the key's label and whether
  others were revoked.
- OpenAPI and `routeCoverage`.

**Out:**

- The console steps (→ LX-29). The record's two `send-key` entry points are now in scope here (the
  LX-30 follow-up above).
- Emailing a floating key (never; D11). Scheduled emails (later).

## Design notes

- A failed send never rolls back the licence: the answer says `failed`, the console offers **Try
  again** through `send-key`, which mints a new key (the first one stays valid unless revoked).
- The key appears only in the email body and the one response; never in logs, audit summaries or
  the email's subject.
- THREAT-MODEL: one row under licence administration ("an operator can email a key to the
  licence's address; rate-limited and audited").

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

1. Lift LX-14a's create refusal; validate and store `deviceLimit`.
2. Template, snapshot tests, the create-time send.
3. `send-key` route, rate limit, audit, OpenAPI.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `licenses.bulk-keys-done`, `licenses.bulk-keys`.

## Acceptance criteria

- [x] Create with `deviceLimit` stores it and the effective limit follows LX-14a's precedence (test).
- [x] Create with `delivery.email` sends exactly one email containing the key; without an email it
      is refused (tests, snapshot).
- [x] `send-key` mints, emails and optionally revokes, at most once per 10 minutes (tests).
- [x] No key appears in audit rows or logs (test).
- [x] The green gate passes (AGENTS.md), including OpenAPI and `routeCoverage`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license email routeCoverage
```

## Hand-off

LX-29 calls create with `deviceLimit` and `delivery`; LX-30 offers **Send a new key…**.

The role agent sets `--set LX-27 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-27
done`.

## Progress and continuation (2026-10-17)

Built on wp/LX-27-create-licence. Verified against the code (the code wins):

- `stmtInsertLicense` did not write `device_limit`; it does now (create stores `deviceLimit`, LX-14a's
  create refusal is lifted, `licenseDeviceLimit.test.ts` updated).
- The key email is sent through `deliverEmail` with the **passthrough** sender ("<App> via Polaris Key",
  I-18), not `deliverOrLink`: that helper sends as the platform and answers a link instead, which is wrong
  for a key. `delivered.email` is `sent` or `failed` (a suppressed recipient or no mail binding reads
  `failed`); `queued` is in the contract but nothing emits it yet.
- The 10-minute limit is read from the audit trail (delivered sends only), so no migration and no new
  bucket; a failed send stays retryable. Two concurrent calls can both pass (threat model, accepted).
- "Download link when the product has one" = Release on and the portal on (`#/p/<slug>/download`).
- Console: **Send a new key…** (record overflow, assigned licences only), `sendLicenseKey` mutation entry,
  **Email them the key** on Assign…. Evidence: `licenseHolders.e2e.test.ts` shots at 360/390/1440, both themes.

Not done (follow-ups): the Identity-default **invitation** (sign-in link, no key; "Also create a key"
optional) from the 2026-10-07 consolidation section, and the "From <developer>" library notice for an
association at first email verification (LX-26 N1). Both belong with the wizard (LX-29) and
`onAccountEmailVerified`.

## Polish after the UX re-review (LX-27b, 2026-10-17)

N1-N10 of `_mockups/review/LX-27/ux-review-2.md`:

- Worker: send-key answers 409 `license_expired` for an expired licence (the console hides the item too). `delivered.reason` and the 409 `reason` gain `address_unusable` (bad address, unregistered Apple relay) and `daily_cap`; `no_mail_binding` also covers a missing sender. All four are refused before a key is minted, and `emailLicenseKey` checks them first. The cap is read with a new `peek` mode of the rate-limit counter (no charge). Only `provider_refused` offers Try again.
- Console: refusal copy per reason, 429 as a warning from `retryAfter`, "No key was made" on 409 and 429 only, one "failed" in the result, Send key off after a permanent 409 with a "Mint key…" button, Copy details stacked.
- Email: `<wbr>` after each `_`, `overflow-wrap:anywhere`, 14 px key below 480 px.
