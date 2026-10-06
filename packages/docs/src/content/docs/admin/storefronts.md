---
title: "Storefronts: Add to storefronts"
description: "Distribution → Storefronts: every store's capabilities from its adapter, and the Add to storefronts flow (prerequisites, listing, assets, plan, run, submit and release) that provisions a product onto them, resumably from the ledger."
sidebar:
  order: 15
---

**Distribution → Storefronts** shows every storefront Polaris Key has an adapter for, and
**Add to storefronts** provisions the product onto any of them in one flow. Both are for platform
admins.

Each store's tile and each step is drawn from what the store's adapter declares: which operations
Polaris Key performs through the store's API, which the release workflow performs in CI, which a
pull request covers, and which you do yourself from a link. The console has no store-specific
code, so a store added to the Worker appears here as soon as its adapter is registered.

## The tiles

One tile per store, with:

- the product's app on that store, assigned in
  [Platform → Store connections](/docs/admin/store-connections/), or "Published from CI" for a
  store with no team connection (itch.io, Snap);
- a capability strip, one row per operation with its badge: **API**, **CI**, **PR**, **Link**, or
  **Not offered** with the reason (Steam's store page, for example, is links only);
- how many of the store's steps are done;
- **Not connected** or **Connection failing** when the team connection needs attention, and
  nothing when it is healthy.

**Set up** opens the flow for that store alone. Store connections' **Set up** on an assigned app
does the same.

## Add to storefronts

The flow's step and the stores chosen are in the URL (`?flow=add&step=…&stores=…`), and its progress
is the Worker's ledger of store operations. Leave at any point and come back, from this browser or
another, and it shows where each store stands.

1. **Storefronts.** Choose the stores. Each shows its progress or its capability summary.
2. **Prerequisites.** Per store: the team connection, the product's app, and the write
   permissions. A missing permission only shows when a step runs, so it reads "Shown by the first
   write" until one succeeds.
3. **Listing.** The [fit report](/docs/admin/storefront-listing/#the-fit-report) for the chosen
   stores, with **Override…** on each field that does not fit, and the import: pick App Store,
   Google Play, Microsoft Store, `.pkey/distribution` or `.pkey/product`, see every field that
   would change, then apply exactly that diff. The Godot project is read by
   `pkey listing import --godot` in CI or a checkout.
4. **Assets.** The slot board (below), for the chosen stores.
5. **Plan.** Every step of every chosen store, in order, with its badge and whether it is typed,
   and the list of every external write Polaris Key will make. Nothing runs from this step.
6. **Run.** One card per step:
   - **API** steps run from their button, after a confirmation that lists what the store receives.
     What the card shows afterwards is the store's own answer, read back after the write.
   - **Link** steps show the values to copy into the store's console (filled from the listing) and
     **Open** the page. A step the store can confirm is checked every 10 seconds for up to 15
     minutes while the page is open, and on **Check now**; one only you can confirm has **Mark as
     done**. A step still waiting when you close the tab is kept as pending.
   - **CI** steps wait for the next publish run and show the command the release workflow runs.
   - **PR** steps name the repository CI opens the pull request against.
7. **Submit and release.** Submit for review, release and any price change are confirmed by
   typing the app's name exactly as the store shows it. Polaris Key reads the name from the store
   and compares it before it sends anything.

A store without a team connection is read-only, with the reason, until a platform admin stores
its credential in Store connections. No step deletes anything: Polaris Key never deletes an app,
a listing, an image, a user, a payment or a signing key on any store.

### What each store runs today

| Store           | Steps Polaris Key runs                                                                                                                   | Done by hand, from a link                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| App Store       | bundle ID; finding the app record by it and assigning it; notifications URL; availability and the first (free) price; a TestFlight group | creating the app record; App Information, App Privacy and screenshots (ticked); submit and release on the App Store page |
| Google Play     | listing text, accepted images and testers, each in one staged edit; sending the staged changes for review (typed)                        | creating the app; content rating, category, store settings and app content declarations                                  |
| Microsoft Store | staging the listing in the app's pending submission (left uncommitted); committing it to certification (typed)                           | reserving the name; the age rating questionnaire                                                                         |
| itch.io, Snap   | none: their steps run in CI                                                                                                              | the store page                                                                                                           |

Google Play's release and staged rollout stay on the [Rollouts](/docs/services/distribution/rollouts/)
page. Replacing Play images never deletes the old ones. After the image step or a listing push,
the card says how many older images Google Play still holds and links the Play Console's main store
listing, where you remove them. Until the product has the Play Console's developer and app ids, the
card names the missing ids instead of the link. The note lasts until you leave the page. A
Microsoft submission someone created or edited in Partner Center is never adopted or changed; the
step names it and links to it.

A link step stays done once it is done: a later check replays the recorded result, even if the
object was removed on the store since.

## The slot board

Every image slot of the listing, grouped by store, from what
[`pkey listing assets`](/docs/build/ci/#listing-assets) registered:

- **Masters** a person makes (icon master, key art, wordmark, screenshots). A missing one is marked
  **Needed** with the store's exact specification, such as "1024×1024 PNG" or "16:9, at least
  3840×2160, no logo or text".
- **Derived** and **composed** outputs (store icons, capsules, feature graphics, posters, fitted
  screenshots) show their preview and wait for **Accept**. Only accepted images are ever pushed.
  Acceptance is for the exact bytes you saw: when CI makes new ones, they wait for a new look.
- An image you uploaded yourself counts as accepted.

## Listing push

**Distribution → Listing → Push** sends a store its listing text and accepted images, outside the
flow, with a plain confirmation. It never submits for review: Google Play always stages the change
(it waits until you send it with the flow's typed **Submit**), and the Microsoft Store keeps its
pending submission uncommitted. A store appears there once its adapter can push a listing.

## The console API

Narrative-only (not in the wire spec), under `/manage/api/products/<slug>/distribution/storefronts`.
A write needs an `Idempotency-Key` header (a new UUID per intent; a retry with the same key replays
the stored result), except the check and accept routes.

| Method | Path                                    | Does                                                                                                                            |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `storefronts`                           | every store: connection, app, capabilities, prerequisites and plan, and the listing's name and locales                          |
| `POST` | `storefronts/<store>/steps/<op>`        | run a step through the store's runtime: `{input?, confirm?}`; submit, release and price are typed (`confirm` is the app's name) |
| `POST` | `storefronts/<store>/steps/<op>/check`  | a link step: `{}` runs its check, `{assert: true}` records one only you can confirm                                             |
| `POST` | `storefronts/<store>/push-listing`      | push the listing: `{}`; always staged where the store stages, never sent for review                                             |
| `GET`  | `storefronts/slots`                     | the slot board                                                                                                                  |
| `GET`  | `storefronts/slots/image?slot=&locale=` | an asset's preview (PNG, JPEG or WebP only)                                                                                     |
| `POST` | `storefronts/slots/accept`              | `{slot, locale?, sha256}`: accept exactly those bytes; `409 asset_changed` when they changed since you looked                   |

A step or push answers `{ok, outcome, opId, resultIds, after}`, where `after` is the store's re-read.
It can also carry `followUp: {count, text, url, missing}`, for what the write left for you to finish
in the store's console, such as Google Play's older images. `url` is `null` while the link lacks
the ids listed in `missing`. The check route treats `poll: true` (sent while the page polls) the
same as `{}`.

Many API steps call the route that already performs them (the App Store's bundle IDs, setup
controls and assignment) instead of these. The audit actions are
`distribution.storefronts.verify`, `distribution.storefronts.assert` and
`distribution.storefronts.accept`; a store write is audited by the store's own ledger step
(`distribution.play.*`, `distribution.msstore.*`).
