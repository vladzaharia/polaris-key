---
title: "Eligibility"
description: "Channel resolution, the version check, and the entitled access mode's per-license channel and version gating."
---

Two different questions sit behind the word "eligibility." **Access** — covered in full on
Release's [Artifacts](/docs/services/release/artifacts/) page — asks whether a caller may
read a surface at all. **Eligibility**, this page, asks the narrower question the feed
itself is actually built around: given that a caller may read it, which channel and which
build is _this specific request_ asking for, and is _this specific caller_ allowed that
one. Under the three loosest access modes the second question barely matters — every
caller sees the same feed. Under `entitled`, the two questions become the same question,
because the channel this page's resolution logic produces is exactly the channel checked
against the caller's own license.

## The version check

```
GET /<product>/update/version
```

Returns the newest build on a channel:

```json
{ "version": "1.2.3", "tag": "v1.2.3", "url": "https://github.com/…" }
```

It takes one query parameter: `?channel=`, defaulting to `stable`. The value is one of `stable`,
`beta`, `pr-<n>` or a manifest-declared manual channel, held to the `[a-z0-9-]` alphabet. That
alphabet has no dot, so a pinned `X.Y.Z` is **not** a valid `?channel=` value; to fetch a
specific version, pin it in the download route's path segment instead. Anything outside the
alphabet answers `404` before resolution, and a well-formed unknown name `404`s exactly like an
unknown channel appcast. Under `entitled`, the gate evaluates the query
channel precisely as it would the path spelling, so `?channel=beta` from a stable-only
license answers `403 channel_not_allowed`. Without `?platform=`, `?arch=` is accepted and discarded — the
answer names a release, not an asset (with `?platform=`, a product that publishes release
records gets the [extended answer](/docs/services/update/updater-feeds/#the-extended-version-check)). The response carries `max-age=120`, the cache policy every
moving selector gets. Unlike the
appcast, the version check is a **metadata** surface — a plain informational read, not a
pointer to bytes — so it's governed separately; see
[Appcast](/docs/services/update/appcast/) for why the feed itself is gated under the
stricter column.

## Channel resolution

The download route, the appcast, and the version check all resolve a channel or version
selector through one shared vocabulary, so the three can never disagree about what "beta"
currently means:

| Selector                                             | Resolves to                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stable`, `latest`, or omitted                       | the highest-version non-prerelease **candidate** (see below)                                                                                                                         |
| a bare `X.Y.Z` (optionally with a prerelease suffix) | that exact tag, pinned                                                                                                                                                               |
| `beta`                                               | the latest tag from a configured GitHub Actions channel workflow's run on the product's beta branch, falling back to the highest prerelease candidate when no workflow is configured |
| `staging`                                            | the legacy alias of `beta`, resolved exactly as `beta` — unless the product declares a manual channel named `staging`, which wins                                                    |
| `pr-<n>`                                             | the same workflow-based resolution, scoped to that pull request's head commit — with no workflow configured, this resolves to nothing                                                |
| a manifest-declared manual channel                   | the highest release whose tag matches the channel's anchored regular expression                                                                                                      |

Anything that matches none of these is passed through **unrecognized** rather than quietly
treated as `stable` — an unresolvable selector answers `404` visibly instead of silently
serving the wrong build under a name nobody asked for.

Manual channels are declared in `.pkey/release` as `release.manualChannels` — an array of
`{ name, regex }` entries persisted by linkRepo/resync — and resolved everywhere in that
table. The regex is compiled anchored (`^(?:…)$`), capped at 80 characters, and refused at
manifest validation if it does not compile; the runtime reader applies the same rule, so an
ingested channel is always a resolvable one. The built-in names are matched first, so a
manual channel could never be called `stable`, `beta`, `latest` or `pr-<n>`; the validator warns
(`reserved_channel_name`) on such a name, and on `dev` or `pr`, whose grant would mean the gate's
pseudo-channel or the PR family. `staging` is the exception: the alias is looked up after the
manual names, so a declared manual `staging` keeps working. An aliased request keeps its own
spelling for the asset suffix, the enclosure, the feed title and the edge-cache key; resolution,
floors and the entitlement check go by `beta`. The full vocabulary is WIRE-CONTRACT-V3 §5.1.

### Which tags are candidates, and which one wins

Not every GitHub release is an app release. A repository may also publish a rolling
`channels` release, a content `packs` release, or anything else its tooling needs, and none of
those may ever become `latest`. So `stable`/`latest` and the `beta` prerelease fallback only
consider **candidates**: non-draft releases whose tag matches `release.stableTagPattern` and is
not listed in `release.ignoreTags`, and whose version (the tag minus a leading `v`) parses as
semver.

- **`stableTagPattern`** is an anchored regular expression under the same rule as a manual
  channel's (compiled `^(?:…)$`, at most 80 characters, refused at validation if it does not
  compile). Undeclared, it is a semver tag with an optional leading `v`, such as `v1.2.3`,
  `1.2.3-rc.1` or `v2.0.0+build.5`.
- **`ignoreTags`** is a list of exact tag names that no moving channel ever resolves to. Manual
  channels keep their own regex, but they skip these tags too. A pinned `X.Y.Z` still
  reaches an ignored tag, because a pin names its tag exactly.

Among the candidates, the winner is the **highest semver precedence**, not the most recently
created release: `v1.10.0` beats `v1.4.0` even when `v1.4.0` was cut later as a backport. When
two tags strip to the same version (`v1.2.0` and `1.2.0`), the later `published_at` wins. A
manual channel over tags that are not semver, such as dated nightlies, is ordered by
`published_at` alone.

A request reads the GitHub release list one page of 100 at a time. It stops at the first page
that holds a candidate for the selector, and it never reads more than three pages. The winner
is the highest candidate among the pages it read. A repository whose newest page holds an app
release, which is nearly all of them, still costs one list call. A pinned `X.Y.Z` is looked up
as `tags/v<X.Y.Z>` first and, only when that 404s, as `tags/<X.Y.Z>`, so a repository that tags
without a `v` can be pinned and its stable appcast's pinned enclosure resolves.

### Channel floors: no silent downgrade

Each truth-store [sync](/docs/services/release/github-sync/) records the highest version every
moving channel has resolved to (`release_channel_floors`). The channels floored are `stable`,
`beta` when no channel workflow is configured, and manual channels. Pinned versions and
`pr-<n>` are never floored. When a request's pick lands **below** that floor, the route looks
the floor's release up by tag, which costs one extra GitHub call:

- If the release still exists (it sat on a page the request did not read), it is served.
- If it is gone (deleted or unpublished), the channel answers `404` rather than quietly
  promoting an older build to `latest` behind a public cache header.

The console's [release health](/docs/services/release/truth-store/#health-checks) then reports
`channel-regressed`, naming the floor and what the list now offers. The only way past a floor
is an operator's decision. `POST /manage/api/products/<slug>/release/channels/<channel>/floor`
with `{ "version": "1.0.0" }` lowers it, and `{ "clear": true }` removes it. Both are audited
as `release.channel.floor`. A floor can only be lowered this way. Only a sync raises one. A
floor whose channel is no longer floored (a manual channel since removed, or `beta` once a
channel workflow is configured) can still be cleared, but not lowered.

## Access versus eligibility, restated

A request can fail for either reason, and they produce different refusals. A caller who may
not read the surface at all under the configured access mode never reaches channel or
version evaluation — that's Release's [Artifacts](/docs/services/release/artifacts/) page.
A caller who _may_ read it, under `entitled`, can still be refused the _specific_ channel
or version being asked for — that's what the rest of this page covers.

## The entitled access mode

### What it closes

Before `entitled` existed, "may this caller download" only ever asked whether _some_ usable
license existed — never whether _that specific license_ actually covered the channel or
version being requested. A customer holding a stable-only license could fetch the beta
appcast, and the beta DMG behind it, simply by knowing the URL; the license being real and
usable was the whole check. `entitled` asks the narrower, correct question: does _this_
license's own grant cover _this_ channel, at _this_ version.

### Opt-in, per product and per surface

`entitled` is one of the four modes in Release's [access ladder](/docs/services/release/artifacts/#access-modes),
set independently for metadata and artifacts. `public` stays the default specifically so
anonymous update-checking keeps working for the products that want it — nothing about
`entitled` existing forces every product toward it.

### The check itself

Release and Update cannot import the License service directly — services may only reach
into their own directory, Core, and the one sanctioned `update → release` edge — so the
entitled decision is asked of Core through a single shared module, `core/entitledAccess`.
It performs exactly the composition the signed license document's own build gate performs:
validate the device's bearer token, confirm the license behind it is usable, merge tier,
license, and admin policy into the same entitlement map the license document itself would
carry, then read the `channels` entitlement and the version window out of _that_ merged
result. A caller refused a beta license document is refused the beta feed for the same
reason, off the same rows — there is exactly one entitlement computation in the platform,
not two that could quietly drift apart.

What gets evaluated, and in this order:

1. **Authentication.** A caller with no usable device token or license learns nothing about
   the product's channels — just a `401`.
2. **Channel.** Is the requested channel in the license's entitled set. `stable` is always
   in it; it's the floor every license holds regardless of what it was ever granted
   explicitly. A license entitled to the coarser `pr` channel also covers any specific
   `pr-<n>` selector, and a legacy `staging` grant covers `beta` (and so the `staging` alias).
   A manual channel is covered only by its own name: a `beta` grant does not cover a manual
   channel named `staging`. This is the same predicate the license build gate uses.
3. **Version** — evaluated only once the channel passes. Is the concrete version being
   fetched inside the intersection of the product's global compatibility window and the
   license's own minimum/maximum version entitlements (the tighter bound wins in both
   directions).

The order is deliberate, not incidental: a channel refusal never includes the version
window it would otherwise carry, because handing an unentitled caller the exact shape of
what they can't see would leak information about a thing they aren't supposed to know
exists at all.

### The three outcomes

```json
// 401 — no usable device or license
{ "error": { "code": "unauthorized" } }
```

```json
// 403 — the license doesn't cover this channel
{ "error": { "code": "channel_not_allowed" } }
```

```json
// 403 — the requested version sits outside the license's window
{ "error": { "code": "version_blocked" }, "allowedRange": { "min": "2.0.0" } }
```

This is the same nested wire shape the signed license document's own build gate answers
with — see Release's [Artifacts](/docs/services/release/artifacts/#two-error-grammars) page
for how it compares to the flat body `authenticated`/`licensed` still use.

## Client-side narrowing is not enforcement

A well-built client may read the same `channels` entitlement off its own license and use it
to decide which channels to _offer_ a user — the Swift SDK does exactly this for Sparkle's
channel filter, covered on [Swift client & Sparkle](/docs/services/update/sparkle/). That's
a courtesy, not the enforcement point. If the two ever disagree — a stale cached
entitlement, a client bug, a hand-edited config — the request that actually reaches the
server is what wins, and the caller sees a `403` instead of a silent download. Nothing
client-side is ever trusted to gate what a caller can install; only what a caller is
_offered_ in the first place.

## The console: Feed

**Update → Feed** edits `GET|PATCH /manage/api/products/<product>/update/settings` in three
sections, each saved on its own with only its own fields:

- **Metadata access** — governs the version check (and, on Release's side, the changelog
  and install script).
- **Compatibility window** (lowest and highest supported) — the product-wide version window
  every license's own `entitled` window is intersected against, regardless of what any
  individual license grants. Both are checked as versions, and the highest must not be below the
  lowest, before anything is sent.
- **Artifact policy**:
  - **Minimum macOS version** (`minimumSystemVersion`, `^\d+(\.\d+){0,2}$` or empty to clear) —
    rendered as `sparkle:minimumSystemVersion` on every appcast item.
  - **Require Sparkle signatures** (`requireSparkleSignature`, boolean, default `true`) — see
    [Appcast](/docs/services/update/appcast/#the-signature-gate).

A fourth section, **Endpoints**, lists the public URLs updaters read (discovery, the version
check, the appcasts, WinSparkle and the signed feed per channel), each with a copy button.

**Artifact access** — who may read the appcast, the downloads and the customer portal's download
mint — is Distribution's [delivery access](/docs/services/distribution/delivery/#delivery-access).
The Feed page shows it read-only and links to **Distribution → Access**, where it is set, saved to
`PUT /manage/api/products/<product>/distribution/access` with its own owner and revert;
`update/settings` refuses `artifactsAccess` by name.

A product with no release configuration yet has nowhere to store an access mode or an
artifact policy, so the page shows those fields read-only and says why, and the API answers
`422` rather than accepting a value the next read wouldn't return — the compatibility window,
living on the product row itself, stays editable regardless. Saving is a partial patch: an
unset field keeps its current value, so changing the compat window never re-submits an access
mode.

### Who owns each field

The access modes and the compatibility window are also written by `.pkey/`: a resync
re-applies `release.access` and `product.compatMin`/`compatMax`. Saving one here **claims**
it — `accessSource` / `compatSource` in the response flips from `manifest` to `admin` — and a
resync then skips a claimed block. That matters most for `entitled`, which no manifest can
express: without the claim, the next push would quietly downgrade the product to the
manifest's mode (default `public`). Since P2b-04 the two access modes have separate owners:
`accessSource` covers the metadata mode, and the delivery access carries its own `source` on
Distribution's endpoint, with its own revert (`POST …/distribution/access/revert`).

```
POST /manage/api/products/<product>/update/settings/revert
{ "fields": ["access" | "compat", …] }
```

hands the named blocks back to the manifest and changes **nothing else**: the live values stay
as the operator left them until the next resync re-applies `.pkey/`. The response is the same
settings object as `GET`; the event is audited as `update.settings.revert`.

The two artifact-policy fields carry no owner because they have no second writer — no manifest
shape spells them, and they live in a column resync never names. A push can neither set nor
erase them. Changing either is audited as its own `release.policy.update` event (turning the
signature requirement off is named explicitly), and the console asks for confirmation, marked as a
strong action, before switching signatures off. On the Feed page, **Revert to manifest** sits in
the source badge of a block the console owns (`Set in console`); a block the manifest owns has
nothing to revert.

## See also

- [Appcast](/docs/services/update/appcast/) — where this resolution and this check
  actually gate a response.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the full access
  ladder and both error grammars.
- [Swift client & Sparkle](/docs/services/update/sparkle/) — the client that consumes an
  entitled feed.
- [Wire error codes](/docs/reference/error-codes/) for the complete nested error taxonomy.
