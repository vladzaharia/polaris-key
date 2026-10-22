---
title: "Polaris Locker"
description: "The account surface customers use across your products: sign-in methods, library, devices, downloads, the activate link and per-product settings."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 6
---

Polaris Locker is a self-service account surface. A customer signs in once, sees every license they hold across every product on the deployment, adds more by key, manages their own devices and downloads the releases they are entitled to. Its code lives in the Identity service, but its routes aren't product-scoped. The route table is in [Locker API](/docs/reference/portal-api/). Customers use it at polaris.locker.

## Root-level routes

`/login`, `/callback`, `/logout`, `/magic/verify`, `/api/*`, `/download/<token>` and `/media/*` are reserved ahead of every product slug. One account can hold licenses for several products at once, so no single product could own these paths.

The Identity flag doesn't gate Locker. A product with Identity off has no `/identity/*` routes, yet its customers still see its licenses in Locker, claim them by key and manage their devices. The product's Locker switch decides that, never `services_json`. The one service flag Locker reads is Release's: release downloads need the Release service on.

## Signing in

The login card on `polaris.locker` is the only place a Locker account's credentials are entered, for Locker and, through the passthrough, for every app. It is identifier-first: the email, then the methods.

- **Connections.** Upstream OpenID Connect providers. `/login` starts the seeded platform connection, and `/login/sso/<id>` starts any other active platform connection whose audience covers customers. A flow is single-use and bound to the browser that started it. The redirect URI is `<origin>/callback` for every connection. Operators sign in to the console through a separate client.
- **Email code and magic link.** One email carries a 6-digit code and a link. The link's landing page consumes nothing, so a mail scanner can't burn it, and its button posts the token back. A link opened on another device only confirms the asking browser's flow; it never signs the other device in. The answer is identical whether or not the address is known.
- **Passkeys.** A passkey is an account sign-in method, platform-wide and independent of any product's Identity toggle. It signs in only to the account it was added to. Passkeys enroll only after the account has a verified email.
- **Work and school addresses.** An address whose domain is DNS-verified by an active platform connection goes to that organization's sign-in. Matching is exact: `example.edu` never routes `students.example.edu`. A connection can be enforced, which refuses email codes for the domain.
- **The email gate.** On a provider's first sign-in, while the account has no confirmed email, or when a product's terms version isn't accepted yet, a gate opens before any account or session exists. An address the provider vouches for passes without a code: Apple's, or a Google address that is `@gmail.com`, `@googlemail.com` or in the token's `hd` domain. A typed address gets a code. If the address belongs to another account, the gate offers a join and never joins silently: the person proves both accounts in the same browser.

Every `returnTo` must be same-origin and may not target `/manage`, so a link can't pivot a visitor into the console.

## Sessions

The cookie is `__Host-pkey_portal`, with the `__Host-` prefix so a sibling subdomain can't plant a competing one. It names a server-side session row, which is the authority. That makes sessions listable and revocable, and sign out everywhere real. The dispatcher strips the account realm's cookies from product routes.

Sensitive actions need a recent sign-in, within 5 minutes: adding or removing a method, a new key, exports and account deletion. A session created by approving a device on another device is never fresh enough for these until its holder signs in on it.

Account deletion is scheduled for 14 days later and can be canceled in that window. Licenses stay: they are the product's records.

## Sign in on another device

A device that isn't signed in shows a code and a QR code. A signed-in device approves or denies the request after seeing what is asking and from where. Approving from another country, or from an unknown place, needs a recent sign-in. The code lives 5 minutes.

## The activate link

`https://polaris.locker/activate` opens the library with the **Activate license** dialog. A key in the link goes in the fragment, which a browser never sends:

```text title="Activate link"
https://polaris.locker/activate?product=<slug>#key=<license key>
```

The page reads the key, then removes the fragment from the address bar and history before doing anything else. Never put a key in a query parameter: every request log records the query. The Worker never builds a link with a key in it, so `manageUrl` on a refusal carries none.

Locker keeps these query parameters and drops the rest:

| Parameter          | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `product=<slug>`   | Names the app that sent the person, and why                                         |
| `next=free-device` | After the key is added, opens the free-device flow for that license                 |
| `for=<label>`      | The device the free-device flow makes room for, up to 64 characters                 |
| `return=<url>`     | Where to go after: the login card on this origin, or an origin the product declares |

The Worker states the link for each product in its discovery document (`core.portal`): `{"enabled":true,"activate":"https://polaris.locker/activate?product=<slug>"}`, or `{"enabled":false}` while the product's portal is off. The terminal kits print that link on a refusal, and print "Contact {developer}" instead while the portal is off. A discovery cache lag of up to 5 minutes can delay a change.

A `for` or `return` that holds a key is dropped. The older `/activate?key=…` form still works and is dropped the same way, but the key stays in that one request's logs.

## Emails

Every email is from Polaris Key (`PORTAL_EMAIL_FROM`) and names the product and device, not slugs or ids. Security notices go to every verified address on the account and carry "Wasn't you? Secure your account". Only the sign-in link carries a token.

| Email                 | Goes to                |
| --------------------- | ---------------------- |
| Sign-in code and link | The address typed      |
| Email confirmation    | The address confirmed  |
| License added by key  | The session's address  |
| Download link         | The account's address  |
| Device removed        | Every verified address |
| New device signed in  | Every verified address |
| Account deleted       | Every verified address |

## App sign-in settings

Each product has Locker settings, edited on **App sign-in**. They default on for a product that never wrote a row: `portalEnabled` and `discoverEnabled`. These default off:

- `keyReissueEnabled`: customers may replace a license's key from Locker.
- `claimByKey`: a license that carries an email may be added by anyone holding its key. Off is the safe default: such a license joins only an account that verified that email. A license already in an account never moves by its key either way.

Email codes and passkeys are always on, platform single sign-on is on while a connection signs customers in, and adding a license by key is always on. There are no per-product switches for them. A domain's owner turns the email methods off for that domain's addresses by enforcing it under **Platform → Connections**. Downloads follow the product's Release service. Automatic linking has no switch either. It derives from the issuer that vouched for the license's address: on for the platform issuer, off for a product's own custom issuer, because a tenant-controlled provider's `email` and `sub` are outside the platform's trust boundary. The issuer class is recorded on the license when its address is written, so editing `oidc.provider` later can't turn a tenant-minted license into one that auto-links.

Only addresses Locker proved (a magic link it sent, or `email_verified: true` from the platform issuer) can drive a link, and only a platform-issuer subject can match a license's `sub`.

The Polaris Locker card on **App sign-in** holds the Locker switch and key reissue.

### Polaris Locker listing

Four operator-owned fields hold a product's listing: `storeListed` (`auto`, `listed` or `unlisted`), `storeAudience` (`eligible` or `everyone`), `storeOfferPaths` and `storeGroupLabels`. `auto` offers the product where auto-issue or a mapped group would give it. `unlisted` hides it while sign-in and auto-issue keep working. Widening the audience to `everyone` shows the product to every signed-in person, so the `PATCH` needs `"confirm": "storefront.polarisKey.audience"`. The platform setting `storefront.polarisKey.enabled` hides every listing when off.

## Supported browsers

Locker's styles need cascade layers, `@property` and `color-mix()`: Safari 16.4 or later, Chrome 111 or later (Edge too) and Firefox 128 or later. An older browser reaches every route but renders mostly unstyled, so check the browser first when a customer reports a broken page.

## Next steps

- [Locker API](/docs/reference/portal-api/): every route and its gates.
- [Product sign-in provider](/docs/features/sign-in/oidc/): the provider a platform product shares with Locker.
- [Browser sessions](/docs/features/sign-in/sessions/): the product-scoped cookie this one is not.
