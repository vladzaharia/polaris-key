---
title: "Sign-in connections"
description: "The OpenID Connect providers people sign in through: adding one in the console, the test sign-in, verified email domains, enforcement and the seeded platform connection."
type: "reference"
lastReviewed: "2026-10-19"
sidebar:
  order: 14
---

A **sign-in connection** is an upstream OpenID Connect provider people sign in through: a label,
an issuer, a client id and secret, an **audience** (`customers` on the sign-in card, `operators`
in the console, or `both`), a claim map, and the email domains it has proved. Identity owns the
two tables, `identity_connections` and `identity_connection_domains`, and is their only writer;
everything else reads them through Core (`core/oidc/connections.ts`). Every connection signs in
through the Worker's one relying-party client, with discovery, PKCE, `state`, `nonce` and the
issuer's hosts as the only hosts it dials. What the card does with a connection is in
[Customer portal](/docs/features/sign-in/customer-portal/#signing-in).

In the console it is **Platform → Connections**, for platform admins. The page groups the
platform's sign-in plumbing by kind:

- **Single sign-on.** The connections you add, each with its status (On, Off, Needs attention)
  and how many of its domains are verified.
- **Sign-in providers.** Google, Apple and Steam on the sign-in card: On or Not set up, with the
  steps and the redirect URI to register. They still read their `SIGNIN_*` Worker values.
- **Email** and **Turnstile.** Status only.

Every change needs a sign-in from the last five minutes (a step-up) and is recorded in the
platform activity log. A client secret is sealed when you save it and is never shown again; the
page says only "Sealed".

### Add a connection

**Add connection** opens a five-step wizard. Nothing is saved until the last step.

1. **Provider.** Enter the issuer, an https address with no port, credentials, query or fragment.
   **Check provider** reads its discovery document; the page shows the hosts it uses. An address
   that is private or not https is refused before any request.
2. **Client.** Register the redirect URI shown (`<origin>/callback`) at the provider, then enter
   the client ID and, if it needs one, the client secret.
3. **Test sign-in.** **Sign in with** the provider opens it in a pop-up and shows the claims that came
   back: the email, the groups and claims you map, and the names of every claim in the token.
   Nothing is saved, and only the operator who started the test sees the result. **Open in this tab instead**
   does the same without a pop-up and returns to this step; the client secret is not kept
   across that trip, so the last step asks for it again. A provider's error is shown as plain
   text.
4. **Claims.** Name the claim that lists groups, the other claims access rules may use, and the
   claim for a display name.
5. **Add.** Review and add. The connection is for customers; operator sign-in through a connection
   waits for the Superadmin gate.

Then open the connection to claim its domains.

### One connection

The connection's page shows the provider, and **Change** edits the name, client, claim mapping
and replaces the sealed secret. **Show on the sign-in card** turns it off without deleting it. **Test sign-in** on a saved connection
uses its stored secret. **Delete** is refused
while people sign in through it, and for the seeded connection.

**Domains.** **Add domain** shows the TXT record to publish (name and value, with copy buttons).
**Check now** reads it; a verified domain can then be required. **Release** asks first for a verified domain. **Require this connection** stops
email codes and magic links for that domain's addresses, so it asks you to confirm. **Release**
drops the claim.

### The seeded platform connection

The `PLATFORM_OIDC_ISSUER`, `PLATFORM_OIDC_CLIENT_ID` and `PLATFORM_OIDC_CLIENT_SECRET` trio
becomes one row: id `platform-sso`, label "Single sign-on", `source: env`, audience `both`, the
`groups`, `name` and `picture` claims mapped, no domains. It is written on first need, by
`/login`, `/callback` or `/api/capabilities` while single sign-on is on, with the client secret
sealed under `PLATFORM_KEK` (the `_platform` slot, kind `identity-connection`).

- **Once written, the row is the only source.** A later change to the trio does not rewrite it,
  and the seed never overwrites an existing row.
- **No usable KEK, no row.** If the client secret cannot be sealed, nothing is written and single
  sign-on stays off; the next request tries again.
- **Keep the trio set.** A product whose OIDC provider is `platform` still reads it directly.
- **The KEK re-seal sweep does not cover this row.** Keep the key that sealed it in the KEK ring.

### Domains

A connection proves each email domain with a DNS TXT record:

| Name                       | Value                              |
| -------------------------- | ---------------------------------- |
| `_pkey-challenge.<domain>` | `pkey-domain-verification=<token>` |

The token is random, one per connection and domain, so one connection's record never proves
another's claim. The Worker reads the record over DNS-over-HTTPS from `cloudflare-dns.com` only.

- **Exact names.** `example.com` and `sub.example.com` are two claims with two records. A domain
  is plain ASCII, lower case, at least two labels, with no wildcard and no IP literal.
- **One owner.** Within a scope, one connection at a time holds a verified domain; another
  connection's proof of it is refused (`taken`).
- **Re-checked daily.** The nightly maintenance run (`connectionDomains`, 03:17 UTC) asks again
  for every verified domain. An answer without the token unverifies the domain at once. A
  resolver error keeps it verified for 72 hours after the last conclusive answer, then
  unverifies it.
- **Unverified means nothing.** An unverified domain does not route addresses, vouch for them or
  enforce anything.

**Enforce** is set per domain. While the domain is verified, its addresses get no email code and
no magic link on the sign-in card, only the connection; codes and links sent before enforcement
stop working too. Passkeys and the account's other sign-in methods keep working. This is the only way to require single sign-on: products have no switch that turns email codes off.
