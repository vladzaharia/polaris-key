# PX-13 Account v2: `SignInMethods` (connect, disconnect with step-up, last-method guard, Hide My Email notice), connected products, sessions, export; product identity card

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-07](PX-07-account-v1.md), [PX-W12](PX-W12-sign-in-methods-api.md), [I-07](I-07-login-card-email.md)                                                                                  |
| Unblocks    | [PX-W19](PX-W19-account-api-gaps.md), [PX-25](PX-25-account-v2-gaps-ui.md)                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Passkey settings rows** ([I-16](I-16-passkeys.md)). The routes exist: `GET /api/me/passkeys`
  (one `PasskeyView` per passkey: `id`, `methodId`, `createdAt`, `lastUsedAt`, `transports`,
  `synced`, `aaguid`, `addedFrom`; plus `canAdd` and `reason`), `POST /api/me/passkeys/options` and
  `POST /api/me/passkeys` (verified email and step-up), and `DELETE /api/me/passkeys/<id>` (step-up;
  never the last sign-in method, `last_link`). The rows PORTAL.md §4.26 draws (provider name, added,
  last used and where; **Add a passkey**, disabled with its reason) are this package's. Two pieces
  are missing on the Worker:
  - **Rename needs a name field.** `account_passkeys` has no name column and there is no rename
    route. **Rename** needs the column (a migration named `00XX_<name>.sql`; the lead numbers it),
    `PATCH /api/me/passkeys/<id>` with `{name}` (OpenAPI and a `PORTAL_KIND_PATHS` row) and `name`
    in `PasskeyView`. Check PX-W12 first, in case it lands this.
  - **An AAGUID → provider map.** The Worker stores and returns the raw `aaguid`; nothing turns it
    into "iCloud Keychain", "Google Password Manager" or "1Password". Add a static map, shipped with
    the code (no runtime fetch). An unknown AAGUID falls back to `addedFrom`, then to "Passkey".
- **Add and verify that email under `email_mismatch`** ([PX-17](PX-17-activate-confirm.md)). PX-17
  left this PORTAL.md §4.19 action out of the Activate dialog because add-email had no target. Once
  this package ships **Add an email** (on PX-W12's add-email), the dialog's `email_mismatch`
  refusal (`RefusalActions` in `ActivateDialog.tsx`, today **Use a different key** only) gains
  **Add and verify that email**, which opens that flow.

## Goal

Account gains Sign-in methods (connect, disconnect with inline step-up, last-method guard, Apple Hide My Email notice), Connected products (Identity products only), sessions with sign out everywhere, and export; the product page gains the product identity card.

## Why

Account v2 is where people manage how they sign in ([PORTAL.md §4.26](../../../../design/PORTAL.md#426-account)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.26](../../../../design/PORTAL.md#426-account), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `wp/I-07-login-card-email.md` (account sessions), `wp/I-11-portal-library.md` (export)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `SignInMethods`, connected products, sessions, export, `ProductIdentityCard`.

**Out** (and where it belongs instead):

- Profile (→ PX-22)
- Linking UI after sign-in (→ PX-15)

## Design notes

- **Providers** (owner decisions): one login card for every entry; the provider row is logo-only Apple, Google and Steam, filtered per product by where it ships; no Discord anywhere.
- Connected products and the identity card appear only for products with Identity on (§3.1).
- **Overlap with the re-cut S-16/S-17 graph:** I-11 also names account settings (sign-in methods, devices and sessions, connected apps) and export. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-13:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-13 in-review`.

## Acceptance criteria

- [ ] Last-method test (the disconnect control is refused for the only method).
- [ ] Step-up test before disconnect.
- [ ] Sessions and export pass the account-sessions contract tests.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-19 documents sign-in methods.

The role agent sets `--set PX-13 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-13 done`.
