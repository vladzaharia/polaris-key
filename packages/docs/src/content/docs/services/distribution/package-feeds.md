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

`GET /` is a static page naming the host, and `GET /v2/` is OCI's base answer
(`Docker-Distribution-API-Version: registry/2.0`): `200` to a request bearing a valid pull token,
and the standard `401` Bearer challenge naming `/v2/token` to any other once the deployment has its
registry token key set (before that, always `200`). Cargo, Go and NuGet names are reserved and
answer the not-found.

## What the host promises

The host is a sibling of the console, so it keeps every guarantee of the bytes host and widens
only the types it may serve:

- **No cookies.** None is read or set. The console's session cookies are host-only, so a browser
  never sends them here.
- **No CORS, GET and HEAD for reads.** Registry clients are not browsers. `OPTIONS` answers
  `405`, and so does every other method except the few writes listed under
  [Publishing with native clients](#publishing-with-native-clients) and SwiftPM's login.
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

`public` feeds are open to everyone, and no credential is ever looked up for them. Every other
mode reads the request's **registry token** (`pkeyr_…`) and judges who it belongs to:

| The token is                                                                             | `authenticated`, `licensed` | `entitled`                                  |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| absent, malformed, unknown, expired, revoked, another owner's, or outside its feeds      | `401`, native challenge     | `401`, native challenge                     |
| bound to the owner (minted in the console), or one of the owner's CI tokens (`pkeyci_…`) | admitted                    | admitted                                    |
| bound to a licence (minted in the portal, or by an operator for a licensee)              | admitted while it is active | also needs the package's delivery gate flag |

A refused licence token is `403` (`forbidden`; OCI `DENIED`; Swift `problem+json`). The native
challenge is `WWW-Authenticate: Basic realm="pkg.plrs.im"` for npm, PyPI, Maven, Swift and Godot,
and OCI's `Bearer realm="https://pkg.plrs.im/v2/token",service=…,scope=…`. Device tokens
(`pkeyt_…`) and licence keys (`pkey_…`) are never registry credentials.

Each client sends the token its own way: Bearer for npm, pnpm, Yarn, Bun and SwiftPM (after
`swift package-registry login`); Basic `__token__:<token>` for pip, uv, Poetry, Gradle and Maven;
OCI clients run `docker login pkg.plrs.im -u __token__` and trade it at `/v2/token` for a
five-minute pull token. The Godot editor sends no credentials, so a **Godot editor URL** token
(read-only, Godot only) goes in its URL: `https://pkg.plrs.im/godot/<owner>/t/<token>/…`. The
setup for each client is on [Installing from the feeds](/docs/build/install-from-feeds/#private-feeds).

Every token expires (at most a year), is bound to one owner and is stored only as a hash. A
revoked token, a disabled licence, a tightened feed and a deleted product all take effect within
30 seconds. A credentialed answer is always `private, no-store` and never enters the edge cache.
docker, SwiftPM and netrc keep one credential per registry host, so one machine can hold a token
for only one owner on `pkg.plrs.im` for those clients.

Settings are held for 30 seconds per isolate, so turning a feed off or tightening its mode
reaches every answer within that window, even one the edge has cached as immutable.

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
  tag. With nothing on `stable`, `latest` is the newest release version, else the newest
  pre-release that no other channel's tag names: a channel's pre-release is never `latest` too.
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
| Credentials   | none for a public feed; for any other, Basic `__token__:<token>` (`authenticate = "always"` for uv; `http-basic` for Poetry)              |

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
`POST …/login` (`swift package-registry login --token`) answers `200` for a registry token valid
for this owner and `401` otherwise, and publishing with
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

## OCI images

The OCI feed serves container images (and any OCI artifact built as an image) to `docker`,
`podman`, `crane` and every other client of the
[OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md).
A repository's full name is `<owner>/<repository>`, where `<repository>` is the package
deliverable's declared `name` (lower-case path components such as `tools/pkey`):

```sh
docker pull pkg.plrs.im/polaris-key/tools/pkey:latest
podman pull pkg.plrs.im/polaris-key/tools/pkey:1.4.0
crane pull --platform linux/arm64 pkg.plrs.im/polaris-key/tools/pkey:beta pkey.tar
```

**What it answers.** Pulls, anonymous while the feed is public, and pushes from a publish token
(see **Pushing with docker push** below):

| Request                                                    | Answer                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`/`HEAD /v2/<owner>/<repository>/manifests/<tag>`      | the manifest or image index the tag points to, with its own media type and `Docker-Content-Digest`; cached for 60 s                                       |
| `GET`/`HEAD /v2/<owner>/<repository>/manifests/sha256:<…>` | the same bytes by digest, immutable                                                                                                                       |
| `GET`/`HEAD /v2/<owner>/<repository>/blobs/sha256:<…>`     | a config or layer, immutable, with `Range` (206) and `If-Range`; only digests this repository published, or (privately) was pushed                        |
| `GET /v2/<owner>/<repository>/tags/list[?n=&last=]`        | the tags in lexical order; with `n`, a `Link: …; rel="next"` header names the next page                                                                   |
| anything else under `/v2/`                                 | OCI's error JSON (`NAME_UNKNOWN`, `MANIFEST_UNKNOWN`, `BLOB_UNKNOWN`); `DELETE` is 405 `UNSUPPORTED`; `/v2/token` is the token service (see Who may read) |

Every answer carries `Docker-Distribution-API-Version: registry/2.0`. A feed that is not public
answers 401 with OCI's `Bearer` challenge.

**Tags.** Each version is a tag of its own name, and it never moves. Each channel is a moving tag:
`stable` is `latest`, and every other channel (`beta`, a manual channel) a tag of its own name,
pointing at the newest version the channel serves. A channel spelled like an existing version is
not tagged, because the version tag wins.

**Yanks and deprecations.** OCI has neither, so a **yanked** version loses its tag (it leaves the
tag list and `pull <name>:<version>` fails) but still pulls **by digest**, so a deployment pinned
to `name@sha256:…` keeps working. A **deprecated** version is served exactly like a live one.

**Publishing.** Declare the package in `.pkey/release` and publish an
[OCI image layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) with
`pkey release publish`; the version is also the image's tag, so it has no `+`:

```jsonc
"deliverables": {
  "oci.pkey": { "kind": "package", "ecosystem": "oci", "name": "tools/pkey",
                "artifacts": { "layout": { "match": "image/**" } } }
}
```

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,tar=false,dest=image .
pkey release publish --product polaris-key --deliverable oci.pkey --dir image --version 1.4.0 --channel stable
```

The CLI reads the layout's `index.json` (exactly one entry: a multi-arch image is one image
index), walks every manifest it references, and uploads each blob once through the upload ticket.
Each blob is at most the feed's ceiling (5 GiB by default), a release is at most 4,096 objects,
and its descriptor at most 64 KiB, which in practice bounds an image to a few hundred blobs.

**Pushing with docker push.** A repository also takes a native push from `docker`, `podman`,
`crane`, `oras` and every other client of the distribution spec's push workflow. The repository
must already be a declared package deliverable (a push never creates one), and the credential
must be able to publish: a registry token minted with **Read and publish** and the OCI feed under
Distribution → Package feeds → Tokens (owner-bound, at most 30 days; it also reads), or a CI token (`pkeyci_…`) holding
`release:publish`, the scope a ticket publish needs:

```sh
echo "$PKEY_PUSH_TOKEN" | docker login pkg.plrs.im -u __token__ --password-stdin
docker buildx build --platform linux/amd64,linux/arm64 -t pkg.plrs.im/polaris-key/tools/pkey:1.4.0 --push .
```

`docker login` trades the token at `/v2/token` for a five-minute token granting `pull,push` on
the repository; every push request re-checks the token behind it, so a revoked one stops pushing
within 30 seconds. A tag pushed is a **version**: the image becomes a release of the package
exactly as `pkey release publish` would make it (the same release rows, refusals and audit
entry), and it joins the product's channels by the same rules, so the newest stable version is
`latest`. Channel tags (`latest`, `stable`, `beta`, `pr-<n>` and manual channel names) are moved
with `pkey release promote`, never pushed, and a version that exists never takes another image.
A manifest pushed **by digest** (an index's platform manifests) is stored and publishes nothing.
Every object a manifest names must be one this owner holds, pushed or published before.

Limits: each request carries at most 100 MB, the zone's body limit. `docker push` and `crane`
(go-containerregistry) send each layer as one streamed `PATCH` without `Content-Length`, which
the registry appends 16 MiB at a time, so a layer of up to 100 MB pushes as it is. A larger layer
needs a client set to send chunks (`PATCH` with `Content-Range`, each under 100 MB) or the ticket
path above. Chunks of any size work (they are fitted to R2's multipart parts server-side); each
blob is at most the feed's ceiling.
An object pushed but not yet in a version is served by digest from its repository only, never
tagged, and never from the bytes host. Nothing is ever deleted: `DELETE` is refused, and an
abandoned upload only drops its own staged bytes.

**Setup snippet.** The console's Setup tab and `pkey feeds setup` (F-12) render this feed from
three values: the registry host (`pkg.plrs.im`, or the environment's), the owner and the
repository; the fully qualified reference `<host>/<owner>/<repository>:<tag>` is the whole
setup, because an OCI client never falls back to another registry for a qualified name.

## Godot

The Godot feed serves both editor API shapes, because the SDK supports Godot 4.4 to 4.7, and an
index for GodotEnv:

| Client                      | Setting                                                                           | Value                                                      |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Godot 4.4 to 4.6 editor     | Editor Settings → `asset_library/available_urls` (Asset Library → Available URLs) | `https://pkg.plrs.im/godot/<owner>/asset-library/api`      |
| Godot 4.7 and later         | Editor Settings → `asset_store/available_urls`                                    | `https://pkg.plrs.im/godot/<owner>/store/api/v1`           |
| GodotEnv, scripted installs | `addons.json`, an entry with `"source": "zip"`                                    | copied from `https://pkg.plrs.im/godot/<owner>/index.json` |

Add the URL with no trailing slash: the editor appends its own paths. Each package's
`index.json` entry carries a ready `addons.json` entry, for example:

```json
{
  "addons": {
    "polaris_key": {
      "url": "https://pkg.plrs.im/godot/<owner>/files/<sha256>/polaris_key-1.4.0.zip",
      "source": "zip",
      "subfolder": "addons/polaris_key"
    }
  }
}
```

- **What a listing shows.** A package appears at its `latest` version (the `stable` channel's
  head). The 4.7 release list shows every version, the stable releases first (newest first) and then
  the pre-releases, because the 4.7 editor preselects the first release; `stable` is false for a
  pre-release on another channel. A **yanked** version is removed from every listing; its zip
  stays downloadable at its content-addressed URL. Godot has no deprecation: a **deprecated**
  version stays listed, and its message leads the description and the release notes.
- **Integrity.** Godot 4.6 and earlier compare the zip with `download_hash`, its SHA-256, which
  the feed always sends. **Godot 4.7 and later verify no hash: an install relies on TLS alone.**
  The Polaris Key SDK's own update path still verifies signed records, not the store download.
- **Archive layout.** An addon zip holds `addons/<name>/…` (what GodotEnv's `subfolder` and the
  4.7 installer expect). The 4.4 to 4.6 installer's **Ignore asset root** option is ticked by
  default and strips that first `addons/` folder, installing at `res://<name>/`; untick it to
  install at `res://addons/<name>/`. The 4.7 installer has no such option.
- **Feed settings.** The publisher (`namespace.publisher`, the 4.7 store path's publisher) is
  required. The extensions are `categoryId` (an Asset Library addon category, default `5`,
  Tools), `supportLevel` (`official`, `community` or `testing`, default `community`), `license`
  (shown as the asset's license, default `Unspecified`) and `minGodotVersion` (for example
  `4.4`; editors older than it, or of another major version, see nothing).
- **Search** is filtered in memory over the owner's packages. Tags are not supported: a
  `#tag` search term matches nothing.

## Publishing with native clients

`pkey release publish` is the way CI publishes a package (it uploads straight to the blob store,
with no size limit but the feed's). A product can also publish with the client its developers
already use. Each request is turned into the same release descriptor the CLI sends and ingested
the same way, so a version published natively is the same package release: the namespace rule,
the feed's size ceiling, "a version is never republished" and Swift's signing rule all apply.

| Client                                             | Request                                            | When the version appears                                   |
| -------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `npm publish` (also pnpm, `yarn npm publish`, Bun) | `PUT /npm/<owner>/<@scope%2fname>`                 | at once; the dist-tag is the channel (`latest` = `stable`) |
| `twine upload`                                     | `POST /pypi/<owner>/legacy/`, one request per file | ten seconds after the last file                            |
| `swift package-registry publish`                   | `PUT /swift/<owner>/<scope>/<name>/<version>`      | at once                                                    |
| `mvn deploy`, Gradle `maven-publish`               | `PUT` each file, then `maven-metadata.xml`         | when `maven-metadata.xml` is uploaded                      |

Before you publish:

- **Declare the package** in `.pkey/release` as a package deliverable and sync the manifest. A
  name no deliverable declares is refused (`package-undeclared`).
- **Get a publish credential.** Either a registry token with **Read and publish** access, minted
  under **Tokens** on the feeds page (owner-bound, naming the feeds it publishes to, at most 30
  days), or, in CI, the 30-minute CI token `pkey auth github-oidc` exchanges for the job's OIDC
  token (it holds `release:publish` and is written to `PKEY_CI_TOKEN`). Prefer the CI token in
  CI: the repository then stores no publish secret at all, which is the point of trusted
  publishing. A read-only or licence-bound token is refused with `403`.
- **Keep a request under 32 MiB.** The bytes pass through the Worker; a larger package publishes
  with `pkey release publish`.

The client setup, with `PKEY_PUBLISH_TOKEN` holding either credential:

```ini
# .npmrc (npm, pnpm): then `npm publish` (or `npm publish --tag beta`)
@acme:registry=https://pkg.plrs.im/npm/acme/
//pkg.plrs.im/npm/acme/:_authToken=${PKEY_PUBLISH_TOKEN}
```

```sh
# twine
twine upload --repository-url https://pkg.plrs.im/pypi/acme/legacy/ \
  -u __token__ -p "$PKEY_PUBLISH_TOKEN" dist/*

# SwiftPM (5.9+): sign with your Swift signing identity when the feed requires it (the default)
swift package-registry set --scope acme https://pkg.plrs.im/swift/acme
swift package-registry login https://pkg.plrs.im/swift/acme --token "$PKEY_PUBLISH_TOKEN" --no-confirm
swift package-registry publish acme.AcmeKit 1.0.0 --signing-identity "…"
```

```kotlin
// Gradle maven-publish
publishing {
  repositories {
    maven {
      name = "acme"
      url = uri("https://pkg.plrs.im/maven/acme/")
      credentials { username = "__token__"; password = System.getenv("PKEY_PUBLISH_TOKEN") }
    }
  }
}
```

For Maven, put the same `__token__` and token in `settings.xml` under a `<server>` whose id
matches the `distributionManagement` repository.

What each adapter checks:

- **npm** — the name in the path, the document and the version agree; the tarball matches npm's
  own `dist.integrity` and `dist.shasum`. Only a publish is accepted: deprecate and yank from the
  console.
- **twine** — each file is a wheel or an sdist of the project and version, and matches twine's
  `sha256_digest`. The files of one version are gathered and published together once the
  uploads stop for ten seconds (or by the next 15-minute cron run). No PEP 658 metadata file is
  served for a twine upload; pip and uv then read the wheel itself.
- **SwiftPM** — the manifests the feed serves are read out of the source archive (a top-level
  `Package.swift` and `Package@swift-*.swift`, at most 1 MiB each). An unsigned release is
  refused where the feed requires signing. An existing version is `409`.
- **Maven and Gradle** — each checksum sidecar must match the file it names (it is not stored:
  the feed derives every sidecar), `.asc` signatures are accepted and dropped, `-SNAPSHOT`
  versions are refused, and a POM must name its path's coordinates. The version publishes when
  `maven-metadata.xml` arrives, or after ten idle minutes.

A publish that fails after the client was answered (a twine or Maven version, in a race) is
recorded in the product's audit log as `release.publish.failed` with its reason.

## Local testing

`pnpm --filter @polaris-key/worker registry:clients` stands up a seeded local Worker on the
registry host (`wrangler dev --env test`, local D1 and R2) and runs real clients against it. The
same harness runs in CI as `registry-clients.yml`.

## Managing feeds

Feed settings, the platform policy, and yanking or deprecating a version are in the console:
**Platform → Package feeds** for the platform's own packages and **Distribution → Package feeds**
for a product's. See [Package feeds in the console](/docs/admin/feeds/).
