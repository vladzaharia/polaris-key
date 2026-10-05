---
sidebar:
  order: 8
title: "Steam storefront"
description: "What Polaris Key does for a product on Steam: reads the app's builds and branches, sets a build live on a named branch, and, for the store page Steam lets no API edit, a copy card, the generated asset pack and a per-app checklist."
---

Steam has no listing API. None of the Steamworks Web API's 33 interfaces edits a store page, so
the store page's text, capsules, screenshots, trailers, tags, content survey and both reviews are
done in Steamworks. For a product on Steam, Polaris Key does what Steam does allow, and prepares the rest:

- it **reads** the apps the publisher key may act on, the app's builds and its branches;
- it **sets a build live on a named branch** (`beta`, `staging`, a playtest branch);
- it shows a **copy card** of the store page's text, pre-filled from the
  [shared listing](/docs/admin/storefront-listing/), and serves the **asset pack** that
  [`pkey listing assets`](/docs/build/ci/#listing-assets) made at Steam's sizes;
- it keeps a **checklist** of the human steps, with links to the Steamworks pages.

Depots are uploaded from the release workflow's steamcmd step (the VDFs `pkey transport steam`
writes), never from the Worker. Users and permissions, app credits, pricing, and branch or depot
deletion are never automated.

## The app and the key

The app is the `appId` of the product's `steam` outlet in `.pkey/distribution` (the lowest outlet
id when there are several). A product being set up for Steam, with no Steam outlet yet, uses the
app a platform admin assigned to it in [Store connections](/docs/admin/store-connections/).

The key is the product's own `steam-publisher-key` outlet credential, pinned to that app id. With
no key of its own, the product uses the platform's Steam group key (`steam.publisher-key`), and only
for the app assigned to it. A key pinned to another app is never used. Without an app and a key,
the Steam page says what is missing and makes no Steam call.

## Builds and branches

**Builds** lists the app's branches with the build live on each, the newest builds, and, for each
channel the outlet's `branches` map declares, the build on its branch. The default branch is
`public`.

**Set live** puts a build on a named branch. The console sends one `Idempotency-Key` per action:

- if the branch already shows that build, nothing is sent;
- otherwise Polaris Key calls `SetAppBuildLive` and reads the branches again, and the answer is
  Steam's own state, not the request;
- the action is one row in the store operations ledger and one audit entry
  (`distribution.steam.branch.set_live`), and the same key again replays it.

**The public branch is set live in Steamworks App Admin,** from the link the page gives. Polaris
Key does not set it live: it has not yet been verified that a group-scoped key may do so (the
S-15 decision 5). The Builds read shows when the public branch has the build. Once the key is
verified, this release will need the app's name typed to confirm, like a release on every other
store.

## The store page

**The copy card** shows Steam's text fields for each locale of the shared listing: the name, the
short description, the description and the tags. A Steam override in the shared listing replaces the model's value.
Nothing is cut: the value is shown whole, as you will paste it. A missing name is red, and a short
description over the 300 characters Steam recommends is amber.

**The asset pack** is the ZIP `pkey listing assets` uploads as `pack:steam`: the header, main,
vertical and small capsules, the library capsule, header, hero and logo, the page background, the
community and shortcut icons, the fitted screenshots and the fit report. It downloads from the
Steam page. Until CI has made one, the page says so.

## The checklist

Five steps Steam neither lets an API do nor reports. You tick each when it is done. A tick is your
word, never a verification: the page shows it as unverified. Ticks are kept per product and per app,
and every tick and untick is audited (`distribution.steam.checklist.tick`, `…untick`).

| Step             | Notes                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| App fee paid     | $100 per app, in Steamworks                                                        |
| 30 days passed   | Steam's wait between paying and release; the page shows the date from the fee tick |
| Coming Soon live | the page must be up at least two weeks; the page shows the earliest release        |
| Store review     | typically 3 to 5 business days; submit at least 7 ahead                            |
| Build review     | once approved, later builds need no review                                         |

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
| `GET`  | `builds`                 | branches, builds, the declared channels' branches and the public branch's build                                                                     |
| `POST` | `branches/<branch>/live` | `{ buildId, description? }` with an `Idempotency-Key`; `public` answers 409 with App Admin's link                                                   |
| `GET`  | `pack`                   | the asset pack, as a download                                                                                                                       |
| `PUT`  | `checklist`              | `{ item, done }`, where `item` is `fee_paid`, `release_wait`, `coming_soon`, `store_review` or `build_review`                                       |

A request Steam's write gate refuses answers 422 with `reason: "steam_gate_refused"`; a stopped key
answers 429 (or 502 for the 403 that stopped it) with `reason: "steam_stopped"`.
