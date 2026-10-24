---
title: "Package feeds"
description: "Publish libraries and tools to the package managers your users run, from pkg.plrs.im: URL layout, who may read, per-ecosystem behavior and the console pages."
type: "concept"
lastReviewed: "2026-10-22"
sidebar:
  order: 1
---

Package feeds let a product publish libraries and tools to the package managers its users already run. They answer on `pkg.plrs.im` (`pkg-staging.plrs.im` and `pkg-dev.plrs.im` in the other environments), served by the console's Worker beside `key.plrs.im` and the bytes host `dl.plrs.im`. In the console: **Ship builds → Packages**. To publish, see [Publish a package](/docs/features/ship-builds/packages/publish/). To install, see [Install the SDKs and the CLI](/docs/build/install/).

## Feeds set themselves up

Declare a package in `.pkey/release.yaml` and sync: each ecosystem gets a feed at **Licensed**, with a [derived namespace](#the-derived-namespace). There is no console step, and CI with `publishing.trustedPublisher` publishes into it at once. See [Publish a package](/docs/features/ship-builds/packages/publish/).

| A sync        | Result                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Creates       | A missing feed, and the owner when the product has neither. Audited as `distribution.feed.provision`                               |
| Never changes | A feed or owner that exists: one an operator turned off stays off, a public feed stays public, a namespace an operator set is kept |
| Widens        | Nothing. Public and a wider namespace are console actions                                                                          |
| Skips         | The platform's own feeds                                                                                                           |

Feeds are written whether or not Distribution is on, and answer only while it is.

### The derived namespace

The namespace is the narrowest the ecosystem can express, from the exact names you declared.

| Ecosystem | Derived namespace                                            |
| --------- | ------------------------------------------------------------ |
| npm       | The one `@scope` of the declared names                       |
| Swift     | The one scope                                                |
| PyPI      | The declared names, normalized (PEP 503), never a prefix     |
| Maven     | The declared groupIds, each also admitting its sub-groups    |
| Go        | The declared module paths, each also admitting its sub-paths |
| Godot     | The publisher, set to the product slug                       |
| Cargo     | None: any crate under the owner's path                       |
| OCI       | None: any repository under the owner's path                  |

Several npm or Swift scopes, a one-segment Maven groupId or a host-only Go module have no one namespace: nothing is provisioned, and the sync answer names the reason. Set the namespace in the console.

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

| Promise       | What it means                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cookies    | None is read or set.                                                                                                                                                                                                                                 |
| No CORS       | Registry clients aren't browsers. Reads are `GET` and `HEAD`. `OPTIONS` and every other method answer `405`, except the publish writes in [Publish a package](/docs/features/ship-builds/packages/publish/).                                         |
| Inert answers | Every answer carries `X-Content-Type-Options: nosniff`, a `sandbox` Content-Security-Policy with no sources, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`. A success needs a content type on the host's allowlist. |
| One not-found | An unknown owner, a service or feed that is off and a missing object answer the same `404`, so a caller can't probe whether a feed exists.                                                                                                           |
| No proxying   | A feed never mirrors another registry, so a public package can never stand in for one of yours.                                                                                                                                                      |

## Who may read

Every read runs one access check before the edge cache: the platform's switch for the ecosystem, then the owner's Distribution and package-feeds switch, then the feed's own switch, then the access mode. The stricter of the feed's mode and the package's delivery access applies.

| Mode     | Who may install                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public   | Anyone. No credential is ever looked up                                                                                                                                                                  |
| Licensed | A registry token (`pkeyr_…`) of this product, or a personal token (`pkeyp_…`) of an account with an active license in it. An owner-bound or CI token passes; a license-bound one needs an active license |

The console writes only Public and Licensed (`422`, reason `access_mode_unavailable`, for the rest). A feed from before the two options may read `authenticated` (the same strictness) or `entitled` (a license-bound or personal token also needs the package's gate flag; a package with no gate admits none). An operator's migration job moves them to Licensed and gives each package its own gate row first, so no token gains access.

A token that is absent, malformed, unknown, expired, revoked, another owner's or outside its feeds gets the registry's native `401`. A refused license token is `403`. Device tokens (`pkeyt_…`) and license keys (`pkey_…`) are never registry credentials. Setup for each client is under **Private feeds** on [Install the SDKs and the CLI](/docs/build/install/).

| Client                              | Sends the token as                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| npm, pnpm, Yarn, Bun, SwiftPM       | Bearer                                                                                   |
| pip, uv, Poetry, Gradle, Maven      | Basic `__token__:<token>`                                                                |
| docker, podman                      | `docker login pkg.plrs.im -u __token__`, traded at `/v2/token` for a 5-minute pull token |
| Cargo                               | The bare token                                                                           |
| Godot editor (sends no credentials) | A read-only **Godot editor URL** token inside the URL                                    |

Every token expires within a year and is stored only as a hash. A revoke, a disabled license, a tightened feed or a deleted product takes effect within 30 seconds. docker, SwiftPM and netrc keep one credential per host: one owner's token per device on `pkg.plrs.im`.

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

| Ecosystem | Notes                                                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm       | serves a full or abbreviated packument by `Accept`. `dist.integrity` and `dist.shasum` are computed at publish and `dist.tarball` is an absolute URL on this host. pnpm 11 and recent Yarn refuse versions younger than a day by default, so a newly published version installs after that window or at once for an exempt scope. |
| PyPI      | speaks the Simple Repository API 1.1: PEP 691 JSON first, then inert HTML unless the feed's `htmlFallback` is off (then `406`). Never use `--extra-index-url`, which lets a public package of the same name win.                                                                                                                  |
| Swift     | speaks SE-0292 and signs with SwiftPM's `cms-1.0.0` format. The feed refuses an unsigned release by default. To enforce verification, set `onUnsigned` and `onUntrustedCertificate` to `error` in `.swiftpm/configuration/registries.json`.                                                                                       |
| Maven     | derives `maven-metadata.xml` and the checksum sidecars (`.md5`, `.sha1`, `.sha256`, `.sha512`), so strict checksum policies pass. `-SNAPSHOT` versions are refused.                                                                                                                                                               |
| OCI       | pulls anonymously while the feed is public. A version tag never moves. A manifest or blob is served only by a repository that published it. `DELETE` answers `405`.                                                                                                                                                               |
| Godot     | serves both editor shapes: Godot 4.4 to 4.6 at `/godot/<owner>/asset-library/api`, 4.7 and later at `/godot/<owner>/store/api/v1`, and a `index.json` for GodotEnv. Godot 4.6 and earlier check the zip's SHA-256. Godot 4.7 and later verify no hash and rely on TLS.                                                            |
| Cargo     | is a read-only sparse index (Cargo 1.68 or later, 1.74 or later for a non-public feed) with `registry =` per dependency. A non-public feed needs `credential-provider = "cargo:token"`.                                                                                                                                           |
| Go        | answers only for modules it holds and `404`s the rest, so the go command moves on to the public proxy. Use `GONOSUMDB` for your prefixes, never `GOPRIVATE`, which would skip this feed too. Release `1.4.0` is module version `v1.4.0`.                                                                                          |

## Manage feeds in the console

Role required: platform admin. Both scopes use the same pages: **Platform → Package feeds** for the platform's own packages, and **Ship builds → Packages** for one product's feeds. The product page shows whenever Distribution is on. The platform policy, each ecosystem's switch and size ceiling above every product's own settings, is under **Platform → Settings → Storefront and hosting**; a feed's Settings page links to it.

The product's **Packages** page has one card per feed with a **Licensed** or **Public** chip, or **Waiting for the first package…**; with no package declared it shows the declaration and the CI publish command. In platform scope, the **Overview** has one row per ecosystem with its status, packages, versions, last publish, access mode and registry URL. A status is **Enabled**, **Off** (with the reason) or **Not available** (the platform policy switched the ecosystem off). Before the platform's feeds exist, **Set up platform feeds** creates the system product and one feed per ecosystem. Running it again changes nothing a member set.

Each feed page has four tabs and **Rebuild feed** under **More actions**:

| Tab      | What it holds                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Packages | Every package with its latest live version, tags, live and total versions and last publish. A package opens to **Versions**, **Setup** and **History** |
| Setup    | Copy-paste client setup for the feed's URL and namespace. A non-public feed shows the authenticated form with `PKEY_REGISTRY_TOKEN`                    |
| Settings | Sections that save on their own, with the version they read. A save that races another is refused with `409` and shows the current settings            |
| Activity | Settings changes, rebuilds, yanks and deprecations, and in platform scope the policy changes                                                           |

| Settings section        | What it sets                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| General                 | Whether the feed answers (switching it off asks first: clients get not-found within 30 seconds), and Access       |
| Namespace               | The names the feed may hold. **From manifest** until you choose **Override**. A feed can't be enabled without one |
| Limits                  | The largest package ingest accepts, at most the platform's ceiling                                                |
| Simple API              | PyPI only: **HTML pages**                                                                                         |
| Signing and identifiers | Swift only: **Require signed releases** and **Repository URLs**                                                   |

Moving **Access** from Licensed to Public asks first. Maven always hides yanked versions, so it has no yank setting.

### Turn off package feeds

**Turn off package feeds** stops every feed of the product: installs answer not-found within 30 seconds, `pkey release publish` is refused and service tokens can't install or publish. Versions, tokens and access are kept. Confirm by typing the product slug. The Packages page then shows who turned the feeds off and when, with **Turn on**. A sync never turns them on.

A version row offers only what the protocol can express. A yank needs a reason and is a danger confirmation. Unyank, deprecate and lifting a deprecation are caution confirmations. There is no delete: a version number is unique forever, so a yanked version can never be published again.

### Personal tokens

A personal token (`pkeyp_…`) belongs to a person, not a product: one token installs every package the account may read, across products. A person creates it in Polaris Locker under **Account → Packages**: a name, 1 to 365 days (90 by default), at most 25 live, `packages:read` only, after a sign-in from the last 5 minutes. It is shown once.

The registry host judges it per owner on every request. The account's active licenses in the owner's product count as a license-bound token's do. The platform's own product is never readable by it. It never publishes and is never a Godot editor URL. A person revokes their own; a platform admin can list and revoke any, not create one. Erasing an account revokes its tokens; a merge moves them.

### Service tokens

**Tokens** lists the product's tokens with expiry and last use. **New token** creates a service token: a `pkeyci_…` CI token with the one scope `packages:read`, which reads every private feed of the product. It asks for a label and 1 to 365 days (90 by default), needs Keys and secrets access and a sign-in from the last 5 minutes (an older one asks you to sign in again and keeps your entries), and is shown once with each feed's setup.

**Access** can be **Read and publish** instead: a `pkeyr_…` token bound to the product, with named feeds and 1 to 30 days (7 by default). A license's **Keys** tab has a **Registry tokens** panel for tokens bound to it. An owner-wide read `pkeyr_…` token is retired: existing ones keep working and show **Legacy · works until** their expiry. **Revoke all** revokes every active token of the product. Platform → Package feeds → Tokens has no **New token**: team members use a personal token.

### Retention

Publishing a version on `stable` prunes the package's builds on the two ephemeral tracks: `X-main.N` from `main`, `X-dev.N` from `dev`, or Python's `X.devN`, for every X at or below the released version. Stable and beta versions stay, and so do builds of a newer version and any version a channel points at. Each pruned version is audited as `package.version.prune` and leaves a tombstone: the number is never reused.

Retention is on by default (`release.packages.prunePrereleases`). The first time a product that never chose reaches it, the Worker records what a dry run finds and starts cleanup a week later (`package.prune.notice`). A member's own value applies at once. The platform's own feeds always prune. `pkey feeds prune --product <slug>` is the backfill. It is a dry run unless `--apply`. The token needs `release:yank`, which a member grants.

### The admin API

The admin API is not in the OpenAPI spec, like the rest of the console's API. It takes the console session, with CSRF on mutations. Product feeds sit under `/manage/api/products/<slug>/distribution/feeds` and the platform's under `/manage/api/platform/feeds`. The off switch is the product's `distribution/package-feeds` route (`GET`, and `PUT` with `enabled` and the owner row's `expectedVersion`), audited as `distribution.package_feeds.update`.

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
