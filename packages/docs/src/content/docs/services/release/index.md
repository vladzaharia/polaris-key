---
title: "Release"
description: "GitHub-linked release truth: channels, artifacts, changelog, install script."
sidebar:
  order: 1
---

Release answers one question honestly for every product that turns it on: what software
exists, where did it come from, and who may have it. It is the **truth**, not a feed — a
linked GitHub repository, the channels resolved against it, the artifacts indexed from its
releases, the changelog extracted from their notes, and the install script generated for
them.

A separate service, [Update](/docs/services/update/), renders a live Sparkle appcast and a
version check _over_ that truth. Release itself never renders anything Sparkle-shaped —
`update → release` is the only cross-service dependency the platform allows, which is why
a product can enable Release for plain downloads and a curl-pipe installer without ever
touching Sparkle at all.

## Off by default, and config-only until linked

Like every service beyond the always-on Core substrate, Release is opt-in per product. A
product that has never turned it on behaves exactly as if the routes below did not exist:
the discovery document reports the service absent, and every one of its paths answers the
same `404` a disabled service, an unregistered slug, and a genuinely bad path all share —
telling those three apart is the reconnaissance the platform declines to offer.

Turning Release on and linking a repository are two different steps, and the discovery
document says so explicitly with two separate flags: `enabled` (the product has opted in)
and `configured` (a repo is actually linked). A client that cannot distinguish "on but not
set up yet" from "on and serving" would retry a `404` forever; a client that reads
`configured: false` knows to stop asking.

One coherence rule ties Release to its sibling: a product cannot enable Update while
Release stays off. A feed with no truth behind it would answer every caller with an empty
document and call that success, which is a silent failure the platform refuses to ship —
so the admin API rejects the combination outright rather than serving it.

Enablement itself is a manifest concern. A `.pkey/product` file turns both services on
alongside License and Config:

```json
{
  "modules": {
    "release": { "enabled": true },
    "update": { "enabled": true }
  }
}
```

Older manifests may still use the single pre-split `releases` module name; the parser maps
it onto both `release` and `update` together, so a product written before the two services
existed as separate slugs keeps working unchanged.

## Channels, in one paragraph

Every version-shaped path in Release and Update — a changelog entry, a download, an
appcast item — resolves against the same small vocabulary of **channels**. `stable` (or
`latest`, or a bare pinned `X.Y.Z` tag) is the floor every product and every license holds.
`beta` and `pr-<n>` resolve through an optional GitHub Actions workflow the product
configures, falling back to prerelease heuristics when it hasn't. Beyond the built-ins, a
product may declare **manual channels** — a name bound to an anchored regular expression
over release tags — for anything project-specific, like a `nightly` or `canary` line:
`release.manualChannels` in the [release manifest](/docs/build/manifest/authoring/) is the
writer, linkRepo/resync persist it, and resolution honours the names everywhere a channel
can appear. The same
resolution logic backs the download route, the appcast, and the version check, so the
three can never disagree about what "beta" currently means. [GitHub sync](/docs/services/release/github-sync/)
covers where a channel workflow is configured; Update's
[Eligibility](/docs/services/update/eligibility/) page covers the full selector grammar.

## How a product gets linked

An operator pastes a repository URL into the console. Polaris Key discovers the GitHub App
installation on that repo, mints a token scoped to it alone, reads the product's
`.pkey/` manifest, and — for a brand-new product — creates the product row, its signing
key, and its release configuration in one atomic write. From that point on, the repository
is the editor: release configuration changes by editing `.pkey/release` and either waiting
for a push or clicking **Resync from repo**, never by a form field in the console. See
[GitHub sync](/docs/services/release/github-sync/) for the full flow, including the
push-webhook pipeline that keeps a linked repo current without anyone visiting the console
at all.

## Platforms and binary naming

A product declares one **binary name** in its manifest (defaulting to the repository name)
and Release matches assets against it by convention: `<binaryName>-<arch>` for a bare CLI
binary, the same shape with a `.dmg` extension for a macOS disk image, and a `-<channel>`
infix for anything built off a non-stable channel. Release itself is not macOS-specific —
the download route and the truth store classify assets by platform (macOS, Linux, Windows)
from their file extension and name, and only the DMG path and the Sparkle appcast assume
Apple's update mechanism. A product that ships a Linux or Windows CLI still gets indexed
artifacts, a changelog, and an install script; it just never has anything for
[Update](/docs/services/update/) to render a feed over.

## Draft releases are invisible

A GitHub release marked as a draft is not published software, and Release treats it that
way everywhere: it is visible to the installation token (drafts are readable through the
same API), but it is never ingested into the truth store, never offered by channel
resolution, and never listed in the console or the customer portal. Publishing a draft on
GitHub is what makes Polaris Key aware it exists — there is no separate "publish" step on
this side.

## The three pages

- **[GitHub sync](/docs/services/release/github-sync/)** — linking a repository through the
  GitHub App, the `.pkey/` manifest, installation tokens, and the push-webhook pipeline
  that keeps everything current without a manual step.
- **[The truth store](/docs/services/release/truth-store/)** — the four tables a sync
  populates, why nothing in them is ever deleted, and the health checks built on top of
  them.
- **[Artifacts, changelog & install](/docs/services/release/artifacts/)** — the unified
  download route, architecture matching, the four access modes, and the curl-pipe
  installer.

## Access modes, briefly

Every Release surface is governed by one of four access modes — `public`, `authenticated`,
`licensed`, or `entitled` — set independently for the informational surfaces (changelog,
install script) and the artifacts themselves. `public` is the default, which is what keeps
anonymous `curl | sh` installs and anonymous update checks working for products that want
that. The full ladder, including the two different error shapes a client may see, is on the
[Artifacts](/docs/services/release/artifacts/) page; the license-aware `entitled` mode —
which additionally checks a caller's own channel and version entitlements — is covered
end to end on Update's [Eligibility](/docs/services/update/eligibility/) page, since that is
where the same check governs the feed.

## The console

An operator never edits release configuration field-by-field. The GitHub coordinates,
binary name, channel workflow, Sparkle key, and access modes all live in the linked repo's
`.pkey/release` file; the console's Releases view is a read surface over what the last sync
applied, plus a **Resync from repo** action and a live **Release health** check. What the
health check evaluates, and what "Manifest sync" shows beside it, are both covered on
[GitHub sync](/docs/services/release/github-sync/) and
[The truth store](/docs/services/release/truth-store/) rather than duplicated here.

## What Release is not

Release is not a build server and not a CDN. GitHub Releases remains the byte host for
every artifact a product ships; Polaris Key indexes what GitHub publishes, resolves
channels against it, gates who may read the result, and streams bytes back through its own
origin so a download can be access-controlled, checksum-verified, and Range/ETag-aware
without users ever needing GitHub credentials of their own. Nothing is uploaded here, and
nothing is rebuilt here — a product's own CI still produces the release GitHub hosts.

:::tip[Checking what a product actually runs]
`GET /<product>/.well-known/polaris.json` is the honest answer to "is Release on for this
product, and is it configured yet." A disabled service is present as `{"enabled": false}`
and nothing else; an enabled-but-unconfigured Release reports `"configured": false` with no
endpoints worth calling; a configured one lists its `changelog`, `install`, and `download`
endpoints alongside the linked repository's owner and name.
:::

## See also

- [Public route table](/docs/reference/routes/) for every Release path in one place.
- [D1 data model](/docs/reference/data-model/) for the full column list behind the truth
  store.
- [Update](/docs/services/update/) for the feed rendered over this truth.
