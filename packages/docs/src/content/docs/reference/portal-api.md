---
title: "Polaris Locker API"
description: "Polaris Locker's HTTP surface: sign-in, account, library, licenses, downloads and per-product data, with the gates each route applies."
type: "reference"
lastReviewed: "2026-10-16"
---

Polaris Locker's routes sit at the root of the host, reserved ahead of every product slug, because one account holds licenses across products. Locker's own pages call them. Your app doesn't. This page is written by hand from the router and `packages/worker/openapi/polaris-key.v3.yaml`, which holds the schemas for the sign-in, account, library, Discover and device-login routes.

For how Locker behaves, see [Locker](/docs/features/sign-in/customer-portal/).

## Gates

- A route under `/api/*` needs the session cookie (`401 unauthorized` otherwise), except `capabilities`, the sign-in routes under `signin/*`, `key/preview`, `magic/start` and the new device's half of `device-login`.
- A mutating method also needs the `X-PKey-Portal-CSRF` header to match the session's CSRF value (`403` otherwise).
- A **step-up** route needs a sign-in no older than 5 minutes, else `401 { "error": "step_up_required", "maxAgeSeconds": 300 }`.
- A request for a product the account holds nothing in answers `404`, the same as for an unknown product.
- Rate limits are per client network, per account or per product shard, as listed. A refusal is `429`, never a silent drop.

## Pages and cookies

| Route                            | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `GET` `/login`                   | Starts sign-in through the seeded platform connection (redirect to its provider) |
| `GET` `/login/sso/<id>`          | Starts sign-in through another active platform connection                        |
| `GET` `/callback`                | Every connection's redirect URI: redeems the code, verifies the ID token         |
| `GET` `POST` `/magic/verify`     | The magic link's landing page (reads only) and its button (signs in or confirms) |
| `POST` `/logout`                 | Ends this browser's session, server-side too                                     |
| `GET` `/download/<token>`        | Redeems a minted download token once and redirects                               |
| `GET` `/media/<product>/<asset>` | A product's icon or header art, re-served same-origin                            |
| `GET` `/media/avatar/<asset>`    | An account picture, re-encoded and served same-origin                            |

The session cookie is `__Host-pkey_portal`: `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, 14 days. The cookie carries a signed token naming a server-side session row, which is the authority. Product routes never see the account realm's cookies.

## Sign-in

| Route                                     | Purpose                                                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` `/api/capabilities?product=<slug>`  | Pre-auth. Which sign-in methods and modules apply to one product                                                                                                                               |
| `POST` `/api/signin/email/start`          | Emails a 6-digit code and a magic link, or routes the address to its connection                                                                                                                |
| `POST` `/api/signin/email/verify`         | Redeems the code in the browser that asked                                                                                                                                                     |
| `POST` `/api/signin/email/resend`         | Sends a new code and link for this browser's flow                                                                                                                                              |
| `GET` `POST` `/api/signin/flow`           | `POST`: the asking browser's poll after the link was confirmed elsewhere. `GET`: this browser's flow (masked address, `resendIn`), read by the code step the expired-link page's form lands on |
| `GET` `POST` `/api/signin/confirm-email`  | The email gate: confirm an address, profile and terms of a new account                                                                                                                         |
| `POST` `/api/signin/confirm-email/verify` | The gate's code, for a typed or unverified address                                                                                                                                             |
| `POST` `/api/signin/confirm-email/join`   | Takes the join offer once both identities are proven                                                                                                                                           |
| `POST` `/api/signin/confirm-email/cancel` | Abandons the sign-in                                                                                                                                                                           |
| `GET` `/api/signin/confirm-email/picture` | The provider's picture, proxied and re-encoded                                                                                                                                                 |
| `POST` `/api/signin/passkey/options`      | A passkey challenge bound to this browser (5 minutes)                                                                                                                                          |
| `POST` `/api/signin/passkey/verify`       | Signs in with the passkey's answer, once                                                                                                                                                       |
| `POST` `/api/key/preview`                 | Signed out: what a license key would do, for "Have a license key?"                                                                                                                             |

Email start returns `{ "ok": true, "expiresIn": 600, "codeLength": 6, "resendIn": 60 }`. The answer is the same for a known, unknown, locked-out or suppressed address; only a deploy that can't send mail answers `503 email_unavailable`. A code lives 10 minutes and dies after 5 wrong attempts. Limits per start: 8 a minute and 10 sends an hour per client address, 30 an hour per network, and 5 an hour and 20 a day per recipient.

Resend waits 60 seconds after the last code (`429 rate_limited` with `retryAfter`), and one flow sends at most 5 emails. A browser without a live flow gets `400 signin_expired`.

A flow lives an hour; its code and link live 10 minutes. The Worker's expired-link page uses the difference: its **Send a new code** is a plain form `POST` of the resend route, answered with a `303` to the sign-in page with `signin=code`, which reads `GET /api/signin/flow` and lands on the code step with `returnTo` and the request handle intact. A browser without the flow cookie gets **Sign in again**.

An address whose domain a DNS-verified, active platform connection covers gets `next: { kind: "sso", connection, enforced }` and no email, unless `enforced` is false and the caller asks for `"method": "code"`. An enforced domain refuses codes with `403 auth_method_disabled`.

A passkey signs in only to the account it was added to. Every failure is the same `401 unauthorized`. Both passkey routes share 30 requests a minute per address.

Every `returnTo` must be same-origin and may not target `/manage`.

## Account

| Route                                      | Purpose                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `GET` `/api/me`                            | The account summary and the CSRF token                                     |
| `DELETE` `/api/me`                         | Schedules deletion in 14 days (step-up). A repeat keeps the first deadline |
| `POST` `/api/me/deletion/cancel`           | Cancels a pending deletion                                                 |
| `GET` `/api/me/export`                     | Download my data, as `pkey-account-export/1` (step-up, 5 a minute)         |
| `GET` `/api/me/profile`                    | Screen name, picture, locale, birth date and where each came from          |
| `PATCH` `/api/me/profile`                  | Makes explicit choices that later sign-ins never overwrite                 |
| `POST` `/api/me/profile/picture`           | Uploads a PNG or JPEG (5 MB, 10 an hour); a `PATCH` puts it to use         |
| `GET` `/api/sessions`                      | The account's live sessions                                                |
| `DELETE` `/api/sessions/<id>`              | Ends one session                                                           |
| `POST` `/api/sessions/sign-out-everywhere` | Ends every session, this one included, and clears device bindings          |
| `GET` `/api/me/methods`                    | Sign-in methods, grouped, with what each allows                            |
| `POST` `/api/me/methods/<kind>/start`      | Connects a method (step-up)                                                |
| `POST` `/api/me/methods/email/verify`      | Connects an email with its code                                            |
| `POST` `/api/me/methods/<id>/primary`      | Makes an email the primary                                                 |
| `DELETE` `/api/me/methods/<id>`            | Disconnects a method (step-up)                                             |
| `GET` `/api/me/passkeys`                   | The account's passkeys and whether one can be added                        |
| `POST` `/api/me/passkeys/options`          | A registration challenge (step-up)                                         |
| `POST` `/api/me/passkeys`                  | Adds a passkey                                                             |
| `PATCH` `/api/me/passkeys/<id>`            | Names or unnames a passkey                                                 |
| `DELETE` `/api/me/passkeys/<id>`           | Removes a passkey (step-up)                                                |
| `GET` `/api/me/link`                       | The join screen and the joins still undoable                               |
| `POST` `/api/me/link/start`                | Starts linking an existing account (step-up)                               |
| `POST` `/api/me/link/confirm`              | Joins the two accounts, with proof of both                                 |
| `POST` `/api/me/link/cancel`               | Forgets the flow                                                           |
| `POST` `/api/me/link/undo`                 | Separates a join within 72 hours                                           |

Refusals use registered codes with a `reason`. The last way to sign in is never removable (`409 last_link`), and the only email can't be removed while it is the primary (`403 forbidden`, `reason: only_email`). A credential another account holds is `409 link_conflict`. Method and passkey changes are audited, emailed to every verified address and share 10 changes a minute per account. Passkeys need a verified primary email (`email_unverified`) and are capped at 20.

A join needs both proofs under 5 minutes old and both sessions live. It is refused while either account could undo a join of its own or has a scheduled deletion (`403 forbidden`, with `reason` `merge_pending` or `unavailable`).

Deletion erases sessions, emails, identities, links and the account row in one atomic batch, anonymizes audit rows that name the person and keeps a single tombstone naming only the opaque account id. Licenses are the product's records and are not deleted.

## Library and licenses

| Route                                                             | Purpose                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET` `/api/library`                                              | One entry per product the account holds a license for                            |
| `GET` `/api/licenses`                                             | Every linked license across products, with `origin` and `removable`              |
| `GET` `/api/licenses/<product>/<licenseId>`                       | One license with keys and devices                                                |
| `DELETE` `/api/licenses/<product>/<licenseId>`                    | Remove from my library (10 a minute per product shard)                           |
| `PATCH` `/api/licenses/<product>/<licenseId>/devices/<deviceId>`  | Renames a device (64 characters, 30 a minute)                                    |
| `DELETE` `/api/licenses/<product>/<licenseId>/devices/<deviceId>` | Disconnects one of the account's own devices                                     |
| `POST` `/api/licenses/<product>/<licenseId>/keys`                 | Get a new key (step-up, 5 an hour). Needs `keyReissueEnabled`                    |
| `POST` `/api/activate/preview`                                    | What adding a key would do, before it is added                                   |
| `POST` `/api/claim/license-key`                                   | Links a license by a typed key (10 a minute with the preview)                    |
| `GET` `/api/discover`                                             | Products the account could add for free                                          |
| `POST` `/api/discover/<product>/claim`                            | Add to library. Idempotent per account and product                               |
| `GET` `/api/products/<product>`                                   | One library product: licenses, device counts, entitlements, devices, purchase    |
| `GET` `/api/products/<product>/export`                            | What is held for the person in one product                                       |
| `DELETE` `/api/products/<product>/data`                           | Remove my data from this app (step-up, 5 a minute)                               |
| `POST` `/api/products/<product>/support-code`                     | The person's readable support code for this product, `XXX-XXX-XXX` (10 a minute) |

Removing a license from the library leaves it with its email, so it waits for an account that verifies that address. An auto-attach block keeps it out of this account until its key is added again. Package tokens for it are revoked and its devices keep counting toward the limit. Only a `removable` license can go: a sign-in license, a Discover claim or a keyless store or developer license answers `409 not_removable` with `reason` `no_active_key` or `key_claim_off`.

A license's `origin` is `key`, `store-key`, `store`, `developer` or `signin`. Locker and the kits show `signin` as **Sign-in**; the console says **Automatic grant**.

The activate preview takes `{ "key": "<license key>" }`, rejects anything that isn't a license key shape with `422`, and returns a `verdict`.

| Verdict          | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `addable`        | The key can be added. Carries the license, platforms, device count, Cloud Sync |
| `already_yours`  | Already in this account                                                        |
| `license_owned`  | In another account. A license never moves by its key                           |
| `email_mismatch` | Carries an email this account hasn't verified, masked in `maskedEmail`         |
| `portal_off`     | The product manages this license elsewhere                                     |
| `unknown`        | No such key, or no such product                                                |

Every answer carries `product` (`null` for `unknown`, so a guess never reveals a product) and `keyEntries` (`{ used, limit }` on a product with Identity on, else `null`). Previewing writes nothing and never counts. The signed-out `key/preview` answers `{ product, verdict, license, keyEntries, upgrade }` with `upgrade` of `forced` or `skippable`, never an email or license id, and allows 10 per minute per network.

## Downloads

| Route                                                                     | Purpose                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `GET` `/api/releases`                                                     | The downloads the account can reach                      |
| `POST` `/api/releases/<product>/<releaseId>/artifacts/<artifactId>/token` | Mints a single-use download token                        |
| `GET` `/api/products/<product>/downloads?channel=<channel>`               | One product's files, store links and install sources     |
| `POST` `/api/products/<product>/email-download`                           | Emails the account a link to the download for a platform |

Downloads are gated by three things at once: the product's Locker being on, the Release service being on, and, for a `licensed` artifact, a usable license linked to the account. A refusal for an account with no linked license is `404`. An owner is told why: `404 file_not_found`, `403 license_inactive`, `403 not_entitled` or `409 not_hosted`.

Redemption re-runs every check and spends the token with a single conditional update, so two concurrent redemptions can't both win. A `public` file redirects to the bytes host. A non-public file redirects there with a download ticket bound to that file's name and SHA-256, valid 120 seconds, which needs the Worker secret `DOWNLOAD_TICKET_KEY`. Without it such files read `not_hosted`. A file whose stored copy is missing reads `not_hosted` too. A browser follows the redemption with `?p=<product>`: a refused redemption sends it back to the product's page in Polaris Locker with `download=failed`, while an API caller keeps the 404. A resume (one `Range` starting at byte 1 or later, as a browser's Resume sends) keeps the ticket valid for 15 minutes past the 120 seconds, for the same file only.

Email download takes `{ "platform": "macos" }` (one of `macos`, `ios`, `android`, `windows`, `linux`, `web`), answers `202`, and is limited to 5 an hour per account and product. The link opens the signed-in app, never a token.

## Sign in on another device

| Method | Path                        | Who                    | Purpose                                                |
| ------ | --------------------------- | ---------------------- | ------------------------------------------------------ |
| `POST` | `/api/device-login/start`   | The new device         | Creates a request: a code, a QR code and a poll handle |
| `GET`  | `/api/device-login/<id>`    | The new device         | Polls; once approved, the answer signs this browser in |
| `POST` | `/api/device-login/lookup`  | The signed-in approver | Shows what is asking, reads only                       |
| `POST` | `/api/device-login/approve` | The signed-in approver | `{ code, decision: "approve" or "deny" }`              |

Start answers `201` with `id`, an 8-letter `code` from the consonant alphabet, a QR code of the approve link, `expiresIn` (300) and `interval` (3). It sets `__Host-pkey_device_login` to bind the request to this browser. Poll without that cookie, or for an unknown or expired request, is `410 expired`. Lookup and approve share 10 calls a minute per account. Approving from another country, or from an unknown place, needs a step-up. An approval is not a sign-in: the new session carries the approver's sign-in time, so it is never fresh enough for a step-up.

## Per-product settings

The admin route `/manage/api/products/<slug>/identity/portal` (`GET` and `PATCH`) holds the product's Locker settings. See [Locker](/docs/features/sign-in/customer-portal/).
