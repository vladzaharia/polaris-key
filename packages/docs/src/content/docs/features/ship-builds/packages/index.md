---
sidebar:
  order: 10
title: "Package feeds"
description: "The registry host, pkg.plrs.im: package feeds for npm, PyPI, SwiftPM, Maven and Gradle, OCI, Godot, Cargo and Go clients, with one access check before every cached answer."
---

Package feeds let a product publish libraries and tools to the package managers its users
already run. They answer on their own host, **`pkg.plrs.im`** (`pkg-staging.plrs.im` and
`pkg-dev.plrs.im` in the other environments): the same Worker as the console, on a third custom
domain beside `key.plrs.im` and the bytes host `dl.plrs.im`.

## URL layout

Every feed is under its owner (the product slug), so a product never shadows another's names.
OCI is the exception the protocol forces: its root is `/v2/`, and the repository name starts with
the owner.

| Ecosystem | Base URL                                    | Clients                                    |
| --------- | ------------------------------------------- | ------------------------------------------ |
| npm       | `https://pkg.plrs.im/npm/<owner>/`          | npm, pnpm, Yarn Berry, Bun                 |
| PyPI      | `https://pkg.plrs.im/pypi/<owner>/simple/`  | pip, uv, Poetry                            |
| Swift     | `https://pkg.plrs.im/swift/<owner>/`        | SwiftPM                                    |
| Maven     | `https://pkg.plrs.im/maven/<owner>/`        | Gradle, Maven                              |
| OCI       | `https://pkg.plrs.im/v2/<owner>/…`          | docker, podman, crane                      |
| Godot     | `https://pkg.plrs.im/godot/<owner>/`        | the Godot editor's asset library, GodotEnv |
| Cargo     | `sparse+https://pkg.plrs.im/cargo/<owner>/` | Cargo                                      |
| Go        | `https://pkg.plrs.im/go/<owner>`            | the go command (a GOPROXY)                 |

`GET /` is a static page naming the host, and `GET /v2/` is OCI's base answer
(`Docker-Distribution-API-Version: registry/2.0`): `200` to a request bearing a valid pull token,
and the standard `401` Bearer challenge naming `/v2/token` to any other once the deployment has its
registry token key set (before that, always `200`). NuGet names are reserved and answer the
not-found.

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
challenge is `WWW-Authenticate: Basic realm="pkg.plrs.im"` for npm, PyPI, Maven, Swift, Godot and Cargo,
and OCI's `Bearer realm="https://pkg.plrs.im/v2/token",service=…,scope=…`. Device tokens
(`pkeyt_…`) and licence keys (`pkey_…`) are never registry credentials.

Each client sends the token its own way: Bearer for npm, pnpm, Yarn, Bun and SwiftPM (after
`swift package-registry login`); Basic `__token__:<token>` for pip, uv, Poetry, Gradle and Maven;
OCI clients run `docker login pkg.plrs.im -u __token__` and trade it at `/v2/token` for a
five-minute pull token. Cargo sends the bare token (`Authorization: <token>`, from
`cargo login --registry <owner>` or `CARGO_REGISTRIES_<OWNER>_TOKEN`) once the feed's
`config.json` says `auth-required`. The Godot editor sends no credentials, so a **Godot editor URL** token
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

pnpm 11 and recent Yarn releases refuse versions younger than one day by default
(`minimumReleaseAge`, `npmMinimalAgeGate`), reading each version's publication time from the
packument; a version just published installs once that window has passed, or at once for a scope
the client exempts. [Age gates](/docs/build/install-from-feeds/#age-gates) has each client's
setting and exemption.

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

## Cargo

The Cargo feed is a read-only sparse index (Cargo 1.68 and later; 1.74 and later for a non-public
feed). Name it as a registry and take a crate from it per dependency:

```toml
# .cargo/config.toml
[registries.<owner>]
index = "sparse+https://pkg.plrs.im/cargo/<owner>/"

# Cargo.toml
[dependencies]
acme-sdk = { version = "1", registry = "<owner>" }
```

Cargo takes a crate from the feed only for a dependency that names it with `registry =`, so there
is no namespace to set: every crate sits in the owner's own index.

- **Publishing** is `pkey release publish` with a `kind: package`, `ecosystem: cargo` deliverable
  whose artifact is the `.crate` that `cargo package` writes. `config.json` has no `api`, so
  `cargo publish` refuses the registry. The CLI reads the crate's normalised `Cargo.toml` for the
  index (dependencies of every kind and target, features, `links`, `rust-version`); the Worker never
  unpacks a crate. A dependency on another registry must come from `cargo package`'s output, which
  writes that registry's index URL; a dependency on this same feed resolves here.
- **The index.** `config.json` names the download template,
  `…/files/{sha256-checksum}/{crate}-{version}.crate`, so every crate URL is content-addressed.
  Each crate's index file (`1/`, `2/`, `3/<c>/` or `<ab>/<cd>/` and the lower-case name) has one
  JSON line per version, and Cargo checks every download against its `cksum`.
- **Yank and channels.** A **yanked** version keeps its line marked `yanked`: an existing
  `Cargo.lock` still builds, and a new resolution skips it. Cargo has no deprecation, so a
  **deprecated** version is listed as live, and no channel tags: a pre-release is chosen by its
  semver version (`=1.2.0-beta.1`). Versions are semver.
- **Private feeds.** A non-public feed answers `config.json` `401` without a token; Cargo retries
  with its registry token, and the answer says `auth-required: true`, so Cargo then sends the token
  on every request. Cargo needs a credential provider named for such a registry:
  `credential-provider = "cargo:token"` beside its `index`. A crate whose own delivery access is stricter than its feed's is refused to a
  client the feed admits without a token, which Cargo reports as an error rather than a missing
  crate: keep such crates on a non-public feed.

## Go

The Go feed is a module proxy (the
[GOPROXY protocol](https://go.dev/ref/mod#goproxy-protocol)) at `https://pkg.plrs.im/go/<owner>`.
A package's name is its module path (`go.acme.dev/sdk`, `go.acme.dev/sdk/v2`), and the feed's
namespace is a list of **module prefixes**: every published path must equal one or sit under it.

```sh
go env -w GOPROXY=https://pkg.plrs.im/go/<owner>,https://proxy.golang.org,direct
go env -w GONOSUMDB=<module prefix>[,<module prefix>…]
go get go.acme.dev/sdk@latest
```

- **GONOSUMDB, never GOPRIVATE.** The public checksum database cannot see your modules, so
  GONOSUMDB keeps their lookups away from it; go.sum still pins every hash. GOPRIVATE would do
  that too, but it also sets GONOPROXY, so the go command would skip every proxy, this feed
  included, and go to the module path's host directly.
- **Routing.** The feed answers only for modules it holds and 404s everything else (another
  module, and the parent paths the go command probes when it looks for a package's module), so
  the go command moves on to the public proxy for every other dependency.
- **Versions.** A release version is semver without Go's `v`, which the feed adds: release
  `1.4.0` is module version `v1.4.0`. A v2+ module's path ends in `/v<major>`, and publishing
  refuses a version whose major does not match. Build metadata is refused.
- **Documents.** `@v/list` (every version that is not yanked), `@latest` (the `stable` channel's
  head), `@v/<version>.info`, and the version's `.mod` and `.zip`, which are its own bytes,
  immutable and served by digest. Module paths and versions are case-encoded as the go command
  sends them (`!a` for `A`).
- **Channels** are queries: `go get go.acme.dev/sdk@beta` asks for `@v/beta.info`, and the feed
  answers with the version the `beta` channel serves.
- **A yanked version** leaves `@v/list`, `@latest` and every channel, so no query (`@latest`,
  `@v1`, `@v1.2`) resolves to it. Its `.info`, `.mod` and `.zip` stay, so a go.mod and go.sum
  that pin it keep building. Go has no deprecation a proxy can carry (it reads `// Deprecated:`
  from the module's own go.mod), so the console offers none.
- **Credentials.** A feed that is not public answers `401` with `WWW-Authenticate: Basic`. The go
  command answers from a `.netrc` entry for `pkg.plrs.im` (login `__token__`, password the
  registry token), over https only.
- **Zero-config use** (no GOPROXY setting at all) would need a `go-import` `<meta>` tag on the
  module path's own host. The registry host never serves one: it answers only under `/go/`.

**Publishing.** `pkey release publish --deliverable <id> --version <semver>` reads either a module
zip (built by `golang.org/x/mod/zip` or another tool; every entry under `<module>@v<version>/`) or,
when the artifacts glob matches a `go.mod`, the module's source tree, which the CLI zips by Go's
own rules (no VCS directories, nested modules or vendored packages). It splits out the go.mod the
`.mod` answer serves and records both go.sum hashes (`h1:`), so the console can show the lines a
go.sum must hold:

```yaml
deliverables:
  go.sdk:
    kind: package
    ecosystem: go
    name: go.acme.dev/sdk
    artifacts:
      module: { match: "go.mod" }
```

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

## Package feeds

A **package feed** serves one product's packages to one package manager from the registry host,
`pkg.plrs.im` (see [Package feeds](/docs/services/distribution/package-feeds/) for the host, the
URL layout and who may read). The console manages the feeds in two places, with the same pages:

- **Platform → Package feeds** (`#/platform/feeds`): the platform's own packages, the SDKs and
  tools Polaris Key ships. They belong to the system product, `polaris-key`, which stays out of
  the product switcher and the Products registry. This scope also holds the **platform policy**:
  each ecosystem's kill switch and size ceiling, above every product's own settings.
- **Distribution → Package feeds** (`#/p/<slug>/distribution/feeds`): one product's feeds. The
  sidebar lists it while the product's package feeds are on (**Core → Services → Package feeds**);
  with them off the page says where to turn them on. It is named "Package feeds" so it does not
  collide with **Outlets & feeds**, which covers storefront feeds.

Both scopes are for platform admins only, like the rest of the console.

## The overview

One row per ecosystem: npm, PyPI, Docker / OCI, Swift, Maven / Gradle, Godot and Cargo. Each row shows
the feed's status, its packages and versions, the last publish, its access mode and its registry
URL with a copy button. The summary strip counts the feeds enabled, the packages, the versions and
the last publish.

A feed's status is one of:

- **Enabled**: the feed answers.
- **Off**: it answers not-found, with the reason under the pill — the product's Distribution or
  package feeds are off, the feed has no settings yet, or the feed is switched off.
- **Not available**: the platform policy has switched the ecosystem off for every product.

In platform scope, **Owners** lists every product whose package feeds have been switched, the
system product first. Before the platform's feeds are set up, the page offers **Set up platform
feeds**, which creates the system product and one feed per ecosystem with the platform's
namespaces (`POST /manage/api/platform/feeds/bootstrap`). Running it again changes nothing an
operator has set since.

The bar of links above each page title (Overview, a separator, one link per ecosystem, each with
its icon, then a separator and Tokens) moves between the overview, the feed pages and the registry
tokens: each is a page of its own. The current page is filled, bold and underlined on the bar's
rule.

## A feed

Each feed page has four tabs, each a URL (`…/feeds/npm/settings`), and **Rebuild feed** under
More actions, which queues a fresh render of the feed's index documents.

- **Packages**: every package of the feed with its latest live version, its tags (npm dist-tags,
  OCI moving tags: the `stable` channel is `latest`, every other channel a tag of its own name),
  its live and total versions and its last publish. In platform scope the list opens on the
  platform's packages; **All owners** lists every product's, with an Owner column.
- **Setup**: what a client needs, copy-paste ready, for the feed's own URL and namespace: the
  `.npmrc`, `.yarnrc.yml` and `bunfig.toml` scope lines; a uv explicit index, a Poetry explicit
  source and a pip command (with the warning never to use `--extra-index-url`); SwiftPM's whole
  `registries.json` (the scope's registry and the signing policy); a Gradle `exclusiveContent`
  block and a Maven `<repository>`; `docker pull` by the fully qualified reference; the Godot
  editor's URLs per editor version and the GodotEnv index; or Cargo's `[registries]` entry and a
  dependency with `registry =`. Every snippet routes only the feed's
  own names to it. The same snippets come from `pkey feeds setup` (below), byte for byte. When the feed is not
  public, the setup is the authenticated one, naming the token as `PKEY_REGISTRY_TOKEN`.
- **Settings**: see below.
- **Activity**: the feed's audit trail: settings changes, rebuilds and its versions' yanks and
  deprecations (and, in platform scope, the policy changes).

### Settings

Every section saves on its own, through its own Save bar, with the version of the settings it
read. If someone saved in between, the save is refused (409) and the page shows the current
settings; nothing is overwritten. A feed with no settings yet gets them on its first save.

| Section                 | What it sets                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General                 | Whether the feed answers. Switching it off asks first: every client then gets not-found within 30 seconds.                                                                                                                                                                                                                                           |
| Access                  | Who may install: Public, Customers or Entitled (see [Access](#access)). Leaving Public asks first. Entitled lists the feed's packages that have no delivery gate.                                                                                                                                                                                    |
| Namespace               | The names the feed may hold, one row per namespace field the ecosystem's ingest rules declare: an npm or Swift scope, PyPI names and prefixes, Maven group prefixes, a Godot publisher, Go module prefixes. OCI repositories and Cargo crates always sit under the owner. A feed cannot be enabled without a namespace.                              |
| Limits                  | The largest package ingest accepts, at most the platform's ceiling for the ecosystem.                                                                                                                                                                                                                                                                |
| Yank policy             | What a yank does to clients in this protocol. Maven only: **Hide yanked versions**, which leaves a yanked version out of `maven-metadata.xml`.                                                                                                                                                                                                       |
| Simple API              | PyPI only: **HTML pages**, whether a client that cannot take PEP 691 JSON gets the inert PEP 503 HTML page (on) or 406 (off).                                                                                                                                                                                                                        |
| Signing and identifiers | Swift only: **Require signed releases** (ingest refuses an unsigned release; always on for the platform's own packages) and **Repository URLs**, one `identity url` per line, which `GET /identifiers?url=` answers from.                                                                                                                            |
| Retention               | OCI only: **Untagged manifests**, the days an image manifest no tag points at may be kept. It is stored only: nothing removes untagged manifests yet, so every one is kept whatever it holds. A published version is never removed, except by feed retention's prune of builds of main (see [Retention: builds of main](#retention-builds-of-main)). |
| Asset listing           | Godot only: the asset library category, support level, license and oldest editor every addon of the feed is listed with.                                                                                                                                                                                                                             |
| Platform policy         | Platform scope only: whether the ecosystem is served at all, and its size ceiling, for every product. Switching an ecosystem off is a danger confirmation.                                                                                                                                                                                           |

A feed never proxies or mirrors another registry, so a name it does not hold answers not-found
and a public package can never stand in for one of yours.

### Access

The stricter of the feed's mode and each package's own delivery access applies.

| Mode      | Who may install                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public    | Anyone, with no credentials. No token is ever looked up.                                                                                             |
| Customers | A client presenting a registry token of this product: an owner-bound or CI token passes, and a licence-bound token must belong to an active licence. |
| Entitled  | Owner-bound and CI tokens pass; a licence-bound token also needs the package's delivery gate flag. A package with no gate admits no licence token.   |

Customers is stored as `authenticated` or `licensed` (the console's former Token and Licensed).
They are one strictness, as for byte delivery, and stricter than the portal download's meaning of
"authenticated". The console keeps whichever a feed already has; a feed newly opened to customers
stores `licensed`. A package stricter than its feed is left out of list
documents, so a licence holder finds it in Godot search or the PyPI project list only by its exact
name.

Leaving Public is a caution confirmation: clients without a token get the registry's native 401
within 30 seconds and need the authenticated setup. The platform's own feeds stay public and can
be changed only from the platform scope.

## Registry tokens

**Tokens** (`#/p/<slug>/distribution/feeds/tokens`, `#/platform/feeds/tokens` for the platform's
feeds) lists the owner's registry tokens (`pkeyr_…`): label, id, the last four characters, the
feeds it reaches, what it is bound to, who created it (an operator, or a licensee in the portal),
when it expires and when it was last used, and its status.

**New token** asks for a label, the feeds (every feed, or some), the expiry (1 to 365 days, 90 by
default), the binding (this product, or one licence) and **Godot editor URL**. A Godot editor URL
token is read-only, reaches only the Godot feed, lasts 30 days by default and travels in the
editor's URL, because the editor sends no credentials. The token is shown once, with every
enabled feed's setup already holding it; Polaris Key stores only its hash.

**Access** chooses **Read** or **Read and publish**. A publish token lets a native client publish
to the feeds it names (npm, PyPI, Swift and Maven; see
[Publishing with native clients](/docs/services/distribution/package-feeds/#publishing-with-native-clients)),
and `docker push` to the owner's OCI repositories when it names the OCI feed (a pushed version tag
publishes a release; see
[Pushing with docker push](/docs/services/distribution/package-feeds/#oci-images)):
it is always bound to this product, never a Godot editor URL, names its feeds explicitly, and
lasts 1 to 30 days (7 by default). It is meant for an operator's own machine; in CI, publish with
the job's OIDC token (`pkey auth github-oidc`) so the repository holds no publish secret. The
token list shows "read and publish" beside such a token's id, and a version it published names
the token and the client on the package record.

Revoking a token is a danger confirmation and takes effect within 30 seconds. **Revoke all** (under
More actions) revokes every active token of the owner, including those licensees minted.

A licence's **Keys** tab has a **Registry tokens** panel with the tokens bound to that licence,
whoever minted them, and the same New token and Revoke all, for that licence only.

A licensee can mint their own read tokens in the portal whenever the product has an enabled feed
that is not public; see [Package access](/docs/users/portal/#package-access).

Tokens are bound to one owner, and docker, SwiftPM and netrc keep one credential per registry host,
so one machine can hold a token for only one product on the registry host for those clients. npm,
uv, Gradle and Maven keep credentials per URL or repository.

## The package record

A package's page has three tabs: **Versions**, **Setup** (the feed's setup for this package and its
latest version) and **History** (the package's own audit rows).

Each version shows its tags, when it was published and how — a trusted-publisher run with a link to
the run, a static CI token by id, a registry token by id, or the console, each marked "docker
push" when it came through a native push — its size, each file's digests (SHA-256, and the
SHA-512, SHA-1 and MD5 the Worker computes for npm and Maven) with a copy button each, and its
state: **Live**, **Yanked** or **Deprecated**, with the reason or message.

The row actions follow the protocol, and only what the protocol has a state for is offered:

| Ecosystem | Yank                                                                      | Deprecate                                                     |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| npm       | No: npm has no yank that keeps lockfiles working                          | Yes: the version stays installable and npm prints the message |
| PyPI      | Yes (PEP 592): pinned installs work, resolvers skip it                    | No                                                            |
| Swift     | Yes: leaves the release list, stays fetchable                             | No                                                            |
| Maven     | Yes: marked yanked; hidden from `maven-metadata.xml` with the yank policy | No                                                            |
| OCI       | Yes: the version tag is removed, the digest stays pullable                | No                                                            |
| Godot     | Yes: leaves the asset listings                                            | No                                                            |

A yank needs a reason and is a danger confirmation; unyank, deprecate (with a message) and lifting a
deprecation are caution confirmations. There is no delete action. A version number is unique
forever, so a yanked version can never be published again.

### Retention: builds of main

Feed retention is the one thing that deletes versions. When a version is published on `stable`,
the package's builds of main below it are pruned: `X-main.N`, or Python's `X.devN`, for every X
at or below the released version. Stable and beta versions stay, and so do builds of a newer
version and any version a channel points at. Each pruned version is audited as
`package.version.prune` with its size, and it leaves a tombstone, so the number is still never
published again. The bytes are reclaimed by the blob collector once no remaining version,
package or product references them. It is off by default for a product, which opts in through
`PUT …/retention` (`release.packages.prunePrereleases`). The platform's own feeds always prune
and cannot turn it off. A yanked or deprecated stable release never sets the ceiling.
`POST …/prune` is the backfill for versions released before this existed, or before the product
opted in. It runs as a dry run unless `apply` is true, and so does `pkey feeds prune`. A version
a channel or another row took hold of between the plan and the deletion is kept and listed as
skipped.

## Setup from the CLI

`pkey feeds setup` prints a feed's setup without the console, offline, from the same function the
Setup tabs use (`renderFeedSetup` in `@polaris-key/manifest`), so the two agree byte for byte:

```sh
pkey feeds setup --ecosystem npm --owner acme --namespace scope=@acme
pkey feeds setup --ecosystem maven --owner acme --namespace groupPrefixes=gg.acme,gg.acme.tools \
  --package gg.acme:sdk --version 1.2.0
pkey feeds setup --ecosystem pypi --owner acme --package acme-sdk --token-env PKEY_REGISTRY_TOKEN
```

`--namespace` takes the ecosystem's namespace fields (`scope`, `names`, `prefixes`,
`groupPrefixes`, `publisher`; a list takes commas). `--origin` points at another registry host
(default `https://pkg.plrs.im`). `--token-env NAME` adds each client's credential lines, reading
the registry token from that environment variable; the token itself is never an argument.
Mint the token on the Tokens page ([Registry tokens](#registry-tokens)). Godot takes no
`--token-env`: the editor and GodotEnv authenticate by a token in the feed's URL, which a
**Godot editor URL** token's shown-once dialog gives.
`--json` prints the snippets as JSON.

## The admin API

The same handler set serves both scopes. It is narrative-only (not in the OpenAPI spec), like the
rest of the console's API.

| Method | Platform (`/manage/api/platform/feeds`)                    | Product (`/manage/api/products/<slug>/distribution/feeds`) | Audit action                             |
| ------ | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| GET    | the base path: every feed, the owners                      | the base path                                              | —                                        |
| GET    | `/<eco>`: settings, policy, capabilities                   | `/<eco>`                                                   | —                                        |
| PUT    | `/<eco>/settings` (the system product's feed)              | `/<eco>/settings`                                          | `feed.settings.update`                   |
| PUT    | `/<eco>/policy`                                            | —                                                          | `feed.policy.update` (platform activity) |
| GET    | `/<eco>/packages?q=&owner=&cursor=`                        | `/<eco>/packages?q=&cursor=`                               | —                                        |
| GET    | `/<eco>/packages/<owner>/<name>`                           | `/<eco>/packages/<name>`                                   | —                                        |
| POST   | `…/versions/<version>/{yank,unyank,deprecate,undeprecate}` | the same                                                   | `package.version.*`                      |
| POST   | `/<eco>/rebuild`                                           | `/<eco>/rebuild`                                           | `feed.rebuild`                           |
| GET    | `/<eco>/activity`                                          | `/<eco>/activity`                                          | —                                        |
| GET    | `/retention`: the owner's retention setting                | `/retention`                                               | —                                        |
| PUT    | `/retention` (refused: the system product is locked on)    | `/retention` (`{expectedVersion, prunePrereleases}`)       | `feed.retention.update`                  |
| POST   | `/prune` (`{apply?, deliverable?}`, a dry run by default)  | `/prune`                                                   | `package.version.prune` (each version)   |
| POST   | `/bootstrap`                                               | —                                                          | `feed.bootstrap` (platform activity)     |
| GET    | `/tokens[?license=<id>]`                                   | the same                                                   | —                                        |
| POST   | `/tokens`                                                  | the same                                                   | `registry_token.create`                  |
| POST   | `/tokens/<tokenId>/revoke`                                 | the same                                                   | `registry_token.revoke`                  |
| POST   | `/tokens/revoke-all` (`{licenseId?}`)                      | the same                                                   | `registry_token.revoke_all`              |

The settings and policy writes take `expectedVersion` (0 for a feed with no settings yet) and
answer 409 with `reason: "version_conflict"` and the current state when it is stale. A version verb
the protocol has no state for answers 422 with `reason: "unsupported_by_ecosystem"`; an unknown
access mode answers 422 with `reason: "access_mode_unavailable"`. A token mint takes `label`,
`ecosystems` (`null` for every feed), `expiresInDays`, `binding` (`owner` or `license`, with
`licenseId`) and `presentation` (`header`, or `url` for a Godot editor URL token), and answers the
plaintext once. Product-scoped writes are audited under the owning product (the system product for
the platform's feeds); the policy, the bootstrap and platform-scope token actions go to the
platform activity.

The product's own switch is `GET`/`PUT /manage/api/products/<slug>/distribution/package-feeds`
(`{enabled, expectedVersion}`, audited `distribution.package_feeds.update`), the **Package feeds**
section of [Services](/docs/admin/services-enablement/).
