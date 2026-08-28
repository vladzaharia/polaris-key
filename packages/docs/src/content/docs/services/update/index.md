---
title: "Update"
description: "The appcast feed, version checks, eligibility, and the entitled access mode."
sidebar:
  order: 1
---

Update renders a live feed *over* [Release](/docs/services/release/)'s truth. It owns no
tables of its own — every row it reads belongs to Release — and it answers exactly two
questions: what is the newest build on a given channel, and which build is *this specific
caller* allowed to be offered. The Sparkle appcast, the plain version check, and the
per-license `entitled` access mode are all different framings of those same two questions.

## Truth and feed, split on purpose

Before the split, one module did both jobs: it knew where a product's software lived and
it rendered the auto-update feed over it, and the two concerns drifted into each other
whenever one changed without the other. Splitting them means a product can enable Release
alone — indexed artifacts, a changelog, a curl-pipe installer — for a CLI tool that will
never auto-update, and it means the feed-rendering half can be reasoned about, tested, and
changed without touching the GitHub-sync machinery underneath it. Sparkle is one
consumer of that split, not the reason for it: any auto-update mechanism could sit where
Update sits today.

## The one sanctioned exception

Polaris Key's services may not import each other — a boundary lint enforces it, and every
service beyond the always-on Core substrate is meant to stand alone. `update → release` is
the single exception in the whole platform. It exists because a feed with no truth behind
it is not a smaller feed, it is a lie: an appcast that can't ask Release what actually
exists would have to either fabricate an answer or omit checks entirely, and both are worse
than the coupling. Nothing points back the other way — Release has never heard of Update.

## Off by default, and it needs Release

Update is opt-in per product, like every service beyond Core. It also carries a coherence
rule the platform enforces at the same layer as enablement itself: a product **cannot**
enable Update while Release stays off — a feed with no truth behind it would answer every
caller with an empty document and call that success, and the admin API refuses to ship
that silent failure. Turning Update on is a manifest concern, alongside every other
service:

```json
{
  "modules": {
    "release": { "enabled": true },
    "update": { "enabled": true }
  }
}
```

Both together, always — the parser also accepts the single pre-split `releases` module
name and expands it into both slugs, so a manifest written before the two services existed
separately keeps working unchanged. See
[Release](/docs/services/release/#off-by-default-and-config-only-until-linked) for the
`enabled`/`configured` distinction discovery reports for each service independently.

## The three pages

- **[Appcast](/docs/services/update/appcast/)** — the Sparkle feed itself, per-architecture
  enclosures, and the four pre-namespace URLs kept working forever.
- **[Eligibility](/docs/services/update/eligibility/)** — the version check, channel
  resolution, and the `entitled` access mode end to end.
- **[Swift client & Sparkle](/docs/services/update/sparkle/)** — the macOS client target,
  the Sparkle version floor, and the trust anchor Polaris Key deliberately never
  reimplements.

## For readers new to Sparkle

[Sparkle](https://sparkle-project.org/) is the de facto standard auto-update framework for
macOS apps: a host application polls an **appcast** — an RSS-shaped XML feed — for the
newest available version, and downloads and verifies a signed update when one exists.
Update's job is entirely on the server side of that exchange: generate a correct appcast on
the fly from whatever Release currently knows about a product's GitHub releases, so a
product gets a working feed the moment it links a repository, with no separate publishing
step and no baked-at-build-time XML file to keep in sync by hand. Sparkle's own signature
verification — the part that actually decides whether an update is safe to install — is
untouched by any of this; Update's server-side EdDSA check (covered on
[Appcast](/docs/services/update/appcast/)) is a *publishing* gate, not a substitute for it.

Sparkle itself has no opinion about channels — a host either points at one `SUFeedURL` or
it doesn't. Update's channel model (`stable`, `beta`, `pr-<n>`, and any operator-defined
manual channel) lives entirely on the server side: each channel is simply its own appcast
URL, resolved against the identical selector vocabulary the download route and the version
check use, so pointing a beta build at `/<product>/update/beta/appcast.xml` is all a host
needs to do to follow a different release line.

## What a client actually gets

`/<product>/.well-known/polaris.json` publishes Update's own discovery fragment when the
service is enabled: the channels a product declares, the configured Sparkle public key (or
`null` when none is set), and the canonical endpoint URLs for the version check and both
appcast shapes. A well-built client — the Swift SDK included — reads its feed URL from
here rather than constructing one by hand, which is exactly what keeps it working across a
route change; see [Swift client & Sparkle](/docs/services/update/sparkle/) for how that
plays out end to end.

## Live, not cached in a database

Every Update surface resolves against GitHub live, on every request that isn't already
sitting in the edge cache — there is no local table Update reads from, not even the
release truth store its sibling service maintains for the portal and the console. The two
are kept in step because both ultimately reflect the same GitHub state, not because one
queries the other. See
[The truth store](/docs/services/release/truth-store/) for what that store is actually
for.

## Access, briefly

Update's two surfaces are governed independently, and not the way the labels might
suggest: the version check is a **metadata** surface, but the appcast — both the default
feed and any channel-specific one — is governed by **artifacts access**, the same ladder
that gates a raw download. That is deliberate: an appcast item embeds a download URL, so
gating it under the informational column would let a caller read past the artifact
restriction it points at. The full ladder and the two error shapes are covered on
[Eligibility](/docs/services/update/eligibility/) and on Release's
[Artifacts](/docs/services/release/artifacts/) page, which owns the shared explanation of
the four modes.

## The console

Feed access and the compatibility window live together under **Update settings** in the
console — four fields (metadata access, artifact access, and the min/max supported client
version) that are read in the same breath because every one of them is intersected on the
same eligibility decision. The compatibility window used to sit in the general product
settings form, beside the display name; it moved here because it means nothing on its own
— it is only ever read together with the access modes it is intersected against. There is
no per-field API for the rest of Update's behavior: the appcast's content, the channels it
resolves, and its Sparkle key all come from Release's own `.pkey/release` configuration.
[Eligibility](/docs/services/update/eligibility/) covers the settings form in full.

## Informing versus enforcing

The version check only ever *informs* — it reports the newest build on a channel and lets
a caller decide what to do about it, the same way the appcast only ever *offers*. Neither
one blocks an out-of-date client from continuing to run. The actual build gate — the
`403` a client gets for running a version a license no longer permits — lives on the
signed license document, a different service entirely. A product can run Update with no
enforcement at all (a public feed, informing everyone equally) and separately enforce a
version floor through licensing, or fold both together under `entitled` so the same
license grant governs which builds are even offered. See
[Eligibility](/docs/services/update/eligibility/) for where that line actually sits.

## See also

- [Public route table](/docs/reference/routes/) for every Update path in one place.
- [Wire error codes](/docs/reference/error-codes/) for the nested `entitled` error shape.
- [Release](/docs/services/release/) for the truth this service renders a feed over.
- [D1 data model](/docs/reference/data-model/) for the Release-owned tables that describe
  the same GitHub state this service resolves live, on every request.
