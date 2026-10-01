---
sidebar:
  order: 4
title: "Artifacts, changelog & install"
description: "The unified download route, the build, file and blob routes, the bytes host, architecture matching, the four access modes, and the curl-pipe installer."
---

Three things make up what a human or an install script actually touches: downloading a
binary (as a bare CLI executable or a macOS disk image — two content types behind one
route), reading the changelog, and running the installer. The first two resolve against
GitHub — a download's selector resolution is cached for 90 seconds, the changelog is the only
one of the three the edge cache will hold, and a download is streamed through every time —
while the installer is rendered from
stored configuration and touches GitHub not at all. What none of them read is the
[truth store](/docs/services/release/truth-store/), which exists for the portal and the
console, not for these routes. The newer [build, file and blob routes](#builds-files-and-blobs)
are the opposite: they resolve from the truth store and touch GitHub only for the bytes.

## The download route

One route replaced the old `/<product>/cli/…` and `/<product>/dmg/…` pair:

```
GET /<product>/release/dl/<version>/<binary>-<arch>[.dmg]
```

They were always the same handler wearing two content types and two asset matchers; the
file extension now carries the whole distinction, and the old paths are removed outright
rather than aliased — nothing ever shipped a `.dmg` URL as a standalone published
reference the way it did for the appcast and install-script URLs (see
[Appcast](/docs/services/update/appcast/) for the paths that _were_ kept forever, and why
this one wasn't).

- **`<version>`** is a channel selector: `latest`, `stable`, a pinned `X.Y.Z` tag, `beta` (or
  its legacy alias `staging`, which matches `-staging-` assets), `pr-<n>`, or an operator's
  manual channel name — the identical vocabulary
  [Eligibility](/docs/services/update/eligibility/) documents in full, since the download
  route, the appcast, and the version check all resolve it through the same logic.
- **`<binary>-<arch>`** matches an asset by convention. On the bare-binary path an exact
  filename hit (`<binaryName>-<arch>`, or `<binaryName>-<channel>-<arch>` for a non-stable
  channel) short-circuits everything else. Failing that — and always, for a DMG — matching
  scores candidates by file extension, architecture token, binary name, and channel suffix. A
  request that names no channel prefers assets carrying no `beta`, `staging` or `pr` token.
  Real projects aren't always perfectly consistent about naming, so this is deliberately
  fuzzy; when it leaves two equally good candidates the route answers `404` rather than
  guessing.
- **`[.dmg]`** — presence of the extension selects the macOS disk image path; its absence
  selects the bare CLI binary. Same handler and the same scoring function, two different
  `Content-Type` values on the way out; only the CLI path carries the exact-name
  short-circuit above.

The channel policy applies here exactly as on the appcast and the version check: a
[yanked](/docs/services/release/channels/#yanks) release is never served on a moving selector,
and a [pinned](/docs/services/release/channels/#pointers-and-pins) channel serves its pointer.

### Architecture

Four spellings are accepted on the wire and normalized to two canonical values:

| Accepted           | Canonical |
| ------------------ | --------- |
| `arm64`, `aarch64` | `arm64`   |
| `x86_64`, `amd64`  | `x86_64`  |

An unrecognized architecture token answers `404`, not a server error — every arch value
passes through one normalizing function before it reaches anything that keys a lookup
table by it, specifically so a spelling this build doesn't know about fails safely instead
of crashing a public, unauthenticated route.

### Streaming, not proxying blindly

The gateway follows GitHub's storage redirect itself (checking the redirect target's host
before it does) rather than handing a 302 straight to the client, so it can pass `Range`
and `If-None-Match` through end-to-end — resumable downloads and conditional requests both
work all the way to GitHub's storage backend. The response is always forced to a
gateway-chosen `Content-Type` (`application/x-apple-diskimage` for a DMG, plain
`application/octet-stream` otherwise) and a forced `Content-Disposition: attachment`, never
whatever the uploader originally declared — this origin also serves the admin console and
the customer portal, so an artifact is never allowed to be sniffed as something
same-origin scripts could execute.

### Checksums

`?checksum=sha256` on the same URL serves the published `<asset>.sha256` sidecar as a bare
lowercase hex digest — not the raw `shasum`-style `<digest>  <filename>` line, just the
digest. This is exactly what the [install script](#the-install-script) verifies against
before it will make anything executable.

## Builds, files and blobs

Three more byte routes serve what the [release model](/docs/services/release/truth-store/)
records rather than what GitHub's asset names suggest. Each answers `GET` and `HEAD`, on the
console host and on the **bytes host** (`dl.plrs.im`, see below):

```
GET /<product>/release/builds/<selector>/<buildId>   [?deliverable=<id>] [?checksum=sha256] [?redirect=1]
GET /<product>/release/files/<releaseId>/<name>      [?redirect=1]
GET /<product>/release/blobs/sha256/<hash>
```

- **builds** resolves `<selector>` for a deliverable (default `app`) and serves the payload of
  the build `<buildId>` — an id from the deliverable's artifact map, such as `macos` or `apk`.
  Resolution is per platform: a release that lacks this build is skipped, so a release with no
  iOS build does not blank iOS; iOS gets the newest release that has one. The rules — channel
  membership, `includes`, pointers and pins, yanks, the version scheme and the tag filter — are
  on [Channels and policy](/docs/services/release/channels/). `?checksum=sha256` answers the
  payload's SHA-256 as bare hex, like the download route.
- **files** serves one exact file of one release by name, sidecars included (`.sig`,
  `.sha256`, an index). The release id and the name fix the bytes, so the response is
  immutable.
- **blobs** serves a content-addressed object only when an artifact of **this** product
  references it. Another product holding the same bytes does not count, and the answer is the
  same not-found as for an unknown hash, so the route reveals nothing about other tenants.

An artifact's bytes are taken from the first location that has them, in this order:

1. **R2**, through the blob store: `ETag` is the SHA-256, `Repr-Digest` covers the whole
   object, and `Range`, `If-Range` and `If-None-Match` are evaluated against it.
2. **GitHub**, streamed through the worker as on the download route. The signed storage URL
   GitHub hands out is cached for less than its lifetime, sealed in KV, so a resumed or
   chunked download costs one GitHub API call in total rather than one per chunk.
3. An **external** `https://` URL, as a 302.

Streaming is the default because winget refuses redirects and App Installer and zsync need
`Range`. `?redirect=1` asks for a 302 to GitHub's own download URL instead; it is honoured
only for a public artifact of a public repository, and everything else keeps streaming.

All three routes count against the artifact rate-limit lane and follow the product's
`artifacts` access mode (below). A moving selector is cached for two minutes, a version
selector, a file and a blob for a year (immutable); a non-public product's bytes are
`private, no-store`. Every byte response carries `no-transform`, so the edge never recompresses
bytes whose length, ranges and digest are fixed.

### The bytes host

The byte routes are also served on a second hostname, the bytes host (`BLOB_ORIGIN`,
`https://dl.plrs.im` in production), and discovery advertises them there as
`endpoints.builds` and `endpoints.blobs`. Only these routes exist on that host; everything
else answers not-found. Every response there carries `X-Content-Type-Options: nosniff` and a
`sandbox` Content-Security-Policy, sets no cookie, and may carry a real inert type (such as
`application/wasm`) instead of `application/octet-stream`. A product that turns Release off
stops serving them there at once. The host's configuration is in the repository's
`docs/DEPLOYMENT.md`.

## Access modes

Every surface in Release answers under one of four modes, set independently for the
_metadata_ surfaces (changelog, install script) and the _artifact_ surfaces (the download
route itself):

| Mode            | Who                                                                   | Notes                                                                       |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `public`        | anyone                                                                | The default — keeps anonymous installs and anonymous update checks working. |
| `authenticated` | a device with a valid token                                           | Requires a usable license, exactly as `licensed` does today.                |
| `licensed`      | a device whose license is usable                                      | Behaves identically to `authenticated` today (both require a usable one).   |
| `entitled`      | a device whose _own license_ covers the requested channel and version | The only mode that can offer two licensed devices different builds.         |

`licensed` and `authenticated` are kept as two distinct names on purpose, even though
nothing currently distinguishes their enforcement: both refuse a device whose license is not
usable — a product's stated posture should
survive even when today's behavior happens to coincide. `entitled` is genuinely different:
it evaluates the _caller's own_ channel and version entitlements, not merely whether some
usable license exists. The full mechanics — channel resolution, the version window, and
the exact 401/403 outcomes — are covered on Update's
[Eligibility](/docs/services/update/eligibility/) page, since the identical check governs
the feed.

The changelog and the install script are governed by **metadata access**; the download
route itself is governed by **artifacts access**. A product can, for instance, let anyone
read its changelog while requiring a license to actually download the binary it describes.

## Two error grammars

A request refused under `authenticated` or `licensed` gets the same flat body these
surfaces have always answered with:

```json
{ "error": "download_auth_required" }
```

That shape is unchanged deliberately — these paths _moved_ to their current namespace, they
did not change behavior, and a client written against the old routes shouldn't have to
learn a new refusal shape just because the URL did. `entitled` has no such history. It
speaks the newer nested shape throughout, matching the same grammar the signed license
document's own build gate answers with:

```json
// 401 — no usable device/license at all
{ "error": { "code": "unauthorized" } }
```

```json
// 403 — the license doesn't cover the requested channel
{ "error": { "code": "channel_not_allowed" } }
```

```json
// 403 — the requested version sits outside the license's window
{ "error": { "code": "version_blocked" }, "allowedRange": { "min": "2.0.0" } }
```

The window is compared as semver. A pinned version that does not parse as semver (a
four-part `1.2.3.4`, a `2.0.0.1` tag, `3.0.0beta`) cannot be placed in it, so whenever the
window is bounded (a licence, tier or the product's compatibility range sets a minimum or
maximum) such a version is refused with `version_blocked` rather than waved through. This
applies to `/release/dl`, `/release/builds` and `/release/files` alike.

A client that already handles the nested shape for license documents needs nothing new to
handle an `entitled` refusal on a download.

## Changelog

```
GET /<product>/release/changelog
```

Returns `{"entries":[…]}`, one entry per published (non-draft) release: `version`, `tag`,
`date`, a `url` back to the GitHub release, and a `summary`. The summary favors an
explicitly curated block fenced by an HTML comment marker —
`<!-- pkey:summary -->…<!-- /pkey:summary -->` by default, configurable per product —
and falls back to the first prose paragraph above a release's first `##` heading when no
marker is present. Either way the text is markdown-stripped and capped at 600 characters;
this is the same extraction the appcast's `<description>` uses for its release notes.

## The install script

```
GET /<product>/release/install.sh
```

Renders either an operator-supplied template — substituting `{{binaryName}}`,
`{{origin}}`, `{{cliBase}}`, `{{installPath}}`, `{{versionEnv}}`, and `{{channels}}` — or,
when no template is configured, a built-in POSIX script that:

1. Detects the machine's architecture (`arm64`/`x86_64`; anything else, or a non-Darwin
   `uname`, exits with an explanation rather than attempting a download).
2. Downloads the matching binary from this same gateway, selecting `latest` unless an
   environment variable (named after the binary, e.g. `FOO_VERSION`) requests a specific
   version or channel.
3. Fetches the published SHA-256 checksum and refuses to proceed without one — an
   unverifiable binary is treated as an error, not installed anyway with a warning.
4. Verifies the download against that checksum before doing anything else, and stops with
   a clear mismatch message if it disagrees.
5. Installs to `/usr/local/bin` when writable, or `~/.local/bin` otherwise, and prints a
   `PATH` hint when the chosen directory isn't already on it.

Channel builds (`beta`, its legacy alias `staging`, `pr-<n>`) install under a name suffixed
with the channel, so a beta build and the stable install coexist rather than overwriting each
other.

Every value this script interpolates is either bounded to a strict character class or
emitted as a shell-quoted literal, because the whole thing is piped straight into `sh` —
see [GitHub sync](/docs/services/release/github-sync/#binary-name-safety) for where that
validation actually runs.

## See also

- [The truth store](/docs/services/release/truth-store/) — where artifact rows get their
  recorded kind, platform, and architecture (used for the console and portal, not this
  route).
- [Eligibility](/docs/services/update/eligibility/) — channel resolution and the full
  `entitled` decision.
- [Appcast](/docs/services/update/appcast/) — the DMG's other life as a Sparkle enclosure.
- [Channels and policy](/docs/services/release/channels/) — resolution rules, promote, pin,
  yank, and the CI and console operations.
- [Public route table](/docs/reference/routes/) for every Release path in one place.
