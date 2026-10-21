---
title: "Channel credentials"
description: "A product's own store keys and the Sentry integration secret: the kinds, how they are sealed, pinned and audited."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 15
---

**Role required:** Platform admin.

**Distribution → Channel credentials** holds the keys the Distribution service uses to reach a store
on the product's behalf, and the Sentry integration secret. They are **not** product
secrets, and the difference is the point. Edge-mint can sign with any product secret an operator
marks _edge-mint_, for any device of the product — and under open registration anyone can be a
device — so a store key stored as a product secret would be one approval away from a public
token mint for your App Store Connect account. Channel credentials live in their own table under
their own encryption binding: a value copied into the product-secret table does not even decrypt
there, and no edge-mint recipe can name one.

A product with no outlet credential of a kind can instead use the platform's team-level
credential for that store, for the one app assigned to it (see [Store connections](/docs/operate/platform/connections/)).

The kinds:

| Kind                             | Value                                                     | Least privilege                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Connect API key        | key ID, issuer ID and the `.p8` file (a P-256 PKCS#8 key) | A **team** key with the **App Manager** role — not Admin.                                                                                                                                            |
| App Store webhook secret         | the shared secret App Store Connect signs webhooks with   | Used only to verify Apple's webhook calls; let the Worker generate it.                                                                                                                               |
| Google service account           | the service account's JSON key file                       | Invite the account to **one app** in Play Console with release permissions only ([Google Play connector](/docs/features/ship-builds/channels/google-play/#least-privilege-for-the-service-account)). |
| Microsoft Partner Center app     | tenant ID, client ID, client secret and seller ID         | An Entra app added to Partner Center with the **Manager** role, not Account admin ([Microsoft Store connector](/docs/features/ship-builds/channels/microsoft-store/#the-partner-center-app)).        |
| Sentry internal integration      | the integration's client secret                           | Used only to verify Sentry's alert webhooks; the Worker never calls Sentry ([Update health](/docs/features/ship-builds/channels/update-health/#sentry-alerts)).                                      |
| App Store In-App Purchase key    | key ID, issuer ID and the `.p8` file (a P-256 PKCS#8 key) | Created under **Integrations → In-App Purchase** — not an App Store Connect API key. Pinned to the bundle id ([Commerce bridge](/docs/features/commerce/#app-store)).                                |
| Steamworks Web API publisher key | the 32-hex-digit publisher key                            | A publisher key from a Steamworks group that can see only this game, pinned to its app id ([Commerce bridge](/docs/features/commerce/#steam)).                                                       |

Each is validated when you save it — a `.p8` that is not a P-256 PKCS#8 key, or a Google key that
is not RSA or names a token endpoint other than `https://oauth2.googleapis.com/token`, is refused
and nothing is stored. Of a Google key file only `client_email`, `private_key` and `token_uri` are
kept.

The rules, all enforced by the Worker rather than by the console:

- **Platform admins only, write-only.** `/manage/api/products/<slug>/outlet-credentials/<id>` (PUT)
  with `{kind, value, pin?, outletId?, expiresAt?}` seals and stores the value and echoes the **id
  only**. Saving to an existing id of the same kind rotates it in place (and clears its health);
  saving a different kind to an existing id is refused (409) — delete it first. No `.pkey/`
  manifest, resync or service can write one. For an App Store webhook secret, send
  `{kind: "asc-webhook-secret", generate: true}` instead of a value: the Worker generates 32 random
  bytes and stores them without ever returning them, and the
  [App Store Connect connector](/docs/features/ship-builds/channels/app-store/)'s "register
  webhook" control hands them to Apple.
- **Metadata only on read.** `GET …/outlet-credentials` lists each credential's kind, outlet,
  non-secret identifiers (key ID, issuer ID, client email, tenant, client and seller IDs), when it
  was created and by whom, when it was last used, and the last result a connector reported. There
  is no endpoint that returns a value.
- **Every use is audited.** Only the Distribution service can open one, and each open writes an
  `outlet_credential.use` row to the product's activity log with actor `system:distribution` and
  what it was for (for example `asc:poll`) — including opens that failed. Connectors check their
  cache of short-lived tokens first and open the credential only when they need a fresh token, so
  this is tens of rows a day per credential, not one per request; a request served from the cache
  is not logged and does not move **Last used**.
  Your own writes are audited as `outlet_credential.set`, `outlet_credential.pin` and
  `outlet_credential.delete`.
- **You pick the app, not the repo.** An App Store Connect key is a team key: it can see every app
  in the team. So it carries a **pin**, the App Store Connect app id (the app's numeric Apple ID)
  of the one app it may be used for in this product, and its connector runs only while the
  product's `.pkey/distribution` names that same app. Send it as `pin` with the key (the form asks
  for it), or alone — `{"kind": "asc-api-key", "pin": "1234567890"}`, no `value` — to re-pin a
  stored key without pasting the `.p8` again (**Pin…** in a row's menu). A rotation that leaves `pin`
  out keeps the old pin. Each change of a pin is audited as `outlet_credential.pin` with the old
  and the new app id. A key with no pin, or a pin naming another app than the manifest does, is
  stored but unused: see
  [the connector's setup](/docs/features/ship-builds/channels/app-store/#pinning-the-app). The
  list shows the pin with the key's metadata (`meta.appleId`), and `pins` maps each kind that
  takes one to its field. A **Google service account** is pinned the same way, by the Play app's
  package name (`{"kind": "google-service-account", "pin": "gg.acme.dice"}`, `meta.packageName`),
  because one account can be invited to several apps: see
  [the Play connector's setup](/docs/features/ship-builds/channels/google-play/#pinning-the-app). A
  **Microsoft Partner Center app** is pinned by the Store ID (`{"kind": "ms-partner-center",
"pin": "9NBLGGH4R315"}`, `meta.productId`), because its Manager role reaches every app of the
  seller account: see
  [the Microsoft Store connector's setup](/docs/features/ship-builds/channels/microsoft-store/#pinning-the-app).
- **Deleted with the product,** and re-sealed by the KEK rotation sweep like everything else on
  this page (its own `outletCredentials` bucket in `/manage/api/products/kek` (GET)).

**Delete…** (in a row's menu, `DELETE …/outlet-credentials/<id>`) removes the value for good;
connectors that used it stop working until a new one is set. In the console, **Set credential…**
asks for the kind first, then its fields and its pin; **Rotate…** in a row's menu replaces a stored
value, and typing an existing id in Set credential warns that saving rotates it. Each row shows
the last result a connector reported, as text. Below the table, **Store connectors** shows each
connector's state and its configuration actions.
