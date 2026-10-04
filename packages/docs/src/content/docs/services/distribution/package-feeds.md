---
sidebar:
  order: 10
title: "Package feeds"
description: "The registry host, pkg.plrs.im: package feeds for npm, PyPI, SwiftPM, Maven and Gradle, OCI and Godot clients, with one access check before every cached answer."
---

Package feeds let a product publish libraries and tools to the package managers its users
already run. They answer on their own host, **`pkg.plrs.im`** (`pkg-staging.plrs.im` and
`pkg-dev.plrs.im` in the other environments): the same Worker as the console, on a third custom
domain beside `key.plrs.im` and the bytes host `dl.plrs.im`.

## URL layout

Every feed is under its owner (the product slug), so a product never shadows another's names.
OCI is the exception the protocol forces: its root is `/v2/`, and the repository name starts with
the owner.

| Ecosystem | Base URL                                   | Clients                                    |
| --------- | ------------------------------------------ | ------------------------------------------ |
| npm       | `https://pkg.plrs.im/npm/<owner>/`         | npm, pnpm, Yarn Berry, Bun                 |
| PyPI      | `https://pkg.plrs.im/pypi/<owner>/simple/` | pip, uv, Poetry                            |
| Swift     | `https://pkg.plrs.im/swift/<owner>/`       | SwiftPM                                    |
| Maven     | `https://pkg.plrs.im/maven/<owner>/`       | Gradle, Maven                              |
| OCI       | `https://pkg.plrs.im/v2/<owner>/…`         | docker, podman, crane                      |
| Godot     | `https://pkg.plrs.im/godot/<owner>/`       | the Godot editor's asset library, GodotEnv |

`GET /` is a static page naming the host, and `GET /v2/` is OCI's base answer (`200`,
`Docker-Distribution-API-Version: registry/2.0`). Cargo, Go and NuGet names are reserved and
answer the not-found.

## What the host promises

The host is a sibling of the console, so it keeps every guarantee of the bytes host and widens
only the types it may serve:

- **No cookies.** None is read or set. The console's session cookies are host-only, so a browser
  never sends them here.
- **No CORS, GET and HEAD only.** Registry clients are not browsers. `OPTIONS` and every other
  method answer `405`.
- **Inert answers.** Every answer carries `X-Content-Type-Options: nosniff`, a `sandbox`
  `Content-Security-Policy` with no sources, `Referrer-Policy: no-referrer` and
  `Cross-Origin-Resource-Policy: same-origin`. A success must have a type on the host's
  allowlist: registry JSON, `text/x-swift` (always an attachment), PNG, JPEG and archive types.
  XML files (POMs, `maven-metadata.xml`) go out as `application/octet-stream` attachments. The
  only HTML is PyPI's simple page for clients that do not ask for JSON, under a policy that
  forbids script, forms and framing.
- **One not-found.** An unknown owner, a service or feed that is off and a missing object all
  answer the same `404`, so whether a feed exists cannot be probed.

## Who may read

Every read runs one access check before the edge cache is consulted:

1. the platform's switch for the ecosystem;
2. the owner's Distribution and its package-feeds switch, then the feed's own switch;
3. the access mode: the stricter of the feed's mode and the package's delivery access
   (`public`, `authenticated`, `licensed`, `entitled`).

`public` feeds are open to everyone. Any other mode answers the client's native `401`
(`WWW-Authenticate: Basic` for npm, PyPI, Maven, Swift and Godot; OCI's `Bearer` challenge),
because registry credentials are not issued yet. Settings are held for 30 seconds per isolate,
so turning a feed off or tightening its mode reaches every answer within that window, even one
the edge has cached as immutable.

## Caching

| Answer                                                             | `Cache-Control`                                 | `ETag`             |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------ |
| Content-addressed bytes (tarballs, wheels, zips, OCI blobs, icons) | `public, max-age=31536000, immutable`           | the SHA-256        |
| Index documents (packuments, simple pages, metadata, tag lists)    | `public, max-age=60, stale-while-revalidate=60` | the body's SHA-256 |
| Not-found and refusals                                             | `no-store`                                      | none               |
| Any non-public feed                                                | `private, no-store`                             | none               |

A new version shows up within about a minute. Index documents are rendered when a package
changes and kept in the blob bucket under `registry/`; a document that goes missing is rendered
again on the next read.

## PyPI

The PyPI feed speaks the
[Simple Repository API](https://packaging.python.org/en/latest/specifications/simple-repository-api/)
at API version 1.1, so pip, uv and Poetry install from it unchanged.

| Path                                            | What it answers                     |
| ----------------------------------------------- | ----------------------------------- |
| `/pypi/<owner>/simple/`                         | the project list                    |
| `/pypi/<owner>/simple/<project>/`               | one project's page                  |
| `/pypi/<owner>/files/<sha256>/<filename>`       | a wheel or an sdist                 |
| `/pypi/<owner>/files/<sha256>/<wheel>.metadata` | the wheel's core metadata (PEP 658) |

- **JSON first.** A client whose `Accept` lists `application/vnd.pypi.simple.v1+json` (pip 22.2
  and later, uv, Poetry) gets PEP 691 JSON with that exact type. Any other client gets the same
  page as inert HTML (`application/vnd.pypi.simple.v1+html`): every value escaped, no script,
  form or style. With the feed's `htmlFallback` setting off, a client that cannot take JSON gets
  `406`. pip before 22.2 asks only for `text/html`, which the host never serves.
- **Names.** Project names compare after PEP 503 normalisation. `/simple/Acme_SDK`, or any
  spelling without the trailing slash, answers `301` to `/simple/acme-sdk/`.
- **Files.** Each file lists `hashes.sha256` (and a `#sha256=` fragment in HTML), `size`,
  `upload-time`, `requires-python` and, for a wheel published with its `METADATA`,
  `core-metadata` (PEP 714). The hash protects against corruption only; it says nothing about who
  published the file. File URLs embed the SHA-256, so they never change.
- **Yank, deprecate, channels.** A yanked version keeps its files listed with PEP 592's `yanked`
  and the reason: installers skip it for a range but still install it for an exact `==` pin. PyPI
  has no deprecation, so a deprecated version is listed as live. PyPI has no tags either: publish
  pre-releases with a PEP 440 version (`1.1.0b1`), and pip `--pre` or a pre-release specifier
  selects them, whatever channel the release was published to.

### Setup snippet inputs

The console's Setup tab and `pkey feeds setup` (F-12) render the PyPI snippets from these inputs.
Each snippet uses a strict router, so the feed is the only index asked for its names:

| Input         | Value                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Index URL     | `https://pkg.plrs.im/pypi/<owner>/simple/`                                                                                                |
| Project names | the feed's namespace: its `names` and `prefixes`                                                                                          |
| uv            | `[[tool.uv.index]]` with `explicit = true`, plus a `[tool.uv.sources]` entry per project                                                  |
| Poetry        | `[[tool.poetry.source]]` with `priority = "explicit"`, plus `source = "<name>"` per dependency                                            |
| pip           | `--index-url` (or `pip.conf` `index-url`); never `--extra-index-url`, which has no routing and lets a public package of the same name win |
| Credentials   | none while feeds are public; tokens come with registry credentials (F-21)                                                                 |

## Local testing

`pnpm --filter @polaris-key/worker registry:clients` stands up a seeded local Worker on the
registry host (`wrangler dev --env test`, local D1 and R2) and runs real clients against it. The
same harness runs in CI as `registry-clients.yml`.
