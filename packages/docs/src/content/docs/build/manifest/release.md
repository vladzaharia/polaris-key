---
title: "Write the release manifest"
description: "Declare the app deliverable, builds, packs, packages, trusted publishing and release keys in .pkey/release."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 4
---

`.pkey/release` tells Polaris Key what a release contains and who may publish it. It is required when Release is on. Every rule has a code on [Manifest validation codes](/docs/reference/validation-codes/).

## Release deliverables: `deliverables.app` and the artifact map

A `.pkey/release` document may declare the product's **app deliverable** and an **artifact
map** that says what every file of a release is. Without the block the product keeps the
implicit `app` deliverable and its release files are classified by filename, as before (a
`.dmg` is macOS, `-arm64` is arm64, and an `.apk`, `.ipa`, `.exe` or `.pck` is `other`;
a platform-only extension or name token still names the platform, so `.app.zip` is macOS,
`.apk` Android, `.ipa` iOS and `-win64` Windows).
With it, files are classified **by declaration, not by sniffing**:

```yaml title=".pkey/release"
# .pkey/release.yaml
release:
  provider: { type: github, owner: vladzaharia, repo: diceroll }
  deliverables:
    app:
      kind: app
      versioning:
        scheme: semver # or semver+build, 4part
        stableTagPattern: "v\\d+\\.\\d+\\.\\d+"
        ignoreTags: [channels, packs]
        buildNumber: descriptor # or none
      channels:
        beta: { includes: [stable] } # beta also offers every stable release
      artifacts:
        - {
            id: macos,
            platform: macos,
            arch: universal,
            format: dmg,
            match: "Diceroll-*-macos.dmg",
          }
        - {
            id: win-zip,
            platform: windows,
            arch: x86_64,
            format: zip,
            match: "Diceroll-*-windows-x86_64.zip",
          }
        - {
            id: apk,
            platform: android,
            arch: any,
            format: apk,
            match: "Diceroll-*-android.apk",
          }
        - {
            id: web,
            platform: web,
            arch: wasm32,
            format: zip,
            match: "Diceroll-*-web.zip",
          }
```

- **`kind`** is required. `app` is the product's application; any other id must be
  `kind: pack`, a content pack (below).
- **`versioning.stableTagPattern`** and **`versioning.ignoreTags`** are the same two fields
  the release root already accepts (same rules, same `release_config` columns). Spell them in
  one place: declaring them both at the root and here is `conflicting_versioning`.
- **`channels`** keys are canonical channel names (lower-case letters, digits, `-`; not the
  aliases `staging` or `latest`). `includes` may name `stable`, `beta`, a manual channel or
  another declared channel, by its canonical name, and may not loop
  (`invalid_channel_includes`). A manual channel whose name is not canonical (`Nightly.2`)
  cannot be included.
- **`artifacts`**: each entry is one **build**. `id` is the build id; `platform` is one of
  `macos`, `ios`, `android`, `windows`, `linux`, `web`; `arch` one of `arm64`, `x86_64`,
  `universal`, `armv7`, `wasm32`, `any`; `format` is the file type. `role` defaults to
  `payload`. Installer versus portable is a **format** (`zip` versus `exe`/`msi`), not a role.
  `match` is an anchored, case-sensitive glob: `*` is any run of characters, `?` exactly one,
  everything else literal, at most 128 characters.
- A file named `<payload>.sig` or `<payload>.sha256` is that build's signature or checksum.
  An entry that matches two files of one release classifies neither (it is ambiguous), and a
  file no entry matches has no build.

- **`embeds`** (optional, on an `artifacts` entry) lists the packs that build ships inside
  it: declared pack ids, at most 64 (`invalid_build_embeds`). Omitted means every
  `baseline: embedded` pack; `[]` means none, as for a lean web build.

## How builds are labelled

Every surface that shows a build or a release file to a person — the console's release
detail, artifact lists and distribution matrix, release health, the customer portal's
downloads, the public download page and `pkey release publish` — names it by **platform and
architecture together**, through one formatter (`buildLabel` in `@polaris-key/manifest`). The
stored and signed values (`platform: macos`, `arch: arm64`) never change; only the text a
person reads does.

| `platform` | `arch`      | Short label            | Long label (tooltips, logs)   |
| ---------- | ----------- | ---------------------- | ----------------------------- |
| `macos`    | `arm64`     | macOS Apple silicon    | macOS · Apple silicon (arm64) |
| `macos`    | `x86_64`    | macOS Intel            | macOS · Intel (x86_64)        |
| `macos`    | `universal` | macOS Universal        | macOS · Universal             |
| `windows`  | `x86_64`    | Windows x64            | Windows · x64 (x86_64)        |
| `windows`  | `arm64`     | Windows Arm64          | Windows · Arm64               |
| `linux`    | `arm64`     | Linux ARM64            | Linux · ARM64                 |
| `android`  | `armv7`     | Android armv7          | Android · armv7               |
| `ios`      | `arm64`     | iOS / iPadOS           | iOS / iPadOS                  |
| `web`      | `wasm32`    | Web                    | Web                           |
| none       | `any`       | All platforms          | All platforms                 |
| none       | `arm64`     | Unknown platform ARM64 | Unknown platform · ARM64      |

- `any` on a named platform reads as **Universal**; an arch the platform implies (every iOS
  build is arm64, every web build WebAssembly) is left out. The download page says "iPhone and
  iPad" for iOS.
- A value the formatter does not know passes through verbatim (`beos · riscv64`).
- A file with no platform of its own takes its **build's** platform; a file tied to no build
  takes the platform its name declares (`djdl-arm64.app.zip` is macOS). Only when nothing
  determines one does a label read "Unknown platform".
- `pkey release publish` prints each matched file with its build's long label:
  `- macos  payload  Diceroll-1.2.0-macos.zip (macOS · Universal · zip; …)`.

**Name builds and files by platform and arch.** A build's id is what the CLI, release health
and the distribution matrix show first, so give it both halves: `macos-arm64`, `win-x64`,
`linux-arm64`, not `arm64`. An id that is an architecture alone is the warning
`bare_arch_artifact_id`. Name the files the same way — `djdl-macos-arm64.app.zip`, not
`djdl-arm64.app.zip` — so a file reads correctly even where it is listed on its own, and a
product without an artifact map still sniffs the right platform.

## Pack deliverables

Any deliverable other than `app` is a content pack (`kind: pack`) or a package (`kind:
package`, [below](#package-deliverables)). A pack is data the app loads at run
time, released on its own versions, and pinned by app releases or resolved per live contentApi
level. See [Packs](/docs/features/ship-builds/packs/) for what Release does with them. The
validator accepts this set of fields, so a manifest never declares behavior that is not
delivered:

```yaml title=".pkey/release"
deliverables:
  app:
    kind: app
    content:
      contentApi: 3 # required once any pack is declared
      packChannels: { "diceroll.events.*": events } # optional: route pack families
      attachable: [res://scripts/die.gd, "uid://c3x1bp7twkd0f"] # optional: app scripts and UIDs packs may reference
    artifacts:
      - {
          id: macos,
          platform: macos,
          arch: universal,
          format: dmg,
          match: "Diceroll-*-macos.dmg",
          embeds: [diceroll.core3d],
        }
  diceroll.core3d:
    kind: pack
    type: godot.pck # or files.tree
    binding: pinned # pinned (the default) | compatible | standalone
    baseline: embedded # store builds ship it; default none
    required: true # a required pack is essential and ungated
    delivery: essential # essential | prefetch | on-demand (default)
    handler: { mountOrder: 2, prefixes: ["res://assets/kaykit/"] }
    variants: { texture: [s3tc, etc2, astc] }
    requires: { engine: godot-4.7 }
    patch: { strategies: [delta, file, chunk], deltaBases: 1 }
  diceroll.supporter.skins:
    kind: pack
    type: godot.pck
    delivery: on-demand
    handler: { prefixes: ["res://skins/"] }
    requires: { engine: godot-4.7 }
    entitlement: extras.diceSkins # an assertion of the operator's gate (below)
  diceroll.foes:
    kind: pack
    type: files.tree
    binding: compatible # the newest release whose contentApi range holds each live level
    requires:
      contentApi: { app: ">=3 <5" } # required for compatible, refused for standalone
      packs: { diceroll.l10n: ">=2.0.0" } # other compatible or standalone packs
    conflicts: [diceroll.supporter.skins]
  diceroll.l10n:
    kind: pack
    type: files.tree
    binding: standalone # every level's newest release; no contentApi
    variants: { locale: [en, fr] }
  diceroll.events.halloween:
    kind: pack
    type: files.tree
    binding: compatible
    channels: [events] # where its releases may be published beyond stable and beta
    requires: { contentApi: { app: ">=3" } }
```

- At most **64** packs (`too_many_pack_deliverables`).
- **`type`** is required (`invalid_pack_type`): `godot.pck`, `godot.zip`, `files.tree`,
  `l10n.table`, `data.json`, `audio.bank`, `ml.model`, or `custom.<name>` for a type whose
  handler the game registers. What each one carries and what devices check is on
  [Packs](/docs/features/ship-builds/packs/#pack-types). A `godot.pck` or `godot.zip` pack declares
  `handler.prefixes` (the `res://` directories it mounts, each ending in `/`), activates on
  `restart`, and declares `requires.engine` (`godot-<major>.<minor>`). Every other type takes no
  `prefixes` or `mountOrder` and activates `hot` by default (`invalid_pack_handler`,
  `invalid_pack_requires`).
- **`formatVersion`** is the version of the type's own format, signed as the record's
  `formatVersion`; a device installs only the versions its handler lists. A `data.json` pack
  declares it (the JSON Schema version of its documents); `l10n.table`, `ml.model`, `audio.bank`
  and `custom.<name>` may (default 1); `godot.pck` (the PCK header's), `godot.zip` and
  `files.tree` never do (`invalid_pack_format_version`).
- An **`l10n.table`** pack's `locale` variants are well-formed BCP-47 tags such as `fr`, `pt-BR`
  or `zh-Hant-TW` (`invalid_pack_locale`): a device refuses a table whose locale is not its
  variant's.
- **`binding`** is `pinned`, `compatible` or `standalone` (`invalid_pack_binding`): `pinned`
  means each app release pins the exact pack release it ships with; `compatible` means Release
  resolves the newest release whose `requires.contentApi` range holds each live contentApi
  level; `standalone` means the newest release for every level.
- **`baseline`**, **`required`**, **`delivery`** and **`contentPolicy`** (`{ dataOnly: true }`,
  the only v1 value) are `invalid_pack_policy` when malformed; a `required` pack must be
  `delivery: essential` and carry no `entitlement`.
- **`variants`** maps an axis (`texture`, `locale`, `quality`) to 1–16 values; the product of
  the counts is at most 32 (`invalid_pack_variants`). CI publishes one variant per combination.
- **`requires`** is `{ engine?, contentApi?, packs? }` (`invalid_pack_requires`; `features` has
  no meaning yet). `contentApi` is keyed by the app deliverable, `app`
  (`unknown_content_api_app`), each value one to four comparators such as `">=3 <5"`; a
  `compatible` pack declares it (`missing_content_api_range`) and a `standalone` one never does
  (`standalone_with_content_api`). `packs` names other declared compatible or standalone packs,
  each with a version range under that pack's scheme. CI signs these into each variant of every
  pack record.
- **`conflicts`** lists 1–64 other declared packs this one never shares a resolved set with
  (`invalid_pack_conflicts`).
- **`channels`** lists 1–32 canonical channels the pack's releases may be published to beyond
  `stable` and `beta` (`invalid_channel`).
- **`entitlement`** asserts the license flag that gates the pack; it must name a `flag` entry of
  `.pkey/schema` (`unknown_entitlement_ref`). It is **not** the gate: an operator gates a pack
  under Distribution → Access, and a publish whose gate differs from the assertion is refused.
  No push can gate, un-gate or re-flag a pack.
- **`patch`**: `strategies`, a non-empty subset of `delta`, `file` and `chunk` (default: all
  three; `chunk` gives every container variant of 4 MiB or more a chunk index and shared chunk
  bundles, and an explicit list without it opts out); `deltaBases`, 0–8 (default 1)
  (`invalid_pack_patch`). List `chunk` explicitly only once your Worker and CLI support it: an
  older Worker's resync and an older CLI's validation refuse it.
- **`versioning.scheme`** as for the app (default `semver`).
- **`provides`** is the pack's save-compatibility policy: `{required?: boolean, from?: path}`
  and nothing else, so a misspelled member is refused (`invalid_pack_provides`). `from` is a repo-relative path to the JSON array of content ids each
  release provides (default `.pkey/provides.json`; no `.` or `..` segment, at most 256
  characters); `required: true` fails a publish without that file. See
  [Save compatibility](/docs/features/ship-builds/packs/#save-compatibility).
- **`removes`** is never declared (`pack_field_not_supported`): it belongs to one release, so
  pass it to `pkey release publish --removes`.
- **`deliverables.app.content.packChannels`** maps 1–64 pack ids or `prefix.*` patterns to a
  channel (`invalid_pack_channels`); each key must match a declared pack that publishes to that
  channel (`unknown_pack_channels_target`). `content.holds` is never declared: an app release
  holds a pack at publish, in its content stamp (`invalid_app_content`).
- **`deliverables.app.content.attachable`** lists what a `godot.pck` pack may reference outside
  itself: app scripts (`res://scripts/die.gd`), directories of scripts (`res://scripts/dice/`)
  and UIDs (`uid://…`, in Godot's canonical form, for any app resource a pack reaches by UID).
  1–256 distinct entries, paths already normal (`invalid_app_attachable`). Absent, a pack
  attaches no app script and reaches no UID outside its own uid cache: the publish lint refuses
  such a pack, and so does the device. A reference Godot 4.4+ writes carries the path and the
  UID (a script's is in its `.uid` file), so list both for a script, and list the UID of any app
  resource a pack reaches by UID: the device resolves app UIDs itself and admits non-script
  ones, but the publish lint cannot and refuses every unlisted UID. Keep the list equal to the Godot
  SDK's `PKeyOptions.pack_attachable`; it is never stamped into a release.

## Package deliverables

A package (`kind: package`) is a library or image other software installs from a package feed:
an npm package, a Python distribution, a Swift package, a Maven artifact, an OCI image or a
Godot addon. Each version is published with `pkey release publish --deliverable <id>` and served
only by the product's package feed for that ecosystem, never by a device-facing route. A product
may declare packages and no `deliverables.app` (the platform's own product does).

```yaml title=".pkey/release"
deliverables:
  npm.node:
    kind: package
    ecosystem: npm # npm | pypi | swift | maven | oci | godot
    name: "@polaris-key/node" # the ecosystem's grammar
    artifacts:
      tarball: { match: "dist-pkg/polaris-key-node-*.tgz" }
  swift.polariskey:
    kind: package
    ecosystem: swift
    name: polaris-key.PolarisKey
    artifacts:
      archive: { match: "*.zip" }
```

- **`ecosystem`** is one of `npm`, `pypi`, `swift`, `maven`, `oci` and `godot`
  (`invalid_package_ecosystem`).
- **`name`** follows the ecosystem's grammar (`invalid_package_name`): a scoped, lower-case npm
  name (`@scope/name`, at most 214 characters); a PEP 508 name for PyPI; `scope.Name` for Swift
  (SE-0292); `groupId:artifactId` for Maven; lower-case repository path components for OCI;
  `[a-z0-9_]`, at most 64, for Godot (the addon's id under `addons/`).
- No two packages share an ecosystem and a name (`package_name_collision`): names compare after
  PEP 503 normalization for PyPI (`Acme_SDK` is `acme-sdk`), and case-insensitively for npm,
  Swift and Maven.
- **`artifacts`** maps 1–16 entry ids to `{ match }` file-name globs over `--dir`; a package takes
  none of the app's or a pack's fields (`platform`, `arch`, `format`, `content`, `binding`, `type`,
  `packType`: `invalid_package_field`).
- At most 64 package deliverables (`too_many_package_deliverables`).
- A package never has a transport: `.pkey/distribution` refuses one that names it
  (`invalid_transport_deliverable`).

Declaring a package never turns a feed on. The feeds, their namespaces (the only names a feed
takes) and their size ceilings are operator settings; a publish to an ecosystem whose feed is not
configured, or of a name outside its namespace, is refused (`invalid_descriptor`, reason
`package-namespace`).

`pkey release publish --deliverable <id> --dir <path>` reads what each ecosystem's packer wrote,
because the Worker never unpacks a package:

| Ecosystem | `--dir` holds                                                                                                                | `--version`             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| npm       | the `npm pack` / `pnpm pack` tarball (its `package/package.json`)                                                            | read from the tarball   |
| pypi      | the wheels and the sdist (each wheel's `METADATA` becomes its PEP 658 `core-metadata` file)                                  | read from `METADATA`    |
| swift     | the `swift package-registry publish --dry-run` scratch directory: the zip, its `.sig`, the signed `Package*.swift` manifests | required                |
| maven     | one version's directory of a Maven publication (POM, jars, `.module`; checksum sidecars are ignored)                         | read from the POM       |
| oci       | an OCI image layout (`oci-layout`, `index.json`, `blobs/sha256/`) of one image or image index                                | required (also the tag) |
| godot     | the addon zip (`addons/<name>/plugin.cfg`) and an optional PNG icon                                                          | read from `plugin.cfg`  |

A package version is unique forever: a version that was ever published — even one since yanked
or deprecated — is never published again (`release_exists`, reason `package-version-taken`). A
package release is never signed, so it carries no release record (`release_record_rejected`,
reason `package-unsigned`), and `--release-key-file`, `--tag`, `--meta` and the pack flags do not
apply. A Maven `-SNAPSHOT` version is refused (`maven-snapshot`), and so is an unsigned Swift
release on a feed that requires signatures, which is the default (`swift-unsigned`).

Resync writes the declaration to `release_deliverables.def_json` (and each channel's
`includes` to its channel policy, unless an operator owns that channel). The map also defines
what a **release descriptor** may say about a release: see
[Artifacts](/docs/features/ship-builds/releases/artifacts/#declared-artifacts-and-release-descriptors).
Every rule above has a code on
[Manifest validation codes](/docs/reference/validation-codes/).

## Trusted publishing: `publishing.trustedPublisher`

To let a GitHub Actions workflow publish releases without a stored secret, name it in
`.pkey/release` :

```yaml title=".pkey/release"
publishing:
  trustedPublisher:
    workflow: .github/workflows/release.yml # as GitHub's job_workflow_ref spells it
    environment: release # optional; the default
```

- `workflow` is required: a path under `.github/workflows/` ending in `.yml` or `.yaml`
  (`invalid_trusted_publisher_workflow`).
- `environment` is a GitHub environment name: letters, digits, space, `.`, `_`, `-`, at most
  100 characters, no leading or trailing space (`invalid_trusted_publisher_environment`).
- Nothing else is a field. Link and resync add the repository's numeric id and owner id from
  GitHub; the checks that the ref is protected, the runner is GitHub-hosted and the event is
  `push`, `release` or `workflow_dispatch` are fixed; the scopes (default `release:publish`,
  `release:promote`, `distribution:report`; `release:yank`, `distribution:rollout`,
  `distribution:feeds`, `distribution:listing` and `assets:write` are opt-in) are an operator
  setting. A repository cannot
  loosen its own policy.
- The ref the workflow runs on must be covered by a branch or tag ruleset, or GitHub reports
  `ref_protected: false` and the exchange is refused. Give the environment required reviewers
  unless every writer may publish.
- While the policy is manifest-owned, every resync re-applies it (and removing the block removes
  it). An operator who claims it in the console's admin API owns it from then on.

The flow CI follows is on [Trusted publishing](/docs/features/ship-builds/releases/trusted-publishing/).

## Release keys: `releaseKeys`

A release record (`pkey-release+jws`) is what CI signs to say a release exists: its version,
`seq` and builds, with each payload's SHA-256 and size. The Worker never holds a release key, so
it can point devices at a release but cannot invent one. Declare the public halves in
`.pkey/release` :

```yaml title=".pkey/release"
releaseKeys:
  - kid: ci-2026 # the JWS kid CI signs under
    publicKey: 11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo # raw Ed25519, base64url
```

- `pkey release keys generate --kid ci-2026 --out release-key.pem` prints the entry to paste here
  and writes the private key for a GitHub Environment secret (`PKEY_RELEASE_KEY`). The private
  key never goes in the repository.
- 1 to 4 entries; `kid` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and `publicKey` is the raw
  32-byte key in unpadded base64url, 43 characters (`invalid_release_key`). Two keys at once is
  a rotation: add the new one, publish with it, then remove the old one.
- A non-canonical or small-order key is refused (`weak_release_key`), and so is a repeated
  `kid` or key (`duplicate_release_key`) and a key equal to `sparkleEd25519Pub`
  (`release_key_reused`: one key must never sign both archive bytes and JWS inputs).
- The sync refuses a release key equal to any of the product's signing keys, current or
  retired (`release_key_is_product_key`), and keeps the previous `releaseKeys`.
- Apps pin the same keys in their binaries; a record verifies only against pinned release
  keys, never against the product's trust set.
- `contentKeys` is not used and draws a warning (`content_keys_not_supported`). The manifest is
  unsigned, so it can never grant trust: delegate a content key with `pkey release delegate`,
  which signs a `kind: delegation` record with the release key. That signed delegation is the
  only grant.

Without `releaseKeys` a publish carries no record and the signed update feed offers none of that
product's releases.
