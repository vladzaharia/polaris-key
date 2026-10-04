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

## npm

The npm feed serves scoped packages only, and the scope must be the feed's own (`@polaris-key`
for the platform's packages). It speaks the npm registry's read protocol, so npm, pnpm, Yarn
Berry and Bun install from it unchanged.

| Request                                             | Answer                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| `GET /npm/<owner>/@scope%2fname` (or `@scope/name`) | the packument; `%2f` and `%2F` are the same document |
| `GET /npm/<owner>/@scope/name/-/name-<version>.tgz` | the version's tarball, as `dist.tarball` names it    |

- **Full or abbreviated.** An installer's `Accept` lists `application/vnd.npm.install-v1+json`
  first and gets the abbreviated packument; anything else (`npm view`, a browser) gets the full
  one as `application/json`. Answers carry `Vary: Accept`.
- **Integrity.** `dist.integrity` is the tarball's SHA-512 as an SRI string and `dist.shasum` its
  SHA-1, both computed when the version was published; `dist.tarball` is an absolute URL on this
  host. npm, pnpm and Bun check the bytes against them; Yarn Berry instead pins its own checksum
  in `yarn.lock` on the first install and checks that afterwards.
- **Tags.** `dist-tags` come from the release channels: `stable` is `latest`, and any other
  channel is a tag of its own name (`beta`, `pr-12`). Promoting or pinning a channel moves its
  tag.
- **Yank and deprecate.** npm has no yank. A yanked version stays in the packument and installs
  by exact version, so existing lockfiles keep working, but it leaves every tag and carries
  `deprecated` with the yank reason, so clients warn and range resolution prefers another
  version where the client supports that (npm does). A deprecated version carries its message.
- Names outside the feed's scope, unscoped names and unknown versions answer the same not-found
  as a feed that does not exist.

### Setup

Route only the feed's scope to it, so no other name can resolve here (and none of the feed's
names can resolve anywhere else). For an owner `acme` with the scope `@acme`:

```ini
# .npmrc (npm, pnpm)
@acme:registry=https://pkg.plrs.im/npm/acme/
```

```yaml
# .yarnrc.yml (Yarn Berry)
npmScopes:
  acme:
    npmRegistryServer: "https://pkg.plrs.im/npm/acme/"
```

```toml
# bunfig.toml (Bun)
[install.scopes]
"@acme" = "https://pkg.plrs.im/npm/acme/"
```

Recent Yarn releases refuse versions younger than their `npmMinimalAgeGate` setting by
default ("quarantined"), reading each version's publication time from the packument; a version
just published installs with Yarn once that window has passed, or at once with
`npmMinimalAgeGate: 0` in `.yarnrc.yml`.

The snippets take three inputs: the registry host's origin, the owner (the product slug), and
the feed's scope (`dist_registry_feeds.namespace_json` `{scope}`). The console's setup tab and
`pkey feeds setup` render them from those alone.

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

## Swift (SwiftPM)

The Swift feed speaks SwiftPM's registry protocol (SE-0292) under
`https://pkg.plrs.im/swift/<owner>/`. A package's identity is `<scope>.<Name>`, where the scope is
the feed's namespace (`polaris-key` for the platform's own packages); scope and name are
case-insensitive.

| Endpoint                                       | Answer                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET …/<scope>/<name>`                         | The release list. A yanked version carries a `problem` (410 Gone), so SwiftPM never picks it |
| `GET …/<scope>/<name>/<version>`               | The release metadata: the archive's SHA-256 `checksum` and its signature                     |
| `GET …/<scope>/<name>/<version>/Package.swift` | The signed manifest, with an `alternate` link per `Package@swift-*.swift`                    |
| `GET …/<scope>/<name>/<version>.zip`           | The source archive, with `X-Swift-Package-Signature` and `-Format`                           |
| `GET …/identifiers?url=`                       | The packages the feed maps a repository URL to (the feed's `repositoryUrls` setting)         |

Every answer carries `Content-Version: 1`, and every error is `application/problem+json`. An
`Accept` header naming an invalid registry version is 400 and an unsupported one 415.
`swift package-registry login` answers 501 until registry credentials exist, and publishing with
`swift package-registry publish` is not accepted: releases arrive through
`pkey release publish`.

**Set up a project.** Route only your scope to the feed, so no other dependency is ever looked up
here:

```sh
swift package-registry set --scope <scope> https://pkg.plrs.im/swift/<owner>
```

```swift
.package(id: "<scope>.<Name>", from: "1.0.0")
```

**Signed releases.** Releases are signed with SwiftPM's own `cms-1.0.0` format and the feed
refuses an unsigned one (the feed setting `requireSigned`, always on for the platform's
packages). The registry serves the signature; SwiftPM verifies it. To make verification
mandatory, set `onUnsigned` and `onUntrustedCertificate` to `error` under `security` in
`.swiftpm/configuration/registries.json`, and trust the signing certificate's root.

**Versions and channels.** A version never changes after it is published: its archive and
manifests stay downloadable even after a yank, because SwiftPM pins the checksum the first time
it sees a version. The `latest-version` link names the stable channel's newest version. A
prerelease published to another channel (`2.0.0-beta.1` on `beta`) resolves only for a
requirement that names a prerelease. The protocol has no deprecation, so a deprecated version is
listed as available.

**Setup snippet inputs** (what the console and `pkey feeds setup` render): the feed URL
`<origin>/swift/<owner>`, the feed's `scope`, and one example package identity
`<scope>.<Name>` with its newest stable version.

## Maven

The Maven feed is a plain Maven repository at `https://pkg.plrs.im/maven/<owner>/`, laid out as
Gradle and Maven expect: `<group/as/path>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<extension>`.
It serves the files a publication carried (the POM, Gradle's `.module`, the jar or AAR and any
classified file such as `-sources.jar`) and two things it derives instead of storing:

- **`maven-metadata.xml`** for each artifact, rendered from the package's versions:
  - `versions` lists every version that is not yanked, oldest first;
  - `release` (Maven's `RELEASE`) is the `stable` channel's current version, and is left out
    while the stable channel serves nothing;
  - `latest` (Maven's `LATEST`) is the newest listed version of any channel, so a beta published
    after the last stable release is `latest` but never `release`;
  - `lastUpdated` is the newest listed version's publication time.
- **Checksum sidecars**: `.md5`, `.sha1`, `.sha256` and `.sha512` beside every file and beside
  `maven-metadata.xml`, from digests computed when the version was published. They cannot
  disagree with the bytes, so Gradle's and Maven's strict checksum policies pass.

Maven has no yank or deprecation of its own:

- **A yanked version** leaves `maven-metadata.xml`, so no dynamic version (`1.+`, a range,
  `LATEST`, `RELEASE`) resolves to it again. Its files stay downloadable by exact coordinates,
  so a build that pinned it keeps working.
- **A deprecated version** stays listed. The message shows in the console.

Paths are case-sensitive and must match the declared `groupId:artifactId`. `-SNAPSHOT` versions
are refused at publish, so there is no version-level metadata. Signatures (`.asc`) and directory
listings are not served. Every Maven answer, the metadata and POMs included, is
`application/octet-stream` with `Content-Disposition: attachment`: Gradle and Maven ignore the
response type.

**Gradle** (`settings.gradle.kts`). `exclusiveContent` sends your groups only to this feed and
never looks for them anywhere else, which is the dependency-confusion guard:

```kotlin
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository {
                maven { url = uri("https://pkg.plrs.im/maven/<owner>/") }
            }
            filter { includeGroupAndSubgroups("<groupPrefix>") }
        }
        mavenCentral()
    }
}
```

**Maven** (`pom.xml`), with checksum failures fatal:

```xml
<repositories>
  <repository>
    <id>polaris-key-<owner></id>
    <url>https://pkg.plrs.im/maven/<owner>/</url>
    <releases><checksumPolicy>fail</checksumPolicy></releases>
    <snapshots><enabled>false</enabled></snapshots>
  </repository>
</repositories>
```

`<owner>` is the product slug (`polaris-key` for the platform's own packages) and `<groupPrefix>`
each entry of the feed's group prefixes (`im.plrs.key` for the platform's).

## Local testing

`pnpm --filter @polaris-key/worker registry:clients` stands up a seeded local Worker on the
registry host (`wrangler dev --env test`, local D1 and R2) and runs real clients against it. The
same harness runs in CI as `registry-clients.yml`.
