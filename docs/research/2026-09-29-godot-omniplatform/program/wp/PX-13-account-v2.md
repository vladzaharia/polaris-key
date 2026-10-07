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

## Corrections from the code (PX-13 builder, 2026-10-06)

Checked against `integ/batch-4` at `1d71afb38`. The lead's dispatch for this package: build the UI
on PX-W12's and I-07's APIs, change no contract, and report any API change instead of making it.

- **Three of the five In items have no API.** No portal route lists the account's product users
  or disconnects one (Connected products), none exports the account (**Download my data**; I-11's
  brief says the full export is I-11's), and none says which sign-in method a product knows the
  person by (the identity card's "knows you as …"). This package therefore ships **Sign-in
  methods** (all of PX-W12's and I-16's surface), **Where you're signed in** (I-07), the product
  page's sign-in card for Identity products (from `services.identity` on `GET /api/products/<p>`,
  naming no method), and leaves Connected products and Download my data out: the section nav and
  the page point at neither. The routes they need are listed in the hand-off.
- **PX-W12's deferrals stay out for want of an API:** **Make primary** (no route), a passkey's
  **Rename** (no `name` column or `PATCH`; this brief's follow-up asks for both, the dispatch
  forbids API changes, so it is reported, not built) and the products each method brought in (not
  in `GET /api/me/methods`). The **AAGUID → provider map** needs no Worker change: it ships in the
  SPA (`portal/model/methods.ts`), falling back to `addedFrom`, then "Passkey"; an all-zero AAGUID
  names no provider.
- **Step-up is signing in again, in place** (PX-W12's correction). The panel offers a passkey
  first (the browser is offered only this account's credentials, so it cannot sign in to another
  account), else an email code on the card's `/api/signin/email/*` routes to one of the account's
  own email methods, else signing in again with a connected provider, which returns to what it
  was confirming (`?remove=<id>` reopens the panel with focus on its heading, `?connect=<provider>`
  and `?add=passkey` focus their button, `?add=email` reopens the form). Every in-place sign-in
  opens a new account session (I-07), so the page re-reads `GET /api/me` for the new CSRF token
  (a request of its own: a read still in flight with the old cookie can't put the old token back)
  and ends the session row it replaced (`DELETE /api/sessions/<id>`, only once that row is no
  longer `current`). The provider way leaves the page, so it cannot end the row it replaced: Where
  you're signed in lists this browser twice until that row expires. PX-W12 asks for step-up on
  **Connect** and **Add** as well as removal; the page asks the same way. A browser makes a passkey
  only from a click, so after a step-up **Add a passkey** is pressed once more.
- **Sign out everywhere** (I-07's route) ends this browser's session too and signs the account out
  of its apps (Core's clearing hook): the page says so, under that name, not "everywhere else".
- **Link an existing account** (the header link and the Hide My Email notice's link) and **Approve
  a new device** stay out until PX-15 adds `#/account/link` and `#/account/approve` (as PX-17 left
  `license_owned`'s link). The Hide My Email notice offers **Add your real email** meanwhile.
- **Apple, Google and Steam** are listed when connected or when this deploy can connect them
  (`providers[].available`); a row that could only say "not available" would be a dead end.
- **Turnstile:** the email step-up uses the card's email start, which asks for a Turnstile token
  when the deploy has Turnstile on (`turnstileSiteKey` in `GET /api/capabilities`). The account
  page renders no widget, so with a site key it skips the email way and offers the passkey, or
  signing in again with a provider; an email start refused with `turnstile_failed` falls back the
  same way.
- **Route params:** the account route now carries its query (`?connected=`, `?error=&method=`
  from a provider's Connect callback, `?remove=`, `?add=email|passkey`, `?connect=`), read once and
  dropped from the URL. "Connected" is said only when the methods list shows the provider
  connected.

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

- [x] Last-method test (the disconnect control is refused for the only method).
- [x] Step-up test before disconnect.
- [ ] Sessions and export pass the account-sessions contract tests. (Builder, 2026-10-06: sessions
      are built on I-07's routes as `identityCardSessions.test.ts` pins them, unchanged; export has
      no API, see the corrections.)
- [x] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [x] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [x] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header. (Builder, 2026-10-06: the lead gate, scope `changed`, green on every step; `test:e2e` green apart from five motion-timing checks in files this package does not touch, which pass on their own.)

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-19 documents sign-in methods.

The API the rest of this package's surface needs (PX-13 builder, 2026-10-06), each a rule-10 route
(OpenAPI, a `PORTAL_KIND_PATHS` row, a line on the docs site's portal page):

- **Connected products and "<Product> knows you as":** `GET /api/me/products`, one row per product
  user of a product with Identity on (presentation, the sign-in method it uses, whether it has
  Cloud Sync, when it was last used), and `DELETE /api/me/products/<slug>` (signs that app out; the
  licence stays). I-11 names connected apps with revoke.
- **Download my data:** the account export (I-11's full export).
- **Make primary:** `POST /api/me/methods/<id>/primary` for a verified email method.
- **A passkey's Rename:** the `name` column (`00XX_<name>.sql`), `PATCH /api/me/passkeys/<id>` with
  `{name}`, and `name` in `PasskeyView`.
- **The products each email brought in:** a count per address in `GET /api/me/methods`.

PX-15 adds **Link an existing account** to the Sign-in methods header and to the Hide My Email
notice, and **Approve a new device** to Where you're signed in, once `#/account/link` and
`#/account/approve` exist.

PX-12, once it renders the Turnstile widget on the login card: render it in the account page's
step-up (`components/account/StepUp.tsx`) as well, so the email way comes back with Turnstile on,
or keep the skip there.

The role agent sets `--set PX-13 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-13 done`.
