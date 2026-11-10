---
title: "Clients"
description: "The console's Clients page: the Sign in with your product switch, registered clients, their secrets and usage, and the Platform issuer keys."
type: "reference"
services: ["identity"]
lastReviewed: "2026-11-10"
sidebar:
  order: 8
next: false
---

**Sign-in → Clients** (`#/p/<slug>/identity/clients`) is where a product turns on [Sign in with your product](/docs/features/sign-in/sign-in-with-product/) and registers the clients that use it. It needs the product's Identity service. Members who can change sign-in edit it; others read it.

## The page

- **Sign in with your product.** One card: the switch, then the issuer and discovery addresses, each with Copy, once it is on. Off, no client signs anyone in and no token is issued; the page shows a notice if clients exist. Turning it off revokes every refresh token; turning it on again asks nobody twice. With no clients yet, the empty list's own button turns it on, with the switch's confirmation.
- **Clients.** Each row shows the name, type, the first host it redirects to and how many more, and people who used it in 30 days. A disabled client carries a **Disabled** pill. A client from `.pkey/product` reads **From .pkey/product**. **Register client** is off while the switch is off and at 20 clients.

## Register a client

The drawer asks for a name, a key (it follows the name until you edit it, and can't change later), a type, redirect and sign-out addresses, what the client gets, which items people can't switch off, and a developer name for a partner. Each refusal names its field: addresses that aren't `https`, a scope list without sign-in, a required item the scopes don't deliver, a name that uses a platform or store name. Registering needs a sign-in from the last five minutes; your entries are kept across it.

## One client

The client page shows its settings with the client id and Copy. **Edit** changes everything but the key. A client from `.pkey/product` is read-only here: **Edit** and **Delete** say so. Only **Disable** and secrets work on it. The client id, the discovery address and the secrets sit on this page together.

- **Generate secret** (a `web` client). A confirmation, then the secret in a dialog that closes only after you copy it or tick "I've stored it". The list keeps `pkeycs_…` and the last four characters, the date and the last use. At most two are live; **Revoke** ends one.
- **Disable** revokes every refresh token; people stay agreed and are not asked again when you enable it. **Enable** needs a fresh sign-in.
- **Delete** removes the client, its secrets, its refresh tokens and what people agreed to. Type the client key to confirm. A manifest client can't be deleted here.

Creating, minting a secret, enabling and deleting need a sign-in from the last five minutes. So does an edit that widens a client: another type, a new redirect or sign-out address, a new scope or a new always-shared item. Renaming, narrowing, revoking a secret and disabling don't. Changing a client's type away from `web` revokes its secrets. Each write is in the product's [activity](/docs/operate/console/activity/).

The developer name a card shows is the client's own claim: Polaris Key checks its length and the reserved platform and store names, not who is behind it.

## Issuer keys

**Platform → Settings → Issuer keys** (Advanced) lists each product that has signed a token: its keys with their state (signing, next, retired) and dates. Keys rotate every 90 days on their own. **Rotate now** is for a leaked key: a **Superadmin** with a fresh sign-in types the product slug and may add a reason; a new key signs and every earlier key is dropped at once. Every token they signed stops verifying, so people sign in again. It is in the product's activity as a rotation.
