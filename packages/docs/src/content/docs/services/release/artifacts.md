---
sidebar:
  order: 4
title: "Artifacts, changelog & install"
description: "The unified download route, architecture matching, the four access modes, and the curl-pipe installer."
---

Three things make up what a human or an install script actually touches: downloading a
binary (as a bare CLI executable or a macOS disk image — two content types behind one
route), reading the changelog, and running the installer. The first two resolve live against
GitHub on every request — the changelog is the only one of the three the edge cache will
hold, and a download is streamed through every time — while the installer is rendered from
stored configuration and touches GitHub not at all. What none of them read is the
[truth store](/docs/services/release/truth-store/), which exists for the portal and the
console, not for these routes.

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

- **`<version>`** is a channel selector: `latest`, `stable`, a pinned `X.Y.Z` tag, `beta`,
  `pr-<n>`, or an operator's manual channel name — the identical vocabulary
  [Eligibility](/docs/services/update/eligibility/) documents in full, since the download
  route, the appcast, and the version check all resolve it through the same logic.
- **`<binary>-<arch>`** matches an asset by convention. On the bare-binary path an exact
  filename hit (`<binaryName>-<arch>`, or `<binaryName>-<channel>-<arch>` for a non-stable
  channel) short-circuits everything else. Failing that — and always, for a DMG — matching
  scores candidates by file extension, architecture token, binary name, and channel suffix.
  Real projects aren't always perfectly consistent about naming, so this is deliberately
  fuzzy; when it leaves two equally good candidates the route answers `404` rather than
  guessing.
- **`[.dmg]`** — presence of the extension selects the macOS disk image path; its absence
  selects the bare CLI binary. Same handler and the same scoring function, two different
  `Content-Type` values on the way out; only the CLI path carries the exact-name
  short-circuit above.

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

Channel builds (`staging`, `beta`, `pr-<n>`) install under a name suffixed with the
channel, so a staging build and the stable install coexist rather than overwriting each
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
- [Public route table](/docs/reference/routes/) for every Release path in one place.
