---
title: "Appcast"
description: "The appcast feed, per-architecture enclosures, and the four permanent pre-namespace aliases."
---

The appcast is what a Sparkle-based updater actually polls. Polaris Key generates it on the
fly from the current GitHub release and asset state — never baked at build time — so any
product with Release configured gets a correct, current feed with no separate publishing
step. This page covers the two feed routes, how architecture selection works, what a feed
item actually contains, the server-side signature check that gates what's allowed into it,
and the four URLs that predate this whole namespace and are kept working forever.

:::note[Products that publish release records]
This page describes the appcast rendered from GitHub release state, which every product without
CI-signed release records keeps. A product that publishes release records gets the **extended**
appcast instead: build numbers, `criticalUpdate`, phased rollouts, deltas,
`hardwareRequirements` and universal DMGs, rendered from the records. See
[App-updater feeds](/docs/services/update/updater-feeds/#sparkle-extended).
:::

## The two routes

```
GET /<product>/update/appcast.xml
GET /<product>/update/<channel>/appcast.xml
```

The first always serves the `stable` channel. The second serves any other channel name —
`beta`, `pr-<n>`, or an operator-defined manual channel — resolved through the identical
selector logic [Eligibility](/docs/services/update/eligibility/) documents in full. Both
answer with a single `<item>`: the newest release on that channel, at the moment of the
request.

Both routes are governed by **artifacts access**, not metadata access — worth calling out
because it's easy to guess the opposite. An appcast item embeds a download URL, so gating
it under the same column as the changelog would let a caller read a pointer to bytes the
artifact restriction is supposed to withhold. See Release's
[Artifacts](/docs/services/release/artifacts/) page for the full four-mode ladder and the
two error shapes a refusal can take.

## Architecture selection

```
GET /<product>/update/appcast.xml?arch=arm64
GET /<product>/update/appcast.xml?arch=x86_64
```

A channel isn't one build — it's (up to) two, one per architecture, and `?arch=` picks
which DMG the item's enclosure points at. Leaving it off, or sending a value this build
doesn't recognize, serves `arm64`. That default exists because every appcast URL compiled
into an app bundle before per-architecture support existed has always meant the arm64
build, and quietly repointing the _unparameterized_ feed at a different architecture would
be a silent downgrade for every install that never sends the parameter — an Intel Mac that
omits it would start checking the wrong feed. `arch` is part of the edge-cache key
alongside the channel and version, so the two architectures' responses can never collide in
cache.

:::note[This SDK always sends it explicitly]
The Swift client covered on [Swift client & Sparkle](/docs/services/update/sparkle/) never
relies on the default — it detects the running machine's architecture and always passes
`arch` on the URL it builds. Relying on the unparameterized feed's default is a choice for
a host that has no arm64/x86_64 distinction to make; anything else should send it.
:::

## What an item contains

Each rendered `<item>` carries:

- **`title`** and **`pubDate`** — the product's binary name followed by the version
  (`myapp 1.2.3`; the GitHub release's own title is not used), and its GitHub publish
  timestamp, RFC-1123 formatted. A release GitHub never stamped falls back to the Unix epoch
  rather than omitting the element.
- **`sparkle:version`** and **`sparkle:shortVersionString`** — both taken from the release
  tag. Polaris Key doesn't distinguish a marketing version from a separate build number;
  the tag is the version, in both fields.
- **`sparkle:minimumSystemVersion`** — present only when an operator set a minimum macOS
  version in [Update → Feed](/docs/services/update/eligibility/#the-console-feed)
  (no manifest can declare it), and only after its value passes a shape check (Sparkle compares it, never
  displays it, so a value it can't parse would silently make every update ineligible).
- **`<description>`** — the same curated changelog summary the changelog endpoint extracts
  (see Release's [Artifacts](/docs/services/release/artifacts/) page), HTML-escaped and
  wrapped in CDATA.
- **`<enclosure>`** — the download URL, the byte length, and — only when the release
  published a verifiable signature — `sparkle:edSignature`.

## Enclosure URLs

A pinned resolution (`stable`, `latest`, or an exact `X.Y.Z`) points its enclosure at the
concrete version segment, so the URL is immutable once minted:

```
https://key.plrs.im/<product>/release/dl/1.2.3/<binary>-arm64.dmg
```

The download route resolves that segment as a pinned version, `tags/v1.2.3` first. So when the
feed's release has a bare tag (`1.2.3`) and a `v1.2.3` release also exists, the DMG a client
would download is not the one the item's signature covers. The feed refuses that ambiguity and
answers `404`. To resolve it, add the bare tag (`1.2.3`) to `release.ignoreTags`, or delete one
of the two releases. Ignoring the `v`-tag does not help: the download route's pinned lookup does
not consult `ignoreTags`, so the feed would pick the bare tag while the enclosure still resolves
`v1.2.3`.

A moving channel (`beta`, `pr-<n>`, a manual channel) points at the channel segment itself
instead, so the enclosure URL is stable across releases on that channel even though what it
resolves to changes underneath it:

```
https://key.plrs.im/<product>/release/dl/beta/<binary>-arm64.dmg
```

Either way, the enclosure is an ordinary [download route](/docs/services/release/artifacts/)
URL back through this same gateway — Sparkle's download and a browser's download are the
same request.

## The signature gate

Before a release is allowed into the feed at all, the worker fetches the sibling `.sig`
asset the release pipeline uploaded next to the DMG and **actually verifies** the EdDSA
signature over the DMG's own bytes against the product's configured public key — not
merely checks that a sidecar file happens to exist. A release whose signature fails to
verify, or whose product requires one it doesn't have, is dropped from the feed entirely:
the whole `/appcast.xml` response answers `404` rather than shipping an item Sparkle would
refuse to install anyway. The DMG is streamed through the check rather than held in
memory, so any DMG up to GitHub's 2 GiB asset limit can be verified. A verified verdict is
cached for 30 days and a failed one for a day, keyed to the exact asset, signature, and
public key involved, so once a check has completed, later requests reuse its verdict instead
of downloading the DMG again. Until a verdict is cached — including when requests arrive
while the first check is still streaming, or when a request is aborted before its check
finishes — each request still performs its own full check. Any change to those inputs is a new key — GitHub gives a
re-uploaded asset a new id — so a swapped asset or a rotated key can never reuse a stale
verdict.

:::caution[This is a publishing gate, not the trust boundary]
This check happens once, server-side, before an item is ever offered. It is what keeps a
misconfigured or tampered sidecar from reaching users at all — but Sparkle's own signature
check, against the key baked into the _client_ app bundle, is what actually decides whether
an individual install trusts an individual update. Polaris Key never touches that boundary;
see [Swift client & Sparkle](/docs/services/update/sparkle/) for why.
:::

Whether a product requires a signature at all is an operator-only setting — a `.pkey/`
manifest push can declare a Sparkle public key, but it can never turn the _requirement_ off, and
it can never turn an operator's deliberate "off" back on either: the setting lives in its own
column that no resync writes. The console's Update → Feed page asks for confirmation before
switching it off, and the change is audited as `release.policy.update`.
A product with no key configured and no requirement set ships an unsigned appcast item on
purpose; that combination has to be chosen deliberately by whoever configures the release,
not by whatever the repository happens to contain.

## Release-note safety

The curated summary embedded in `<description>` is HTML-escaped, and any literal `]]>`
sequence inside it is also neutralized before it's wrapped in `CDATA`. Without that second
step, a release note that happened to contain that exact three-character sequence would
close the CDATA section early, and everything written after it in the note would be parsed
as sibling XML — including, in principle, a second, attacker-chosen `<enclosure>` element
pointing an updater somewhere else entirely. The visible text a Sparkle user sees is
unchanged either way; only what a parser does with the surrounding bytes is.

## Caching

Appcast responses carry `max-age=300` — five minutes — and so does the changelog. The
version check is the exception: it follows its own resolution instead, which in practice
means `max-age=120` (see [Eligibility](/docs/services/update/eligibility/)). All three are
eligible for Cloudflare's edge cache, but only when the effective access mode for that
request is `public` — a cache entry is only ever written for a request that already cleared its own
access check, so a hit can never bypass one. The cache key is built from the product,
surface, version or channel, and architecture — never the raw query string — so an
attacker probing with distinct, meaningless query values can't mint unbounded cache entries
that all miss.

## The permanent aliases

Four URLs predate the current `/<product>/<service>/…` namespace, and they are kept
**forever** (the byte routes' `/release/…` spellings are permanent aliases too, of
Distribution's routes — see [Byte delivery](/docs/services/distribution/delivery/#permanent-aliases)):

| Alias                              | Canonical                                 |
| ---------------------------------- | ----------------------------------------- |
| `/<product>/appcast.xml`           | `/<product>/update/appcast.xml`           |
| `/<product>/<channel>/appcast.xml` | `/<product>/update/<channel>/appcast.xml` |
| `/<product>/install.sh`            | `/<product>/distribution/install.sh`      |
| `/<product>/version`               | `/<product>/update/version`               |

The router recognizes these exact path shapes and rewrites them to precisely the same
route — same service, same segments — that their canonical spelling produces, before
anything downstream ever sees a difference. There is exactly one code path per surface,
not two implementations kept in sync by hand, which is what makes the two spellings
_provably_ identical rather than identical by coincidence.

### Why forever

By the time the current namespaced layout shipped, these four spellings were already
compiled into artifacts nobody can revise after the fact: `SUFeedURL` values baked into
already-distributed, code-signed app bundles, and `curl … | sh` one-liners published in
READMEs and release notes that realistically never get updated once copied around. An
alias is the only way an already-shipped binary — or a two-year-old blog post — keeps
working without asking every downstream owner to do something. Discovery only ever
advertises the canonical URLs; the alias exists so _old_ configuration keeps resolving, not
so anything new is told to use it.

`/<product>/changelog` — the pre-service-split spelling for what is now
`/<product>/release/changelog` — was deliberately **not** kept as a fifth alias, for the
mirror-image reason: nothing ever shipped that URL inside a distributed binary or a
published one-liner, so there was nothing external depending on it to preserve. It was
simply moved, and the old path answers `404` like any other removed route.

## See also

- [Eligibility](/docs/services/update/eligibility/) — channel resolution, the version
  check, and the `entitled` access mode this feed is gated by.
- [Swift client & Sparkle](/docs/services/update/sparkle/) — how a macOS client actually
  points itself at one of these URLs, and what it does and doesn't verify.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the download route
  behind every enclosure.
- [Public route table](/docs/reference/routes/) for every alias and canonical path in one
  place.
