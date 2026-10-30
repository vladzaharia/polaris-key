---
sidebar:
  order: 8
title: "Steam storefront"
description: "What Polaris Key does for a product on Steam: reads the app's builds and branches, sets a build live on a named branch, and, for the store page Steam lets no API edit, a copy card, the generated asset pack and a per-app checklist."
type: "reference"
lastReviewed: "2026-10-28"
---

Steam has no listing API. None of the Steamworks Web API's 33 interfaces edits a store page, so
the store page's text, capsules, screenshots, trailers, tags, content survey and both reviews are
done in Steamworks. For a product on Steam, Polaris Key does what Steam does allow, and prepares the rest:

- it **reads** the apps the publisher key may act on, the app's builds and its branches;
- it **sets a build live on a named branch** (`beta`, `staging`, a playtest branch);
- it shows a **copy card** of the store page's text, pre-filled from the
  [shared listing](/docs/features/ship-builds/channels/polaris-key/), and serves the **asset pack** that
  [`pkey listing assets`](/docs/features/ship-builds/channels/polaris-key/#listing-assets) made at Steam's sizes;
- it keeps a **checklist** of the human steps, with links to the Steamworks pages.

Depots are uploaded from the release workflow's steamcmd step (the VDFs `pkey transport steam`
writes), never from the Worker. Users and permissions, app credits, pricing, and branch or depot
deletion are never automated.

## The app and the key

The app is the `appId` of the product's `steam` channel in `.pkey/distribution` (the lowest channel
id when there are several). A product being set up for Steam, with no Steam channel yet, uses the
app a platform admin assigned to it in Store connections.

The key is the product's own `steam-publisher-key` channel credential, pinned to that app id and set on the channel page's **Setup** tab (**Ship builds → Channel setup → Steam**). With
no key of its own, the product uses the platform's Steam group key (`steam.publisher-key`), and only
for the app assigned to it. A key pinned to another app is never used. Without an app and a key,
the Steam page says what is missing and makes no Steam call.

## Store identity

Commerce needs to know which Steam app a purchase belongs to (`appId`). You do not have to type
it: it comes from the app the product is assigned on Steam.

- **Where it comes from.** The pin of the product's own active Steam publisher key, if it has one; otherwise
  the platform pin a platform admin set under **Platform → Store connections**. A product admin
  holding `keys` sets the own-key pin, so that person can move the app too.
- **A typed value wins.** If you type `appId` in the commerce settings, Commerce uses it. When it
  differs from the assigned app, Commerce → Overview shows an attention item naming both. **Use the
  assigned app** drops the typed value and follows the assignment.
- **Type it once to pin it.** While the field is left out, adding a key with a lower id or
  re-pinning one moves the app whose purchases unlock the flag, with no change in Commerce. Type
  the value once to fix it.
- **Two own keys that name different apps** raise an attention item; the lowest key id is used
  until you retire one on Keys. An own key with no pin hides the platform pin, and the store stays
  off (`own_credential_unpinned`).
- **No app assigned, no store.** A store with no app typed or assigned stays off.

A channel in `.pkey/distribution` that names a different app than the assignment raises the same
kind of attention item on Ship. More in [Commerce](/docs/features/commerce/#store-identity).

## Builds and branches

On the channel page, **Releases** lists the app's branches with the build live on each, the newest builds, and, for each
release track the channel's `branches` map declares, the build on its branch. The default branch is
`public`.

**Set live** puts a build on a named branch. The console sends one `Idempotency-Key` per action:

- if the branch already shows that build, nothing is sent;
- otherwise Polaris Key calls `SetAppBuildLive` and reads the branches again, and the answer is
  Steam's own state, not the request;
- the action is one row in the store operations ledger and one audit entry
  (`distribution.steam.branch.set_live`), and the same key again replays it.

**The public branch is set live in Steamworks App Admin,** from the link the page gives. Polaris
Key does not set it live: it has not yet been verified that a group-scoped key may do so. The Builds read shows when the public branch has the build. Once the key is
verified, this release needs the app's name typed to confirm, like a release on every other
store.

## Listing

Steam's fields are copy cards from the shared listing ([Storefront listing](/docs/features/ship-builds/channels/polaris-key/#storefront-listing)): you paste them in Steamworks, so they are imported and shown, never pushed. The name, developer, accent and icon default to Presentation (Settings → Presentation); a field the listing sets wins. A store-specific value is an override (**Settings → Presentation → Listing**, pick the storefront).

## The store page

**The copy card** shows Steam's text fields for each locale of the shared listing: the name, the
short description, the description and the tags. A Steam override in the shared listing replaces the model's value.
Nothing is cut: the value is shown whole, as you paste it. A missing name is red, and a short
description over the 300 characters Steam recommends is amber.

**The asset pack** is the ZIP `pkey listing assets` uploads as `pack:steam`: the header, main,
vertical and small capsules, the library capsule, header, hero and logo, the page background, the
community and shortcut icons, the fitted screenshots and the fit report. It downloads from the
Steam page. Until CI has made one, the page says so.

## The checklist

These steps Steam neither lets an API do nor reports. You tick each when it is done. A tick is your
word, never a verification: the page shows it as unverified. Ticks are kept per product and per app,
and every tick and untick is audited (`distribution.steam.checklist.tick`, `…untick`).

| Step              | Notes                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| App fee paid      | $100 per app, in Steamworks                                                        |
| 30 days passed    | Steam's wait between paying and release; the page shows the date from the fee tick |
| Store page public | the page must be up at least two weeks; the page shows the earliest release        |
| Store review      | typically 3 to 5 business days; submit at least 7 ahead                            |
| Build review      | once approved, later builds need no review                                         |

## Limits

Steam allows 100,000 Web API calls a day per key. A call Steam refuses with 403 rate-limits the
address it came from, and that address is shared by every product on the Worker, so **the first
403 stops every Steam call** on that key until the day ends. The page then says calls are stopped.
Every call counts against the day; the page shows what is left.

## The console API

Narrative-only (not in the wire spec), under
`/manage/api/products/<slug>/distribution/storefronts/steam`. Platform admins only.

| Method | Path                     | Does                                                                                                                                                |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | (none)                   | the plan: what is API and what is a link, the app and key, links, checklist, copy card, asset pack, recent operations and the budget. No Steam call |
| `GET`  | `apps`                   | the apps the key may act on, and whether the product's app is among them                                                                            |
| `GET`  | `builds`                 | branches, builds, the declared release tracks' branches and the public branch's build                                                               |
| `POST` | `branches/<branch>/live` | `{ buildId, description? }` with an `Idempotency-Key`; `public` answers 409 with App Admin's link                                                   |
| `GET`  | `pack`                   | the asset pack, as a download                                                                                                                       |
| `PUT`  | `checklist`              | `{ item, done }`, where `item` is `fee_paid`, `release_wait`, `coming_soon`, `store_review` or `build_review`                                       |

A request Steam's write gate refuses answers 422 with `reason: "steam_gate_refused"`; a stopped key
answers 429 (or 502 for the 403 that stopped it) with `reason: "steam_stopped"`.
