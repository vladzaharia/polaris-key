---
title: "Installing the SDKs from the feeds"
description: "Where every Polaris Key SDK is published — the package feeds on pkg.plrs.im for npm, PyPI, SwiftPM, Maven and Gradle, OCI and Godot — and the snippet each client needs to install it."
sidebar:
  order: 4.5
---

Every SDK this project ships is published to Polaris Key's own package feeds on
**`pkg.plrs.im`**, under the platform's product, `polaris-key`, and nowhere else. They are not on
npmjs, PyPI, Maven Central, the Swift Package Index, Docker Hub or the Godot Asset Library. Each
snippet below sends only the platform's names to the feed, so no other dependency is looked up
there, and no platform name can resolve from anywhere else. That second half guards against
dependency confusion: an attacker's package with the same name on a public registry never wins.

| SDK                                          | Ecosystem | Name on the feed               | Feed                                           |
| -------------------------------------------- | --------- | ------------------------------ | ---------------------------------------------- |
| Node, React, client-core, the CLI and others | npm       | `@polaris-key/*`               | `https://pkg.plrs.im/npm/polaris-key/`         |
| Python                                       | PyPI      | `polaris-key`                  | `https://pkg.plrs.im/pypi/polaris-key/simple/` |
| Swift                                        | SwiftPM   | `polaris-key.PolarisKey`       | `https://pkg.plrs.im/swift/polaris-key`        |
| Kotlin and the Godot Android binding         | Maven     | `im.plrs.key:polaris-key-*`    | `https://pkg.plrs.im/maven/polaris-key/`       |
| Godot addon                                  | Godot     | `polaris_key`                  | `https://pkg.plrs.im/godot/polaris-key/`       |
| The `pkey` CLI as an image                   | OCI       | `pkg.plrs.im/polaris-key/pkey` | `https://pkg.plrs.im/v2/`                      |

The platform's feeds are public: no account and no token. A product's own feeds can be private;
[Private feeds](#private-feeds) below has the authenticated setup for every client. How each feed
behaves (tags, yanks, caching) is on [Package feeds](/docs/services/distribution/package-feeds/).

**Versions.** Every SDK carries the server's version, in lockstep: a `v0.9.0` release of Polaris Key
publishes every SDK at `0.9.0`. Each push to the monorepo's `main` also publishes a pre-release of
the next version on the `main` channel: `0.9.1-main.<N>` (`0.9.1.dev<N>` for Python), `N` growing
with every push. A pre-release, from `main` or a `v1.0.0-rc.1`-style tag (on the `beta` channel),
is never npm's `latest`, Maven's `RELEASE` or the image's `latest`; each client picks one only when
asked for it by version, by tag (`npm install @polaris-key/node@main`, `pkey:main`) or with its
pre-release flag.

**Earlier releases.** Versions published before the feeds existed stay where they are: the
`@polaris-key/*` packages on GitHub Packages and `polaris-key` on PyPI. New versions are
published to the feeds only.

## npm, pnpm, Yarn and Bun

Route the `@polaris-key` scope to the feed:

```ini
# .npmrc (npm, pnpm)
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```yaml
# .yarnrc.yml (Yarn Berry)
npmScopes:
  polaris-key:
    npmRegistryServer: "https://pkg.plrs.im/npm/polaris-key/"
```

```toml
# bunfig.toml (Bun)
[install.scopes]
"@polaris-key" = "https://pkg.plrs.im/npm/polaris-key/"
```

Then install as usual:

```sh
npm install @polaris-key/node          # or @polaris-key/react, @polaris-key/client-core, …
pnpm add -D @polaris-key/cli
npm install @polaris-key/node@beta     # the newest pre-release
```

The feed carries `@polaris-key/node`, `react`, `client-core`, `cli`, `manifest`, `jws`,
`protocol`, `catalog`, `brand` and `zstd-wasm`. Each package's dependencies on the others resolve
through the same scope line. Recent Yarn releases hold back versions younger than their
`npmMinimalAgeGate`. A version published a moment ago installs with Yarn once that window has
passed, or at once with `npmMinimalAgeGate: 0`.

## Python: pip, uv and Poetry

The index serves `polaris-key` only. Name it as an explicit index for that one project, never as
an extra index:

```toml
# pyproject.toml (uv)
[[tool.uv.index]]
name = "polaris-key"
url = "https://pkg.plrs.im/pypi/polaris-key/simple/"
explicit = true

[tool.uv.sources]
polaris-key = { index = "polaris-key" }
```

```toml
# pyproject.toml (Poetry 2)
[[tool.poetry.source]]
name = "polaris-key"
url = "https://pkg.plrs.im/pypi/polaris-key/simple/"
priority = "explicit"

[tool.poetry.dependencies]
polaris-key = { version = "^0.1", source = "polaris-key" }
```

pip cannot route one project to one index, so install in two steps: the dependencies from your
usual index, then `polaris-key` alone from the feed:

```sh
pip install "cryptography>=41" "httpx>=0.24" "zstandard>=0.22; python_version < '3.14'"
pip install --no-deps --index-url https://pkg.plrs.im/pypi/polaris-key/simple/ polaris-key
```

Never use `--extra-index-url` for the feed. pip has no per-project routing: with two indexes it
takes the highest version from either, so a public package named `polaris-key` could win. The
feed answers PEP 691 JSON, which pip 22.2 and later ask for. Older pip asks only for HTML, which
the feed also serves.

## Swift (SwiftPM)

Register the `polaris-key` scope once per project, or per machine with `--global`:

```sh
swift package-registry set --scope polaris-key https://pkg.plrs.im/swift/polaris-key
```

Then depend on the package by its registry identity:

```swift
// Package.swift
dependencies: [
    .package(id: "polaris-key.PolarisKey", from: "0.1.0"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "PolarisKey", package: "polaris-key.PolarisKey"),
    ]),
]
```

Releases are signed with SwiftPM's `cms-1.0.0` format, and the feed refuses an unsigned one. To
make SwiftPM refuse an unsigned or untrusted release as well, set the security policy in
`.swiftpm/configuration/registries.json`:

```json
{
  "security": {
    "default": {
      "signing": { "onUnsigned": "error", "onUntrustedCertificate": "error" }
    }
  }
}
```

The registry archive has `Package.swift` at its root, so Xcode and SwiftPM resolve it like any
package. The registry is the one supported path: the monorepo publishes no per-SDK git tags, and
SwiftPM's git-URL path cannot resolve a package in a subdirectory anyway.

## Kotlin and Android: Gradle and Maven

Send the `im.plrs.key` group to the feed alone:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository {
                maven { url = uri("https://pkg.plrs.im/maven/polaris-key/") }
            }
            filter { includeGroupAndSubgroups("im.plrs.key") }
        }
        google()
        mavenCentral()
    }
}
```

```kotlin
// build.gradle.kts
dependencies {
    implementation("im.plrs.key:polaris-key-sdk:0.1.0")             // the umbrella client
    implementation("im.plrs.key:polaris-key-platform-play:0.1.0")   // Android, a Play build
    // or im.plrs.key:polaris-key-platform-direct for a sideloaded / direct build
}
```

| Coordinate                                                   | What                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `polaris-key-sdk`                                            | the umbrella `PolarisKeyClient` (JVM library); pulls in the modules below                                              |
| `polaris-key-core`                                           | verification, trust, the verified cache and transport                                                                  |
| `polaris-key-{license,config,identity,release,update,packs}` | one service module each; each depends on `polaris-key-core` only                                                       |
| `polaris-key-platform-play`, `polaris-key-platform-direct`   | the Android platform AAR, one per flavour: Play In-App Updates and Asset Delivery, or the PackageInstaller self-update |
| `polaris-key-godot-play`, `polaris-key-godot-direct`         | the Godot Android plugin binding over the platform AAR of the same flavour                                             |

Pick one platform flavour per build: the two are a policy boundary, because Play forbids
self-update. Maven builds use a repository with a fatal checksum policy:

```xml
<repositories>
  <repository>
    <id>polaris-key</id>
    <url>https://pkg.plrs.im/maven/polaris-key/</url>
    <releases><checksumPolicy>fail</checksumPolicy></releases>
    <snapshots><enabled>false</enabled></snapshots>
  </repository>
</repositories>
```

## Godot addon

Add the feed to the editor's asset library, with no trailing slash:

| Editor              | Editor Settings                | Value                                                     |
| ------------------- | ------------------------------ | --------------------------------------------------------- |
| Godot 4.4 to 4.6    | Asset Library → Available URLs | `https://pkg.plrs.im/godot/polaris-key/asset-library/api` |
| Godot 4.7 and later | `asset_store/available_urls`   | `https://pkg.plrs.im/godot/polaris-key/store/api/v1`      |

Search for "Polaris Key" in the AssetLib tab and install it. The addon lands at
`res://addons/polaris_key/`; enable it under **Project → Project Settings → Plugins**. Godot 4.6
and earlier check the download against its SHA-256. Godot 4.7 and later check no hash and rely on
TLS alone.

For scripted installs, GodotEnv takes the entry the feed's index publishes for each version
(`https://pkg.plrs.im/godot/polaris-key/index.json`):

```json
{
  "addons": {
    "polaris_key": {
      "url": "https://pkg.plrs.im/godot/polaris-key/files/<sha256>/polaris-key-godot-v0.1.0.zip",
      "source": "zip",
      "subfolder": "addons/polaris_key"
    }
  }
}
```

## The `pkey` image

`pkey` is also an image for `linux/amd64` and `linux/arm64`: Node 22 and the standalone CLI.
Mount the project at `/work`:

```sh
docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:latest validate
podman pull pkg.plrs.im/polaris-key/pkey:0.1.0
```

`latest` is the newest stable release, `beta` the newest tagged pre-release, `main` the newest
build of `main`, and each version is a tag that never moves.

## Private feeds

A product can make its feeds require a **registry token** (`pkeyr_…`). An operator mints one under
**Distribution → Package feeds → Tokens**; a licensee mints their own under **Package access** in
the portal. Keep it in an environment variable, `PKEY_REGISTRY_TOKEN` below, or a secret store.
The examples use the owner `acme` and its scope `@acme`.

**npm and pnpm** (`.npmrc`):

```ini
@acme:registry=https://pkg.plrs.im/npm/acme/
//pkg.plrs.im/npm/acme/:_authToken=${PKEY_REGISTRY_TOKEN}
```

**Yarn Berry** (`.yarnrc.yml`) and **Bun** (`bunfig.toml`):

```yaml
npmScopes:
  acme:
    npmRegistryServer: "https://pkg.plrs.im/npm/acme/"
    npmAuthToken: "${PKEY_REGISTRY_TOKEN}"
    npmAlwaysAuth: true
```

```toml
[install.scopes]
acme = { url = "https://pkg.plrs.im/npm/acme/", token = "$PKEY_REGISTRY_TOKEN" }
```

**uv** (`pyproject.toml`, then the credentials in the environment), **Poetry** and **pip**:

```toml
[[tool.uv.index]]
name = "acme"
url = "https://pkg.plrs.im/pypi/acme/simple/"
explicit = true
authenticate = "always"
```

```sh
export UV_INDEX_ACME_USERNAME=__token__
export UV_INDEX_ACME_PASSWORD="$PKEY_REGISTRY_TOKEN"
poetry config http-basic.acme __token__ "$PKEY_REGISTRY_TOKEN"
pip install --index-url "https://__token__:${PKEY_REGISTRY_TOKEN}@pkg.plrs.im/pypi/acme/simple/" acme-sdk
```

pip also reads `~/.netrc` (`machine pkg.plrs.im login __token__ password <token>`).

**SwiftPM**: log in once; SwiftPM keeps the token in the keychain (`~/.netrc` on Linux).

```sh
swift package-registry set --scope acme https://pkg.plrs.im/swift/acme
swift package-registry login https://pkg.plrs.im/swift/acme --token "$PKEY_REGISTRY_TOKEN" --no-confirm
```

**Gradle** (`settings.gradle.kts`, with `acmeUsername=__token__` and `acmePassword=<token>` in
`~/.gradle/gradle.properties`) and **Maven** (`~/.m2/settings.xml`, the `<server>` id matching the
`<repository>` id):

```kotlin
maven {
  name = "acme"
  url = uri("https://pkg.plrs.im/maven/acme/")
  credentials(PasswordCredentials::class)
}
```

```xml
<server>
  <id>acme</id>
  <username>__token__</username>
  <password>${env.PKEY_REGISTRY_TOKEN}</password>
</server>
```

**docker, podman, crane and oras**:

```sh
echo "$PKEY_REGISTRY_TOKEN" | docker login pkg.plrs.im -u __token__ --password-stdin
```

**Godot**: the editor sends no credentials, so mint a token with **Godot editor URL** on (read-only,
Godot only, 30 days by default) and put it in the editor's URL, `https://pkg.plrs.im/godot/acme/t/<token>/asset-library/api`
(4.6 and earlier) or `…/t/<token>/store/api/v1` (4.7 and later). GodotEnv takes the same
tokenised URL.

docker, SwiftPM and netrc hold **one credential per registry host**: one machine can hold a token
for only one product on `pkg.plrs.im` for them. npm, uv, Gradle and Maven keep credentials per URL
or repository, so they have no such limit. The platform's own feeds stay public and never take the
slot.

## How the SDKs get there

Nobody publishes by hand, and nobody picks a version. `.github/workflows/publish-sdks.yml` runs on
every push to `main` and, through the production deploy, on every `v*` tag: it derives the version
from git, stamps it into every SDK, builds and tests each one, and publishes each package with
`pkey release publish` through one reusable workflow, `publish-package.yml`. That workflow is the
`polaris-key` product's trusted publisher (see [Publishing from CI](/docs/build/ci/)), so the
repository holds no publishing token. A last job reads every feed back and fails unless each
package shows the version just published. The whole flow is on
[Releasing](/docs/contribute/releasing/).

| Trigger          | Every SDK is published at                  | Channel                                   |
| ---------------- | ------------------------------------------ | ----------------------------------------- |
| a push to `main` | `<next>-main.<N>` (Python `<next>.dev<N>`) | `main`                                    |
| a `v*` tag       | the tag's version (`v0.9.0` → `0.9.0`)     | `stable`, or `beta` for a pre-release tag |
