---
title: "Console tour"
description: "The suite shell: every nav section, what each tab manages, and the screen a deep link into a disabled service shows."
sidebar:
  order: 2
---

The console at `/manage` is a single-page app with hash routing (`#/p/<slug>/<tab>`) so deep
links and back/forward work without a server round trip. Its whole nav is generated from one
table (`SECTIONS` in `packages/admin/src/route.ts`), and this page walks that table section by
section. Everything here is a description of the shell; the mechanics behind each tab have
their own pages, linked as they come up.

## Signed in as a platform admin

There is exactly one admin identity: signed in, or not. `handleMe` returns either every product
you may administer or none — there is no per-product grant, and a product's manifest
`adminGroup` field is display metadata that authorizes nothing (see
[Products](/docs/admin/products/)). The **Dashboard** (`#/`) reflects this directly: it lists
every product your session can reach with no "your access" branch to speak of, and a product
switcher in the header moves between them.

`#/products` is the platform registry — the flat list of every product, independent of which
one you're currently viewing. See [Products](/docs/admin/products/).

## Platform

Accent `core`. Unlike every other section, Platform has no owning service and is never hidden:
an operator has to be able to reach **Services** even for a product that runs nothing at all.

| Tab          | What it's for                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** | The product's setup health at a glance — a "needs attention" strip when something required is missing, a guided checklist (trust key, required secrets, license defaults, "issue a test license"), the SDK trust key + trust set JSON, and a starter snippet. See [Products](/docs/admin/products/#setup-health). |
| **Services** | Which of the six services this product runs, and its device-registration policy. See [Services & enablement](/docs/admin/services-enablement/).                                                                                                                                                                   |
| **Devices**  | Every device of the product, including those that hold no license: filters, summary chips, a detail drawer, deauthorize and reset-binding. See [Licenses & devices](/docs/admin/licenses-and-devices/#devices-product-wide).                                                                                      |
| **Secrets**  | Write-only product secrets, plus the required-secrets checklist the setup health strip is drawn from. See [Secrets & keys](/docs/admin/secrets-and-keys/).                                                                                                                                                        |
| **Activity** | The product's audit log, keyset-paginated. See [Activity](/docs/admin/activity/).                                                                                                                                                                                                                                 |
| **Settings** | Registry fields: display name, per-license defaults (offline days, device limit), the `adminGroup` metadata field, signing-key rotation, and the destructive "disable product" action. See [Products](/docs/admin/products/) and [Secrets & keys](/docs/admin/secrets-and-keys/).                                 |

## License

Accent `license`. Shown only when the product's **License** service is on. Three tabs answer one question at
different distances: on what terms does a machine get a seat.

| Tab                           | What it's for                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Licenses**                  | The list of license holders; opens each into a detail page with policy, keys, devices and catalog-validated overrides. Creating one mints its first key, shown exactly once. See [Licenses & devices](/docs/admin/licenses-and-devices/).                                                                               |
| **Tiers**                     | Reusable templates — a profile plus policy, channel and version-window defaults — a license can be assigned. Delete is refused (409) while any license still references the tier.                                                                                                                                       |
| **Enrollment & fingerprints** | The device-registration policy (read-only here — it's edited under Services) and the fingerprint policy: enforcement mode, drift tolerance, and the manifest-declared probe list. See [Licenses & devices](/docs/admin/licenses-and-devices/#fingerprint-policy) and [Fingerprints](/docs/services/core/fingerprints/). |

## Config

Accent `config`. Shown only when **Config** is on.

| Tab          | What it's for                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**  | The product's config schema — every `ConfigEntry` (config / secret / flag), grouped by category, read-heavy, with a "Publish new version" flow for a new `schemaVersion`.                                                                            |
| **Profiles** | Named, reusable managed payloads a tier or license inherits. Editing happens on a routed detail page rather than a modal — a payload can be as large as the whole catalog. Delete is refused while any tier or license still references the profile. |

## Release

Accent `release`. Shown only when **Release** is on. One tab: **Releases** — the release _truth store_
(`release_metadata`, `release_builds`, `release_artifacts`, the yanks and the channel policy),
what Polaris Key believes the product publishes, read without spending a GitHub round-trip.
Expand a release to see its builds (platform, arch, format, build number, minimum OS, payload
SHA-256) and the files under each, with where the bytes live (R2, GitHub, a store or an external
URL). Signature and checksum sidecars stay collapsed until you show them. A yanked release
carries a badge with its reason.

The **Channels** panel shows, per channel of the app, what it serves on every platform, its
pointer and pin, what it includes, its minimum supported version, the critical flag, the
rollback floor, its source (`manifest` or `admin`) and the last change. The per-platform column
is the Worker's resolution, shown as it is: a release missing one platform's build leaves that
platform on the newest release that has one. From a channel's actions you can promote, pin,
unpin, set the minimum supported version, mark or clear critical, lower or clear the rollback
floor, and hand an `admin` row back to the manifest. Yank and unyank sit on each release row.
Every action opens a confirmation stating its effect, and every change but the revert belongs to
the operator and survives a resync. See [Channels](/docs/services/release/channels/).

Release health (GitHub App access, the latest release's artifacts — each declared one, or a
list of what was published — Sparkle key material, channel floors) and
the last manifest-sync attempt sit below. Release config itself — GitHub coordinates, binary
name, channel workflow, edge-mint recipes — is authored in the repo's `.pkey/release` file and
applied by **Resync from repo**, not edited here.

## Distribution

Accent `distribution`. Shown only when **Distribution** is on (which requires Release — see
[Services & enablement](/docs/admin/services-enablement/#coherence-errors)). One tab:
**Overview** — the Release ← Distribution ← Update chain as this product runs it, and which of
Core's descriptor hooks answer for it (`releaseCatalog` from Release; `delivery` and
`outletCapabilities` from Distribution). It is read-only: outlets, transports, availability and
rollouts are not configurable yet. See [Distribution](/docs/services/distribution/).

## Update

Accent `update`. Shown only when **Update** is on (which requires Distribution — see
[Services & enablement](/docs/admin/services-enablement/#coherence-errors)). One tab: **Update
settings** — who may read the appcast/version feed (`metadataAccess`) and who may download the
binaries it points at (`artifactsAccess`), each one of `public` / `authenticated` / `licensed` /
`entitled`, plus the compatibility window (`compatMin`/`compatMax`) every grant is intersected
with. This is also where the compatibility window moved to — it used to live in product
Settings.

## Identity

Accent `identity`. Shown only when **Identity** is on. One tab: **Sign-in & portal**, itself two cards:

- **Customer portal** — the per-product module toggles (portal enabled, OIDC account linking,
  email magic links, license-key claim, release downloads) and the tri-state automatic
  license-linking setting (`auto` / `on` / `off` — `auto` follows whether the product's OIDC
  issuer is the platform's own).
- **OIDC & provisioning** — a read-only explainer. The admin API exposes no endpoint for a
  product's OIDC provider, custom-provider fields, group→tier map, or provisioning hooks; all of
  it is authored in `.pkey/product` and applied by **Re-sync from linked repo**. This card is
  intentionally not a form.

## When a service is disabled

Every one of the sections above except Platform only _exists_ when its service is on — the nav
does not grey a row out, it drops it (D-15). But a bookmark, a shared URL, or a service someone
turned off in another tab can still point a hash route at a section the current product doesn't
run. Rather than firing requests the worker would answer with `404`/`409` and leaving you
looking at a broken table, the console renders one explanation, naming the section it substitutes
for (`License`, `Config`, `Release`, `Update` or `Identity`):

> **The `<section>` service isn't enabled** — this product doesn't run the `<section>` service,
> so there is nothing here to manage. Turn it on under Platform → Services and this view comes
> back.

with one action — **Enable services** — that jumps straight to the Services tab. This is an
affordance decision, not a security boundary: every one of these endpoints gates itself the same
way regardless of what the nav shows, so the screen exists to explain a `404` you'd otherwise
have to guess at, not to stand in for the check.

While a product's enablement is still loading, every section is shown rather than hidden —
hiding first and revealing a beat later would make the nav jump under your cursor, and a deep
link into a section that turns out to be enabled would flash this screen for no reason.

## Where the model lives

The nav table itself — which tab belongs to which section, which service gates it, and the
accent each carries — is `SECTIONS` in `packages/admin/src/route.ts`. For the enablement
mechanics behind "shown only when," see
[The service model](/docs/start/service-model/) and
[Services & enablement](/docs/admin/services-enablement/).
