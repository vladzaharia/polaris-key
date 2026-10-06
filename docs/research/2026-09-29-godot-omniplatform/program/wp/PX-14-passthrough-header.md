# PX-14 Passthrough card header: `CardHeader` app and device variants, `AppConsent`, return screen, across broker, native redirect, web redirect and device code

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-12](PX-12-login-card-v2.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-08](I-08-app-passthrough.md), [I-15](I-15-native-redirect.md)                                              |
| Unblocks    | [PX-19](PX-19-portal-docs.md)                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** read `SignInRequestView` and `AppConsentView`; render the neutral frame when `nameVerified` is `false`; switch the device-code page to `303 /signin?request=rq_…` (a root path).
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** render the Identity-off card from the `error=identity_disabled` query parameter and the API code.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package:

- **Render `LicenseChoiceStep`** (EXPERIENCE.md §8) under the persistent app header, from I-08's
  `LicenseChoiceView`.
  - Each row shows the tier, origin, "2 of 5 devices" and the expiry, with one row preselected.
  - Full rows are disabled and read "No free devices", with **Replace a device** (inline,
    `ReplaceView`, one confirm naming the device) and the **Free a device** link.
  - The view's other cases also render here: the **Keep the license this device uses** row, the
    **Create a new free license** row, the `autoIssue` copy, and the "You don't have <Product> yet"
    state.
- **Primary button.** It reads **Use this license and continue** when no consent screen follows.
  When one follows, `AppConsent` shows the chosen licence with **Change**.
- **Fallback return.** Extend PX-10's return allowlist to accept the same-origin return
  `/signin?request=rq_…`.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Build LicenseChoiceStep (SIGN-IN.md frames 05, 08, 09, 19–22 and every state of §3.6, including Account-wide rows, which keep their counter and meter like seat rows, D-53), ReplaceDevice (frame 06, §3.7), ConsentStep with **Change** (frame 07), the product-hero header and muted brand row (D-48), the identity_disabled card (frame 16) and the product-context header (D-11).
- PX-10 accepts `license=` and the same-origin return `/signin?request=rq_…` (I-04 decision 14); `for=` stays the device label.
- Accessibility per SIGN-IN.md §3.14: full and blocked rows are not radios, Replace stays in Tab order, focus moves to each step's h1.

## Goal

App sign-ins show "<App> wants you to sign in" in the card header (app and device variants) through every step, the `AppConsent` confirm step on first sign-in and whenever what the app gets changes, and a return screen, across the broker, native redirect, web redirect and device code; products with Identity off get the `identity_disabled` error card.

## Why

Passthrough is how apps use the one account ([PORTAL.md §4.7](../../../../design/PORTAL.md#47-app-sign-in-the-card-header)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.7](../../../../design/PORTAL.md#47-app-sign-in-the-card-header), [PORTAL.md §4.8](../../../../design/PORTAL.md#48-app-sign-in-native-app-steps), [PORTAL.md §4.9](../../../../design/PORTAL.md#49-app-sign-in-device-code-tv-console), [PORTAL.md §3.3](../../../../design/PORTAL.md#33-routes)
- `wp/I-08-app-passthrough.md`, `wp/I-15-native-redirect.md`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `CardHeader` `app` and `device` variants (data only, from the `request` handle), `AppConsent`, return screen, `/tv` entry, error card.

**Out** (and where it belongs instead):

- Layer 2 per-product issuer consent (→ I-21 and later)

## Design notes

- Consent is shown on the first sign-in to each app and whenever what it gets changes, for every app (owner decision Q-7).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-14:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-14 in-review`.

## Acceptance criteria

- [ ] e2e: the header persists through every step.
- [ ] Reserved-name test: a spoofed name never renders.
- [ ] Products with Identity off render the error card (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

PX-19 documents app branding data.

The role agent sets `--set PX-14 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-14 done`.
