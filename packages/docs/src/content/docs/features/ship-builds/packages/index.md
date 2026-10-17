---
title: "Package feeds"
description: "Publish libraries and tools to the package managers your users run, from pkg.plrs.im: URL layout, who may read, per-ecosystem behavior and the console pages."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

Package feeds let a product publish libraries and tools to the package managers its users already run. They answer on their own host, `pkg.plrs.im` (`pkg-staging.plrs.im` and `pkg-dev.plrs.im` in the other environments): the same Worker as the console, on a third custom domain beside `key.plrs.im` and the bytes host `dl.plrs.im`. In the console: **Distribution → Package feeds**. To publish, see [Publish a package](/docs/features/ship-builds/packages/publish/). To install, see [Install the SDKs and the CLI](/docs/build/install/).

## URL layout

Every feed sits under its owner, the product slug, so a product never shadows another's names. OCI is the exception the protocol forces: its root is `/v2/`, and the repository name starts with the owner.

| Ecosystem | Base URL                                    | Clients                              |
| --------- | ------------------------------------------- | ------------------------------------ |
| npm       | `https://pkg.plrs.im/npm/<owner>/`          | npm, pnpm, Yarn Berry, Bun           |
| PyPI      | `https://pkg.plrs.im/pypi/<owner>/simple/`  | pip, uv, Poetry                      |
| Swift     | `https://pkg.plrs.im/swift/<owner>/`        | SwiftPM                              |
| Maven     | `https://pkg.plrs.im/maven/<owner>/`        | Gradle, Maven                        |
| OCI       | `https://pkg.plrs.im/v2/<owner>/…`          | docker, podman, crane                |
| Godot     | `https://pkg.plrs.im/godot/<owner>/`        | The editor's asset library, GodotEnv |
| Cargo     | `sparse+https://pkg.plrs.im/cargo/<owner>/` | Cargo                                |
| Go        | `https://pkg.plrs.im/go/<owner>`            | The go command, as a GOPROXY         |

`GET /` is a static page naming the host. NuGet names are reserved and answer not-found.

## What the host promises

- **No cookies.** None is read or set.
- **No CORS.** Registry clients aren't browsers. Reads are `GET` and `HEAD`. `OPTIONS` and every other method answer `405`, except the publish writes in [Publish a package](/docs/features/ship-builds/packages/publish/).
- **Inert answers.** Every answer carries `X-Content-Type-Options: nosniff`, a `sandbox` Content-Security-Policy with no sources, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`. A success needs a content type on the host's allowlist.
- **One not-found.** An unknown owner, a service or feed that is off and a missing object answer the same `404`, so a caller can't probe whether a feed exists.
- **No proxying.** A feed never mirrors another registry, so a public package can never stand in for one of yours.

## Who may read

Every read runs one access check before the edge cache: the platform's switch for the ecosystem, then the owner's Distribution and package-feeds switch, then the feed's own switch, then the access mode. The stricter of the feed's mode and the package's delivery access applies.

| Mode      | Who may install                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public    | Anyone. No credential is ever looked up                                                                                                                                                                        |
| Customers | A registry token (`pkeyr_…`) of this product, or a personal token (`pkeyp_…`) of an account with an active license in it. An owner-bound or CI token passes, and a license-bound token needs an active license |
| Entitled  | Owner-bound and CI tokens pass. A license-bound or personal token also needs the package's delivery gate flag. A package with no gate admits no license token                                                  |

Customers is stored as `authenticated` or `licensed`. They are one strictness. A package stricter than its feed is left out of list documents, so a license holder finds it in Godot search or the PyPI project list only by its exact name.

A token that is absent, malformed, unknown, expired, revoked, another owner's or outside its feeds gets the registry's native `401`. A refused license token is `403`. Device tokens (`pkeyt_…`) and license keys (`pkey_…`) are never registry credentials. Each client sends the token its own way: Bearer for npm, pnpm, Yarn, Bun and SwiftPM; Basic `__token__:<token>` for pip, uv, Poetry, Gradle and Maven; `docker login pkg.plrs.im -u __token__`, traded at `/v2/token` for a 5-minute pull token; the bare token for Cargo; and for the Godot editor, which sends no credentials, a read-only **Godot editor URL** token inside the URL. Setup for each client is under **Private feeds** on [Install the SDKs and the CLI](/docs/build/install/).

Every token expires within a year and is stored only as a hash. A registry token is bound to one owner. A personal token is not: see [Personal tokens](#personal-tokens). A revoked token, a disabled license, a tightened feed and a deleted product all take effect within 30 seconds. docker, SwiftPM and netrc keep one credential per host, so one device holds a token for one owner on `pkg.plrs.im` for those clients.

## Caching

| Answer                                                             | `Cache-Control`                                 | `ETag`             |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------ |
| Content-addressed bytes (tarballs, wheels, zips, OCI blobs, icons) | `public, max-age=31536000, immutable`           | The SHA-256        |
| Index documents (packuments, simple pages, metadata, tag lists)    | `public, max-age=60, stale-while-revalidate=60` | The body's SHA-256 |
| Not-found and refusals                                             | `no-store`                                      | None               |
| Any non-public feed                                                | `private, no-store`                             | None               |

A new version shows up within about a minute. Index documents are rendered when a package changes and kept in the blob bucket. A missing document is rendered again on the next read. Feed settings are held for 30 seconds per isolate.

## What each ecosystem does

Every feed routes only its own names to itself, so no other name can resolve there. The setup snippets come from `pkey feeds setup`, byte for byte as in the console's **Setup** tab.

| Ecosystem | Names                                             | Channels                                                         | Yank                                                              | Deprecate                                            |
| --------- | ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| npm       | Scoped packages only, in the feed's scope         | `dist-tags`: `stable` is `latest`, others are tags of their name | None: a yanked version leaves every tag and carries `deprecated`  | Yes: the version installs and npm prints the message |
| PyPI      | The feed's names and prefixes, PEP 503 normalized | None: use a PEP 440 pre-release such as `1.1.0b1`                | Yes (PEP 592): pinned installs work, resolvers skip it            | No: listed as live                                   |
| Swift     | `<scope>.<Name>`, the scope is the feed's         | The `latest-version` link is the stable head                     | Yes: leaves the release list, stays fetchable                     | No: listed as available                              |
| Maven     | Group prefixes                                    | `release` is the stable head, `latest` the newest of any channel | Yes: leaves `maven-metadata.xml`, files stay by exact coordinates | No: stays listed                                     |
| OCI       | `<owner>/<repository>`                            | A moving tag per channel: `stable` is `latest`                   | Yes: the version tag is removed, the digest still pulls           | No: served as live                                   |
| Godot     | Publisher                                         | The stable head is listed, pre-releases follow                   | Yes: removed from listings, the zip stays at its hashed URL       | No: stays listed, message leads the description      |
| Cargo     | Every crate in the owner's index                  | None: choose a pre-release by version                            | Yes: the index line is marked `yanked`                            | No: listed as live                                   |
| Go        | Module prefixes                                   | Queries such as `@beta` resolve to the channel's version         | Yes: leaves `@v/list` and `@latest`, files stay for go.sum        | No                                                   |

- **npm** serves a full or abbreviated packument by `Accept`. `dist.integrity` and `dist.shasum` are computed at publish and `dist.tarball` is an absolute URL on this host. pnpm 11 and recent Yarn refuse versions younger than a day by default, so a newly published version installs after that window or at once for an exempt scope.
- **PyPI** speaks the Simple Repository API 1.1: PEP 691 JSON first, then inert HTML unless the feed's `htmlFallback` is off (then `406`). Never use `--extra-index-url`, which lets a public package of the same name win.
- **Swift** speaks SE-0292 and signs with SwiftPM's `cms-1.0.0` format. The feed refuses an unsigned release by default. To enforce verification, set `onUnsigned` and `onUntrustedCertificate` to `error` in `.swiftpm/configuration/registries.json`.
- **Maven** derives `maven-metadata.xml` and the checksum sidecars (`.md5`, `.sha1`, `.sha256`, `.sha512`), so strict checksum policies pass. `-SNAPSHOT` versions are refused.
- **OCI** pulls anonymously while the feed is public. A version tag never moves. A manifest or blob is served only by a repository that published it. `DELETE` answers `405`.
- **Godot** serves both editor shapes: Godot 4.4 to 4.6 at `/godot/<owner>/asset-library/api`, 4.7 and later at `/godot/<owner>/store/api/v1`, and a `index.json` for GodotEnv. Godot 4.6 and earlier check the zip's SHA-256. Godot 4.7 and later verify no hash and rely on TLS.
- **Cargo** is a read-only sparse index (Cargo 1.68 or later, 1.74 or later for a non-public feed) with `registry =` per dependency. A non-public feed needs `credential-provider = "cargo:token"`.
- **Go** answers only for modules it holds and `404`s the rest, so the go command moves on to the public proxy. Use `GONOSUMDB` for your prefixes, never `GOPRIVATE`, which would skip this feed too. Release `1.4.0` is module version `v1.4.0`.

## Manage feeds in the console

Role required: platform admin. Both scopes use the same pages: **Platform → Package feeds** for the platform's own packages, and **Distribution → Package feeds** for one product's feeds. The product page appears while the **Packages** switch under **Ship builds** on **Core → Services** is on. The platform scope also holds the platform policy: each ecosystem's switch and size ceiling above every product's own settings.

The **Overview** has one row per ecosystem with its status, packages, versions, last publish, access mode and registry URL. A status is **Enabled**, **Off** (with the reason) or **Not available** (the platform policy switched the ecosystem off). Before the platform's feeds exist, **Set up platform feeds** creates the system product and one feed per ecosystem. Running it again changes nothing a member set.

Each feed page has four tabs and **Rebuild feed** under **More actions**:

| Tab      | What it holds                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Packages | Every package with its latest live version, tags, live and total versions and last publish. A package opens to **Versions**, **Setup** and **History** |
| Setup    | Copy-paste client setup for the feed's URL and namespace. A non-public feed shows the authenticated form with `PKEY_REGISTRY_TOKEN`                    |
| Settings | Sections that save on their own, with the version they read. A save that races another is refused with `409` and shows the current settings            |
| Activity | Settings changes, rebuilds, yanks and deprecations, and in platform scope the policy changes                                                           |

| Settings section        | What it sets                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| General                 | Whether the feed answers. Switching it off asks first: clients get not-found within 30 seconds                 |
| Access                  | Public, Customers or Entitled. Leaving Public asks first                                                       |
| Namespace               | The names the feed may hold. A feed can't be enabled without one                                               |
| Limits                  | The largest package ingest accepts, at most the platform's ceiling                                             |
| Yank policy             | Maven only: **Hide yanked versions** leaves a yanked version out of `maven-metadata.xml`                       |
| Simple API              | PyPI only: **HTML pages**                                                                                      |
| Signing and identifiers | Swift only: **Require signed releases** and **Repository URLs**                                                |
| Retention               | OCI only: the days an untagged manifest may be kept. It is stored only: nothing removes untagged manifests yet |
| Asset listing           | Godot only: category, support level, license and oldest editor                                                 |

A version row offers only what the protocol can express. A yank needs a reason and is a danger confirmation. Unyank, deprecate and lifting a deprecation are caution confirmations. There is no delete: a version number is unique forever, so a yanked version can never be published again.

### Personal tokens

A personal token (`pkeyp_…`) belongs to a person, not a product. One token installs every package the account may read, across products. A person creates it in the portal under **Account → Packages**: a name, 1 to 365 days (90 by default), at most 25 live, `packages:read` only. Creating one needs a sign-in from the last 5 minutes. The token is shown once and stored only as a keyed hash; the list shows its name, last four characters, last use and expiry.

The registry host works out what the token may read for each owner on every request:

- The account's active licenses in the owner's product, judged exactly as a license-bound token is: usable for Customers, and for Entitled also holding the package's gate flag.
- The platform's own product (`system`) is never readable by a customer's token, whatever licenses the account holds.
- A personal token never publishes, and is never a Godot editor URL token.

A person revokes their own tokens. A platform admin lists every personal token under **Personal tokens** in the console and can revoke one; they cannot create one. Revoking takes effect within 30 seconds. An erased account's tokens are revoked first; merging two accounts moves the tokens to the one that stays.

### Registry tokens

**Tokens** lists the owner's `pkeyr_…` tokens: label, last four characters, feeds, binding, creator, expiry, last use and status. **New token** asks for a label, the feeds, an expiry of 1 to 365 days (90 by default), a binding (the product, or one license), and **Godot editor URL**, a read-only token for the Godot feed that lasts 30 days by default. The token is shown once. **Access** chooses **Read** or **Read and publish**. A publish token is bound to the product, names its feeds explicitly and lasts 1 to 30 days (7 by default). Revoking is a danger confirmation and takes effect within 30 seconds. **Revoke all** revokes every active token of the owner, including those licensees minted. A license's **Keys** tab has a **Registry tokens** panel for the tokens bound to it. The portal no longer mints license-bound tokens: licensees create a personal token instead. The license-bound tokens already minted keep working until they expire and can still be revoked.

### Retention

Publishing a version on `stable` prunes the package's builds on the two ephemeral tracks: `X-main.N` from `main`, `X-dev.N` from `dev`, or Python's `X.devN`, for every X at or below the released version. Stable and beta versions stay, and so do builds of a newer version and any version a channel points at. Each pruned version is audited as `package.version.prune` and leaves a tombstone, so the number is never published again.

Retention is on by default (`release.packages.prunePrereleases`). The first time a product that never chose reaches it, the Worker records what a dry run finds and starts cleanup a week later (`package.prune.notice`). Nothing is deleted before that day. A member's own value applies at once. The platform's own feeds always prune. `pkey feeds prune --product <slug>` is the backfill. It is a dry run unless `--apply`. The token needs `release:yank`, which a member grants.

### The admin API

The admin API is not in the OpenAPI spec, like the rest of the console's API. It takes the console session, with CSRF on mutations. Product feeds sit under `/manage/api/products/<slug>/distribution/feeds` and the platform's under `/manage/api/platform/feeds`.

| Method        | Path under the feeds base                                                              | Audit action                              |
| ------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `GET`         | (base): every feed, and the owners                                                     | None                                      |
| `GET`         | `/<eco>`: settings, policy and capabilities                                            | None                                      |
| `PUT`         | `/<eco>/settings`                                                                      | `feed.settings.update`                    |
| `PUT`         | `/<eco>/policy` (platform only)                                                        | `feed.policy.update`                      |
| `GET`         | `/<eco>/packages` and `/<eco>/activity`                                                | None                                      |
| `POST`        | `/<eco>/packages/<name>/versions/<version>/yank`, `unyank`, `deprecate`, `undeprecate` | `package.version.*`                       |
| `POST`        | `/<eco>/rebuild`                                                                       | `feed.rebuild`                            |
| `GET`, `PUT`  | `/retention`                                                                           | `feed.retention.update`                   |
| `POST`        | `/prune` and `/bootstrap` (platform only)                                              | `package.version.prune`, `feed.bootstrap` |
| `GET`, `POST` | `/tokens`, `/tokens/<id>/revoke`, `/tokens/revoke-all`                                 | `registry_token.*`                        |

## Next steps

- [Publish a package](/docs/features/ship-builds/packages/publish/): native clients and the CLI.
- [Install the SDKs and the CLI](/docs/build/install/): client setup, age gates and private feeds.
