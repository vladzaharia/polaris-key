---
title: "Polaris Key: the built-in storefront"
description: "Distribution → Storefronts → Polaris Key: readiness, how the customer portal lists the product, who it is shown to, the ways to add it, group labels, a persona preview and 28 days of analytics."
sidebar:
  order: 15
---

**Polaris Key** is the storefront built into Polaris Key itself: the customer portal's
**Discover** and **Library**. A product listed there is shown to the signed-in people who can add
it, and **Add to library** puts it in their library. Its page in the console is
**Distribution → Storefronts → Polaris Key** (`#/p/<slug>/distribution/storefronts/polaris-key`),
for platform admins.

On the [Storefronts](/docs/admin/storefronts/) page its tile reads **Built in: always connected**.
There is nothing to connect: no credential, no app to assign, and nothing in
[Store connections](/docs/admin/store-connections/). Every operation it performs is marked
**Built in**, and the ones it does not perform say what applies instead (a listed product is
obtained without payment, for example). **Manage** opens this page. Add to storefronts leaves
Polaris Key out, because it is always on.

## Readiness

Five checks, each **Ready**, **Ready, with a note** or **Needs a fix**, with the reason:

| Check           | Ready when                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Customer portal | The portal is on for the product (Identity → Portal)                                               |
| Listing         | The listing has a name, an icon and a short description that fit Polaris Key in its default locale |
| A way to add it | At least one way to add it is offered, or the audience is everyone (a note)                        |
| Get it          | A release download or a live store link; the developer's website alone is a note                   |
| Licence tiers   | Every tier a way to add it issues exists and has a device limit                                    |

For a product that is not listed, the third check counts the ways it would offer once listed.

## Listing and audience

- **Listing.** **Automatic** (the default) shows the product to the people auto-issue or a mapped
  group would give it to, as Discover always has. **Listed** also shows it through every other way
  to add it. **Not listed** shows it to no one in the portal; sign-in, auto-issue and every licence
  keep working. A change asks you to confirm.
- **Audience.** **People who can add it** (the default) or **Everyone signed in**. Everyone signed
  in shows a Listed product to every signed-in person; someone who cannot add it gets a link to
  its store pages or website, never **Add**. It is the one exception to showing a product only to
  the people who can get it, so it asks you to type the product's slug. Going back to People who
  can add it saves at once.

These are the settings `storefront.polarisKey.listed` and `storefront.polarisKey.audience`
([Polaris Key listing](/docs/services/identity/portal/#polaris-key-listing)). The deployment switch
`storefront.polarisKey.enabled` hides every listing when a platform admin turns it off; the page
then says so.

## Ways to add

One switch for each way to add the product that its policy configures. A way that is not
configured is not listed at all:

| Way                       | Configured when                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Members of a mapped group | The product's sign-in maps an IdP group (`groupRoleMap`), on the Polaris Key sign-in      |
| Free with an account      | The product auto-issues to everyone signed in (`autoIssue`, mode `oidcDefault` or `both`) |
| Free to use               | License is off and every download is public or for signed-in people (nothing to license)  |

The first two need the product's sign-in to use the Polaris Key sign-in with automatic licence
linking on. Automatic counts only those two; the rest count once the product is Listed. Turning a
way off asks you to confirm and removes it from Discover and from **Add to library**, so a person
whose only way it was no longer sees the product. Licences already added keep working.

## Group labels

One row per mapped group. A label (at most 40 characters) is what Discover shows: "Included with
Aperture Seven". Without one, Discover says "For members of `<group>`". A label whose group is no
longer mapped is listed so you can clear it. Labels save together, with no confirmation.

## Who can see this?

The ways to add that the listing offers now, in plain words: "Members of `beta` at the Polaris Key
sign-in", "Everyone with a Polaris Key account", "Everyone signed in: it is free to use", and
"Everyone else signed in, with a link to get it" for the everyone audience. People who already
have the product see it in their Library instead.

**Preview a person** describes someone and shows the Discover tile they would see: the reason
line, the terms and the action, or why the product is not shown to them. You choose whether they
signed in with the Polaris Key sign-in, which mapped groups they are in, and whether they already
have it. It is a made-up person: the preview takes no email address and no account, never looks
one up, and writes nothing, not even an impression. So it tells you what your settings do, never
anything about a real person.

## Last 28 days

Impressions, adds and first activations, with the activation rate, in total and per way to add
(and "Link to get it" for the everyone audience). They are daily totals and never per person.

- An **impression** is the product shown to one signed-in person on Discover or its product page,
  once per person per day. A deployment without `KEY_HASH_PEPPER` counts no impressions, and the
  card says so.
- An **add** is **Add to library** creating what its way implies (a licence, or a library entry).
- A **first activation** is the licence's first device, within 7 days of the add, counted on the
  add's day. The newest week's activations are still arriving.

## The console API

Narrative-only, under `/manage/api/products/<slug>/storefronts/polaris-key`. None of them writes.

| Method | Path          | Does                                                                                                                                       |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `polaris-key` | the store's status: `listing`, the configured (`available`) and offered (`active`) ways to add, `groups`, `autoIssue`, `readiness`         |
| `POST` | `…/preview`   | `{platformAccount?, groups?, emailDomain?, stores?, holds?}`: a persona, answered with `{visible, hidden, tile}`; any other field is a 422 |
| `GET`  | `…/analytics` | the last 28 days: `totals`, `byKind`, `daily` and `impressionsCounted`                                                                     |

The page writes through `PATCH /manage/api/products/<slug>/identity/portal` (`storeListed`,
`storeAudience` with `"confirm": "storefront.polarisKey.audience"` when widening,
`storeOfferPaths`, `storeGroupLabels`). Each change is a `storefront.polarisKey.update` row in
the product's activity.
