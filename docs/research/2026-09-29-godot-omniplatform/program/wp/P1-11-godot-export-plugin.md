# P1-11 Godot export plugin v1: build stamp and editor dock

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | P1: Godot SDK core                                                                               |
| Size        | 0.5–0.75 engineer-weeks                                                                          |
| Depends on  | [P1-01](P1-01-godot-scaffold.md), [P1-02](P1-02-godot-core.md)                                   |
| Unblocks    | [P1-10](P1-10-godot-ui-kit.md), [P1-12](P1-12-godot-release.md), [P3-10](P3-10-godot-updater.md) |
| Role        | `pkey-godot-engineer`                                                                            |
| Plan mode   | no                                                                                               |
| Gates       | a template-run check of the stamp in the `godot` CI job; `packages/cli` tests                    |
| Human input | none                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Goal

Every export carries a small, deterministic build stamp, `res://.polaris_key/build.json`, set per
export preset (outlet, channel, build number) and overridable from CI, plus matching
`pkey_outlet_*` and `pkey_channel_*` feature tags. The SDK reads the stamp at runtime, with a
sensible fallback in the editor. A setup dock writes `res://polaris_key.tres` (product, base URL,
pinned keys, editor channel) and checks the pins against the live trust manifest. `pkey trust`
prints a GDScript snippet.

## Why

A game ships one codebase through many outlets, and the SDK must know which build it is running:
the licence gate needs the channel, update decisions need the outlet, telemetry reports both
(report [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet),
[§5.9](../../README.md#59-editor-and-export-plugin)). Diceroll stamps its distribution per
export rather than per artifact, so Steam, itch and sideload builds are mislabelled (report
[§9.2](../../README.md#92-diceroll-for-the-diceroll-side) items 2–3). Custom feature tags do not
exist in the editor, so the SDK needs an explicit fallback (notes/E4 §4). The stamp is also the
Godot form of the build identity that `pkey build-info` writes for other build systems (report
[§3.4](../../README.md#34-release-the-record-of-everything-that-exists)).

## Read first

- `AGENTS.md` and the [P1-01](P1-01-godot-scaffold.md) hand-off; the
  [P1-02](P1-02-godot-core.md) hand-off (`PKeyOptions`, trust verification, headers).
- Report [§3.1](../../README.md#31-vocabulary) (platform, arch and outlet ids),
  [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet),
  [§5.9](../../README.md#59-editor-and-export-plugin), [§6.1](../../README.md#61-developer-adopter).
- [notes/E4](../../notes/E4-godot-ecosystem.md) §1.2 (plugin, autoload, docks, `.uid`), §4
  (`EditorExportPlugin` hooks, `get_or_env`, `add_file`, feature tags), §9.2–§9.3 (4.4 floor,
  `add_control_to_dock` vs `add_dock`).
- [notes/A4](../../notes/A4-diceroll-mapping.md) §1.8 (Diceroll's `build_info.json` and
  distributions) and §1.13 (its export presets).
- `packages/cli/src/manifest.ts:161-178` (`trustSnippet`), `packages/cli/README.md:102-110`,
  `packages/cli/test/cli.test.ts`.

## Scope

**In:**

- `export/export_plugin.gd` (`PKeyExportPlugin extends EditorExportPlugin`), registered in
  `plugin.gd` with `add_export_plugin`:
  - `_get_export_options(platform)`: `polaris_key/outlet` (an outlet id from report §3.1, with a
    per-platform default: `direct` on desktop, `play` on Android, `app-store` on iOS, `web` on
    web), `polaris_key/channel` (default `stable`), `polaris_key/build_number` (integer);
  - CI overrides through `get_export_preset().get_or_env(option, env)` with `PKEY_BUILD_OUTLET`,
    `PKEY_BUILD_CHANNEL`, `PKEY_BUILD_NUMBER`;
  - `_get_export_option_warning` for an unknown outlet id, a channel outside P0-04's
    vocabulary, or a non-semver `application/config/version`;
  - `_export_begin`: build the stamp and add it with
    `add_file("res://.polaris_key/build.json", bytes, false)`;
  - `_get_export_features`: `pkey_outlet_<id>` and `pkey_channel_<channel>`, with `-` mapped to
    `_` (`pkey_outlet_app_store`).
- **Stamp format** (`pkeyBuild: 1`), deterministic, no timestamps: `product`, `version`,
  `build`, `outlet`, `channel`, `engine` (`godot-<major>.<minor>`), `engineVersion`, `platform`,
  `arch`, `packSources` (`embedded` until P4-08), `embeddedPacks` (`[]` until P4-08), `debug`,
  `sdkVersion`, and `outletIds`: the product's non-secret outlet identities that runtime
  detection (P3-11) checks offline at first launch
  ([notes/S-06](../../notes/S-06-outlet-signals.md), precedence rule 4). Keys, each optional:
  `steamAppId`, `itchGameId`, `flatpakId`, `snapName`, `caskToken`, `msixFamilyName` (the
  Microsoft Store or App Installer package family name, which the `windows.*` rows must match
  because package identity can be inherited from an MSIX parent process), and `bundleId` (from the
  preset's `application/bundle_identifier` or `package/unique_name` where the platform has one).
  The export plugin copies the others from the `.pkey/distribution` outlet entries when that file
  exists ([P2b-02](P2b-02-distribution-manifest.md)); until then from an optional
  `polaris_key/outlet_ids` export option (a JSON object). An absent id is simply left out, so the
  object is `{}` at minimum.
- `core/build_stamp.gd` (`PKeyBuildStamp`) and `PolarisKey.build_info()`: read the stamp with
  `FileAccess` (data added by `add_file` is not imported); when absent, fall back to
  `application/config/version`, no outlet, the dock's editor channel, and the runtime
  platform and arch. The core takes `X-PKey-Channel` and the report's `outlet` from here.
- **Setup dock** (`editor/setup_dock.tscn`): product slug, base URL, pinned trust keys (paste
  from `pkey trust`), editor channel; "Check" fetches discovery and
  `/.well-known/polaris-trust.jws` and verifies the manifest against the entered pins, showing
  each `kid` and a key fingerprint; "Save" writes `res://polaris_key.tres`. `add_dock` when the
  editor has it (4.6+), otherwise `add_control_to_dock`.
- `pkey trust` prints a Godot snippet (`const PINNED_TRUST_KEYS := {"<kid>": "<key>"}`) beside
  the JSON, Node/React, Python and Swift ones; the CLI README and a CLI test.
- CI: the `godot` job exports the harness preset with `PKEY_BUILD_OUTLET=steam`,
  `PKEY_BUILD_CHANNEL=beta` and `PKEY_BUILD_NUMBER=42`, and runs a `build_stamp` suite on the
  release template that asserts the stamp and the feature tags.

**Out** (and where it belongs instead):

- Pack sources, embedded pack lists and pack verification at export (→ [P4-08](P4-08-godot-packs.md)).
- Android manifest and Gradle patches, Info.plist keys (`SUFeedURL`, Background Assets)
  (→ [P3-10](P3-10-godot-updater.md), [P5-05](P5-05-apple-plugin-package.md),
  [P5-06](P5-06-kotlin-aar.md)).
- Runtime outlet detection that overrides the stamp (→ [P3-11](P3-11-outlet-detection.md)).
- `pkey build-info` for other build systems. [P2-06](P2-06-publish-cli-action.md) excludes it and
  points here, but this package stamps Godot exports only, so the CLI command has no owner; whoever
  builds it writes the same `pkeyBuild: 1` shape (report §3.4 names its file `pkey_build.json`).
- `pkey sdk godot` and `pkey init --template godot` (report §6.1; not owned by any work package).
- Diceroll's per-artifact stamping (→ [D-02](D-02-diceroll-after-p1.md)).

## Design notes

- **Outlet ids are the report's** (§3.1: `direct`, `app-store`, `testflight`, `altstore`,
  `altstore-pal`, `play`, `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`,
  `app-installer`, `steam`, `itch`, `flathub`, `snap`, `winget`, `web`). The snake_case names in
  report §5.1's directory list (`app_store`, `ms_store`) are file names, not ids. The list becomes
  a generated enum in P1b-02; keep it in one table until then.
- **Feature tags:** the report names `pkey_outlet_*`; notes/E4 names `pkey_channel_*`. Emit both.
- **Platform and arch** use the report §3.1 values; Android with more than one ABI and a
  universal macOS export stamp `universal`; web stamps `wasm32`.
- **Pins are compiled in, never learned.** The dock only checks pasted pins against the live
  manifest; it may pre-fill candidates from discovery, but saving them requires an explicit
  confirmation that they match `pkey trust` or the console. The SDK never pins from discovery at
  runtime (notes/A2 §1.5).
- **Config lives outside `addons/`** (`res://polaris_key.tres`), so updating the addon never
  overwrites it (notes/E4 §1.2).
- **No abort API in 4.4.** An export plugin cannot reliably fail an export; show the warning in
  the dialog, print an error at export, and rely on P1-02 refusing a non-semver version and on
  the CI stamp check.
- **Everything works headless** (`--export-release`), because `get_or_env` exists from 4.4.
- **Declared dependency gap:** the dock writes `PKeyOptions` and verifies pins with P1-02's trust
  code; confirm P1-02 is done before starting.
- The stamp is unsigned local data; tampering only changes what the install reports about itself.

## Steps

1. Write `PKeyBuildStamp` and the fallback; unit-test both.
2. Write the export plugin; export the harness preset headless with the env overrides.
3. Add the `build_stamp` suite and the CI step.
4. Build the setup dock; test the pin check against the fake server's manifest.
5. Add the GDScript snippet to `pkey trust`, its README line and a test.

## Acceptance criteria

- [ ] A headless `--export-release` of the harness preset with `PKEY_BUILD_OUTLET=steam`,
      `PKEY_BUILD_CHANNEL=beta`, `PKEY_BUILD_NUMBER=42` produces a pack whose
      `res://.polaris_key/build.json` has those values, `pkeyBuild: 1`, the version from
      `application/config/version`, an `outletIds` object and no timestamp; the stamp is
      byte-identical across two exports.
- [ ] On the release template, `OS.has_feature("pkey_outlet_steam")` and
      `OS.has_feature("pkey_channel_beta")` are true, and `PolarisKey.build_info()` returns the
      stamp.
- [ ] In the editor (no stamp), `build_info()` returns the fallback with the dock's channel and no
      outlet.
- [ ] The export dialog warns for an unknown outlet, a channel outside the vocabulary and a
      non-semver version.
- [ ] The dock's "Check" accepts a manifest signed by the pasted key and rejects one signed by
      another key or for another product.
- [ ] `mise exec node@22 -- pnpm --filter @polaris-key/cli test` covers the Godot snippet.
- [ ] The plugin loads on the 4.4 and 4.7.2 editors (the dock appears; no errors in the log).
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.

## Verify

```sh
PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42 \
  godot --headless --path sdks/godot --export-pack "Conformance (Linux)" build/pkey_conformance.pck
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

## Hand-off

- `res://.polaris_key/build.json` (`pkeyBuild: 1`) and `PolarisKey.build_info()`: P1-05 reports
  `outlet` from it, P1-10's dev-menu section shows it, P3-08 and P3-10 feed it to the update
  decision, P4-08 fills `packSources` and `embeddedPacks`, and a future `pkey build-info` writes
  the same shape for other build systems.
- `PKeyExportPlugin`'s option names and env vars (`PKEY_BUILD_OUTLET`, `PKEY_BUILD_CHANNEL`,
  `PKEY_BUILD_NUMBER`), which D-02 sets in Diceroll's CI.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-11 done`.
