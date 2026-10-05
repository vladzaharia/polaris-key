# I-26 Legacy product-OIDC sign-in stops auto-issuing a second licence: on `provider: platform` products, a person whose Polaris Key account already holds a usable licence gets a server-rendered licence chooser instead of a new `sub`-keyed licence

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) |
| Size        | 0.4–0.6 engineer-weeks                                             |
| Depends on  | [I-05](I-05-accounts-core.md), [PX-10](PX-10-focused-flows.md)     |
| Unblocks    | [I-08](I-08-app-passthrough.md)                                    |
| Role        | `pkey-implementer`                                                 |
| Plan mode   | no                                                                 |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`  |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

The legacy in-app sign-in (`/<p>/identity/auth/*` against the platform IdP: device code, its QR
and the browser flow, shown in the console as "Signed-in app") never mints a second licence for a
person whose Polaris Key account already holds a usable licence for that product. That person
gets a **Choose a licence for this device** page and the device is bound to the licence they pick.
Nothing changes on the device wire.

## Why

On 2026-10-05 an in-app sign-in on Storytime auto-issued a second licence, although the account
already owned a Standard licence. The owner decided that sign-in must ask instead
([`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in").

The full fix is the card's `LicenseChoiceStep` (I-08, PX-14), which waits on I-07, I-09 and
PX-W13. This package stops the duplicate mint now, on the code that is live today. I-05 has
already merged the account tables, links and `licenses.account_id` this package needs.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`plans/I-04.md`](../plans/I-04.md), the section "Owner decision (2026-10-05): licence choice at
  sign-in", §A, and delegated decisions 1, 2 and 13.
- `packages/worker/src/services/identity/oidc.ts`:
  - `identityTier`, `identityRefusal`, `activateFromIdentity` and `authorizeAndMint`;
  - `handleAuthCallback`, `pollAuthFlow` and `attachableLicense`;
  - `confirmDeviceFlow` and `sameOriginPost`.
- `services/identity/accounts/repo.ts` (`findLink`) and `services/identity/portal/repo.ts`:
  - `syncAccountLicenseLinks` and `AUTO_LINK_ENABLED_SQL` (R5-01, R5-02);
  - `accountHoldsProduct`, which Discover already uses to refuse a duplicate claim.
- `core/accountSubjects.ts` (`accountLicenses`), `core/devices.ts` (`licenseUsable`), `repo.ts`
  (`countActiveDevices`, `seatActiveSince`) and `core/authz.ts` (`licenseDeviceLimit`).
- `docs/security/THREAT-MODEL.md`, "Remote phishing" (R1-07 and R8-03).

## Scope

**In:**

- **The trigger.** All three conditions must hold:
  - the product's `oidc_config.provider` is `platform`, and auto-linking resolves on (the
    `AUTO_LINK_ENABLED_SQL` rule);
  - the verified identity has an account link
    (`findLink({issuerKey: <platform issuer>, tenantScope: "", subject: sub})`, kind `oidc`);
  - that account holds at least one usable licence for the product (`licenses.account_id`,
    `licenseUsable`).

  Then `handleAuthCallback` mints nothing. It renders the chooser, for device-code flows and
  browser flows alike, before `activateFromIdentity` would run. Without the trigger, everything
  behaves exactly as today.

- **The chooser page** (server-rendered with `renderBrandPage`, no JS). It is titled "Choose a
  licence for this device" and names the product and the device label.
  - **Free rows:** one per usable licence with a free device slot, showing tier, origin, "2 of 5
    devices" and expiry. The first one in I-09 §2.4 order is preselected (no expiry first, then
    the latest expiry, then the oldest). It is shown even when there is only one.
  - **Full rows:** shown disabled, reading "No free devices" with a **Free a device** link to
    `/#/p/<slug>/free-device?for=<licenseId>`.
  - **Create a new free licence:** offered only when `identityTier` grants a tier and every row
    is full (delegated decision 1).
  - Primary **Use this licence**, and **Cancel**.
- **`POST /<p>/identity/auth/choose`.**
  - **Request checks:** a same-origin `POST` (`sameOriginPost`) carrying a single-use choice token
    stored on the flow record. The page never contains `state`.
  - **Choice re-check:** the server checks again that the chosen licence belongs to the account
    and is usable, and records `flow.licenseId`. Then the existing paths complete: the
    device-code and `state` polls mint through `authorizeAndMint`, which is seat-checked, and the
    `returnTo` flow creates the browser session and redirects with `302`.
  - **Identity's own licence:** choosing the identity's own `sub`-keyed licence, when it is in the
    list, leaves the deferred P1-07 activation as it is today, attach opt-in included.
  - **Create:** runs `activateFromIdentity` as today.
- **The browser binder** (delegated decision 13). The chooser renders, and `choose` accepts, only
  in the browser that began the flow. That browser carries a `__Host-pk_lcb` cookie (HttpOnly,
  Secure, SameSite=Lax, Path=/) set by `/auth/start` or by the device-confirmation `POST`. The
  flow stores the cookie's hash.
  - Without the cookie, the callback answers a generic "Start again on your device" page and
    mints nothing.
  - Without this check, an R1-07 phish could now bind the victim's purchased licence instead of a
    free one.
- **The poll** stays `pending` until the choice is recorded, with the same bodies (no wire
  change).
- **Audit and docs.**
  - Audit `identity.signin.license_chosen` (target the licence, summary with the device label).
  - OpenAPI entries for `GET`/`POST /{product}/identity/auth/choose` (HTML, documented like
    `/identity/auth/device`) and the `routeCoverage` table (rule 10).
  - THREAT-MODEL: a note under "Remote phishing" on the binder.

**Out** (and where it belongs instead):

- The inline **Replace a device** (→ I-08's card, `freeAccountDevice()`). This page only links to
  PX-10's flow.
- The login card's `LicenseChoiceStep` and its API (→ I-08, PX-14).
- `provider: custom` products, whose `sub` cannot be linked to an account (I-04 §8 Q6, R5-02). They
  keep today's behaviour until layer 2.
- Cleaning up licences that are already duplicated (delegated decision 12). An operator may
  disable one in the console after its devices have moved.
- Any change to device-wire bodies, discovery or transcripts.

## Design notes

- **Discover is already safe.** It refuses a claim when `accountHoldsProduct` is true. This
  package applies the same "already holds one" rule to the in-app path, narrowed to usable
  licences.
- **Purchased licences now work from the app.** A purchased licence attached to the account is
  listed even when the product's group map would not entitle the identity. Today such a person
  gets "not entitled" from `identityRefusal`. Choosing a non-`sub` licence binds without
  `activateFromIdentity`'s tier and provisioning rewrite, because that licence keeps its own tier.
- **Choosing never counts as a key entry** (PX-W9), and never changes `licenses.account_id`.
- **Short-lived.** I-08 deletes this page when PX-14 moves the device page onto the card, and the
  card keeps the rule.

## Implementation notes (2026-10-05, corrections and lead decisions)

Recorded by the implementer. The owner delegated open points to the lead; each is decided with
the recommended option. Where the code disagreed with this brief, the code won.

- **Inline Replace is IN (lead decision, amends delegated decision 13's second bullet).** The
  lead's dispatch asked for the inline **Replace a device** on full rows, using a shared
  `freeAccountDevice()` extracted from the portal's `handleDeviceDelete`
  (`services/identity/portal/freeDevice.ts`): portal on, account ownership, the shared
  `portalDeviceDisconnect` budget (charged after ownership; the 429 copy carries `retryAfter`,
  the seconds left in the fixed window), `portal.device.disconnect` with "to sign in <label>",
  and the security email. I-08 reuses the same function. The **Free a device** link stays.
- **Free-device link (code correction).** PX-10's page reads the licence from `license=` and a
  device label from `for=` (`FreeDevicePage.tsx`). The link is
  `/#/p/<slug>/free-device?license=<licenseId>&for=<device label>`, opened in a new tab; there is
  no `return=` (PX-10's allowlist only accepts the product's declared origins), so the page
  says "then reload this page".
- **Post/redirect/get.** The callback answers `303` to `GET /<p>/identity/auth/choose`; every
  `POST` answers `303` back to it (or completes). The flow is found by the binder through a new
  single-use kind `oidc-choice` (binder hash → `state`); the page carries only a single-use
  token. A `return_to` flow's completion from the chooser answers `303` (a POST), not `302`.
- **Binder scope.** The cookie is set only on `provider: platform` products' `/auth/start` 302
  and device-confirmation 303 (`binderEligible` on the flow), so custom-IdP sign-ins are
  byte-identical. Platform products outside the trigger gain only that `Set-Cookie`.
- **Candidates.** The account's usable licences plus the identity's own unattached `sub`-keyed
  licence (usable). A licence the signing-in device already holds a seat on counts as free; a
  tier with fingerprint mode `strict` is listed **blocked** (the mint would refuse).
- **Create a new free licence** additionally requires that the identity has no `sub`-keyed
  licence yet (`activateFromIdentity` is idempotent on the subject and could not make a second).
- **Origin labels** come from License's `licenseProvenance` hook ("Bought on Steam", "From the
  developer", "Signed-in app", "Free"); display only.
- **Primary copy** is "Use this licence" (this brief), not the card's "Use this licence and
  continue" (decision 3 is the card's).
- **Rate limit** of the chooser route: new bucket `authChoose`, 60/60 s per IP, fail-closed.
- **Audit**: `identity.signin.license_chosen` (product audit, target the licence; `null` target
  for Create) and its console verb.

## Steps

1. Write the trigger query and a read-only `legacyLicenseChoices()` with unit tests: linked
   account, no link, custom provider, auto-link off, full licences and unusable licences.
2. Add the binder cookie to `/auth/start` and the device-confirmation `POST`. Add the chooser page
   and the `choose` route, with the flow-record fields and the single-use token.
3. Wire `choose` into the callback, the device-code poll, the `state` poll and the `returnTo`
   paths.
4. Add OpenAPI, `routeCoverage`, the audit row and the THREAT-MODEL note.

## Acceptance criteria

- [ ] A person whose linked account owns a usable licence gets the chooser and **no new licence
      row** on every flow kind: device code, `state` poll and `returnTo` (tests).
- [ ] Picking a licence binds the device to it, and `ready` carries a token for it (test). A licence
      that is not the account's, or is no longer usable, is refused (test).
- [ ] Full licences are listed disabled with the free-device link. **Create a new free licence**
      appears only when the policy grants a tier and every licence is full (tests).
- [ ] Without the binder cookie the chooser is refused and nothing is minted (test).
- [ ] With no link, no usable licence, or a `provider: custom` product, the behaviour is
      byte-identical to today, and `pnpm gen:transcripts -- --check` is unchanged.
- [ ] OpenAPI and `routeCoverage` are updated, and the THREAT-MODEL note is written.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity oidc devicecode choose
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- I-08 replaces this page with the card's `LicenseChoiceStep`, keeping the rule.

The role agent sets `--set I-26 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-26 done`.
