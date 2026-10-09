# PX-12 Login card v2 on the AuthCard

| Field       | Value                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                                                   |
| Depends on  | [PX-05](PX-05-login-card-today.md), [PX-W4](PX-W4-email-code.md), [PX-W9](PX-W9-key-entry-counting.md), [I-16](I-16-passkeys.md), [I-06](I-06-login-providers.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [P0-36](P0-36-portal-on-copy-catalog.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-14](PX-14-passthrough-header.md), [PX-15](PX-15-after-sign-in.md), [PX-21](PX-21-email-gate-ui.md)                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components; THREAT-MODEL                                                   |
| Human input | none                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W9.md`](../plans/PX-W9.md):** Q4: a signed-out, read-only `POST /api/key/preview` feeds the meter and never counts; "Skip" counts nothing; the copy "This was entry 3" becomes "This will be entry 3".

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Copy per SIGN-IN.md §3.3–§3.4: no lede on portal direct; the logo-only provider row (Apple, Google, Steam); **Have a license key?** and **Sign in with another device** under a rule; six-cell code input as one field; "{n} tries left."; no "Polaris Key · key.plrs.im" footer. Skip only when an app sent the person (D-36).

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Passkey button and conditional UI** ([I-16](I-16-passkeys.md)). I-16 shipped the Worker half
  only: `POST /api/signin/passkey/options` and `/verify`, and `auth.passkey` in
  `GET /api/capabilities`. The card has no passkey button yet. The email field already carries
  `autocomplete="username webauthn"`. When verify refuses with `unknownCredential: true` (no account
  holds that credential id), call `PublicKeyCredential.signalUnknownCredential({ rpId, credentialId })`
  where the browser has it, so the authenticator stops offering a passkey that can no longer sign
  in. Every other refusal stays the one `401 unauthorized`.
- **Send a new code on the expired-link page** ([PX-W4](PX-W4-email-code.md), which left it out).
  SIGN-IN.md §3.13 and §4.12 (frame 15) want the Worker's expired or used code/link page to offer
  **Send a new code** to the masked address and land on CodeStep with `returnTo` and the request
  handle intact. Today a flow lives exactly as long as its code (10 minutes), so `expiredLinkPage`
  (`card/emailSignIn.ts`) knows no address and takes the spec's "without a known address" branch
  (**Sign in again**). Three things are needed:
  - a flow record that outlives its code (I-07's flow lifetime);
  - a no-JS form `POST` path from that page into the resend;
  - `GET /api/signin/flow`, so the SPA can read the flow (the masked address, `resendIn`) when it
    lands on the code step after that plain `POST`.

  Only `POST /api/signin/flow` (the asking browser's poll) exists today. A new route needs its
  OpenAPI operation, a `PORTAL_KIND_PATHS` row in `routeCoverage.test.ts` (rule 10) and a line on
  the docs site's portal page.

- **Already done (PX-W4):** `SignInPage.tsx` resends through `POST /api/signin/email/resend`, counts
  down from `resendIn`, shows a 429's `retryAfter`, handles the per-flow cap and returns to the
  email step on `signin_expired`. `CodeEntry` keeps that behaviour; there is nothing left to build
  for the resend itself.

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **`POST /api/key/preview`** (PX-W9) is signed out and read-only, and never counts. It charges the IP bucket
  `portalKeyPreview`. Its body is `{product, verdict: "addable" | "license_owned" | "portal_off", license:
{tierName, term} | null, keyEntries | null, upgrade: "skippable" | "forced"}` (Q5, following SIGN-IN.md §3.9).
  - The `license_owned` verdict says only that the key is in an account.
  - It never carries an email, masked email, licence id or device list.
  - `email_mismatch` stays a signed-in verdict (`POST /api/activate/preview`).
- **The forced body.** Render it only when `upgrade` is `"forced"`. The Worker sets that only at the limit **and**
  with `identity.keyEntryRefusals` on (Q4). Otherwise render the skippable body with the meter, even at 0 left.
- **The meter.** It reads `keyEntries {used, limit}` and shows `max(0, limit − used)` left. `used` may exceed
  `limit`. With Identity off, `keyEntries` is `null`: show no meter.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Built as AuthCard steps (P0-38) reading signin.\* from the catalog (P0-36). The identifier step routes to connections ({next: 'sso'}) and shows the enforce state once I-30 lands; new accounts end in FinishStep (PX-21).

- Title: was "Login card v2: identifier-first with `UsualMethodHint` (G30), code entry, passkeys with conditional UI, Apple/Google/Steam per product, license-key path, `AccountUpgrade` skippable and forced".
- Depends on: added P0-38 and P0-36.

## Goal

The login card is identifier-first with the usual-method hint from the `pk_last_method` cookie, code entry, passkey button and conditional UI, the logo-only Apple/Google/Steam row per product, the license-key path, and `AccountUpgrade` (skippable while entries remain, forced at zero with the entries meter).

## Why

The full sign-in experience ([PORTAL.md §4.1](../../../../design/PORTAL.md#41-the-login-card)); providers must ship together with the email gate (PX-21, [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.1](../../../../design/PORTAL.md#41-the-login-card), [PORTAL.md §4.3](../../../../design/PORTAL.md#43-known-account-you-usually-sign-in-with-steam), [PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code), [PORTAL.md §4.5](../../../../design/PORTAL.md#45-use-a-license-key), [PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `MethodStack`, `UsualMethodHint` (sets and reads `pk_last_method`: kind and a salted email hash, no PII), `CodeEntry`, passkey button and conditional UI, `ProviderRow`, license-key path, `AccountUpgrade`.

**Out** (and where it belongs instead):

- Email gate step (→ PX-21; must ship in the same release as the providers)

## Design notes

- **Providers** (owner decisions): one login card for every entry; the provider row is logo-only Apple, Google and Steam, filtered per product by where it ships; no Discord anywhere.
- **License keys** are the real format `pkey_<product>_<22 base64url>`; `KeyField` never groups or changes case and trims whitespace only.
- **Email field autocomplete:** wave 1 (PX-05) ships `autocomplete="email"`; with passkeys this changes to `username webauthn` (§4.1) so conditional UI can offer them.
- **THREAT-MODEL note (G30):** the hint is never derived from a server lookup (no enumeration).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

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

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Primary actions are neutral ink in the portal card, hosted sign-in and console card (B2); provider row fills come only from the Apple, Google and Steam allowed sets, never the host tint (B8). PX-21: FinishStep sits inside the passport with no provider strip; the primary stays disabled until both terms are ticked, with the reason line. ST-30: the console card has no app context, so no passport. (auth-17)
- [ ] Forced-colours render, 400% zoom (320 CSS px, no sideways scroll), 200% text, a custom product accent on light and dark, and 44 px customer targets. (auth-17)
- Keep identifier-first email and Continue, the logo-only one-row provider buttons, the passkey ghost button, the static star field, no art on portal-direct sign-in, no lede, no 'Welcome to Polaris Key' eyebrow and no marketing footer (SIGN-IN §3 and PORTAL §4.1 win over the guide's split sign-in). Adopt: inputs at 16 px or larger on touch (no iOS zoom), a constrained line length, long provider accessible names. The optional app-context cover is PX-33. (portal-08)

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-12:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-12 in-review`.

## Acceptance criteria

- [ ] WebAuthn mocks cover passkey sign-in and conditional UI.
- [ ] Forced-upgrade test at zero entries; skippable while entries remain.
- [ ] No-enumeration test: responses and timing do not reveal whether an email has an account.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

PX-14, PX-15 and PX-21 build on the v2 card.

The role agent sets `--set PX-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-12 done`.
