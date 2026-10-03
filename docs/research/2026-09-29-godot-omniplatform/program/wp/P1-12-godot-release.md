# P1-12 Package, document and publish the Godot SDK (docs page, Asset Store, Asset Library)

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core. Milestone: **Diceroll can adopt managed config, licensing and identity**                                                                         |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                                              |
| Depends on  | [P1-05](P1-05-godot-devices.md), [P1-08](P1-08-godot-update-check.md), [P1-10](P1-10-godot-ui-kit.md), [P1-11](P1-11-godot-export-plugin.md), [P0-05](P0-05-cors.md) |
| Unblocks    | [D-02](D-02-diceroll-after-p1.md)                                                                                                                                    |
| Role        | `pkey-godot-engineer`                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | docs links (`pnpm --filter @polaris-key/docs check:links`); docs freshness (`gen:check`); `parity:check` once P1b-01 exists                                          |
| Human input | the addon's licence; the first version number; pushing the release tag; the Godot Asset Store upload and the legacy Asset Library submission (no upload API exists)  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Goal

The Godot SDK is a published, documented sixth language. A `godot-vX.Y.Z` tag builds a GitHub
Release zip of `addons/polaris_key/` whose version matches `plugin.cfg` and
`PolarisKey.SDK_VERSION`; the docs site has a Godot page rendered from `sdks/godot/README.md`;
every product-facing statement of the language set counts Godot; and the addon is listed on the
Godot Asset Store and, while it lives, the legacy Asset Library. Diceroll can then adopt it (D-02).

## Why

Report [§5.12](../../README.md#512-packaging-and-versions) fixes the packaging: a GitHub Release
zip as the canonical artefact, the Asset Store (announced 2026-05, in beta, no upload API) and the
legacy Asset Library for editors up to 4.6, with `plugin.cfg`, the tag and `SDK_VERSION`
identical and `.uid` files shipped. Adopters start from the docs and the dock
([§6.1](../../README.md#61-developer-adopter)). Until the language-set statements change, the
repo's own docs say there are four SDKs, which is wrong once Godot passes the corpus (notes/A2
§5.4).

## Read first

- `AGENTS.md` (docs conventions: quoted frontmatter, absolute links ending in `/`, no bare braces
  in MDX) and every P1 hand-off, for the API the README documents.
- Report [§5.12](../../README.md#512-packaging-and-versions),
  [§6.1](../../README.md#61-developer-adopter), [§11](../../README.md#11-decisions-needed)
  (decision 11: 4.4 floor, 4.6+ blessed).
- [notes/E4](../../notes/E4-godot-ecosystem.md) §1.1 (Asset Store rules: licence and readme inside
  the plugin folder, per-version minimum Godot, 1 GB cap), §1.2 (`.uid` files), §9.2 (release
  shape).
- The inventory table in [P1-01](P1-01-godot-scaffold.md) (the rows owned by P1-12).
- `.github/workflows/release-swift.yml` (the tag-validation and `gh release create` pattern);
  `packages/docs/src/content/docs/build/sdks/{index.md,swift.mdx}` (the SDK page pattern that
  imports a README).

## Scope

**In:**

- `sdks/godot/README.md` for adopters: install (zip or Asset Store), the setup dock and
  `res://polaris_key.tres`, `await PolarisKey.boot()`, a tour of `license`, `config`, `devices`,
  `identity`, `update` and `release`, export presets and the CI env overrides, the UI kit and
  theming, supported engines (source floor 4.4, blessed 4.6+, the tested matrix), and the
  platform caveats in Design notes.
- `sdks/godot/CHANGELOG.md` and `addons/polaris_key/LICENSE` (the licence the human chooses).
- `packages/docs/src/content/docs/build/sdks/godot.mdx` rendering the README (as `swift.mdx`
  does); a Godot row and updated counts in `build/sdks/index.md`.
- The **P1-12 rows of P1-01's inventory**: `AGENTS.md:8-9,118`, `CONTRIBUTING.md:3-4,65,81`,
  `README.md:4,58`, `SECURITY.md:55`, `docs/security/WIRE-CONTRACT-V3.md:5`,
  `docs/PRIVACY.md` (the fingerprint heading, if P1-05 did not), `.husky/pre-commit`'s comment,
  the docs-site pages listed there, and the code comments in `client-core`, `sdk-node`, Python
  and Swift.
- **Engine legs 4.5 and 4.6** (left by P1-01, which runs 4.7.2 with a release template and the
  4.4.1 floor): add a CI leg per engine in the `godot` job (editor plus matching release template
  where one is pinned), pin their SHA-512 in `tools/godot.sha512`, and run `tools/run_tests.sh` on
  each before the README states a tested range. The README's "tested matrix" lists exactly the
  engines that ran green.
- `.github/workflows/release-godot.yml`, on tags `godot-v*`: validate the semver tag; fail unless
  tag, `plugin.cfg` and `SDK_VERSION` agree; run `tools/run_tests.sh` on the editor and the
  release template; zip `addons/polaris_key/` as `polaris-key-godot-vX.Y.Z.zip`; run
  `gh release create` with the zip attached.
- A clean-install smoke test in the release workflow: unzip into an empty project on 4.4 and
  4.7.2, import, enable the plugin, and fail on any error in the log.
- `sdks/godot/parity.json` complete for P1 and `pnpm parity:check` green, if P1b-01 has landed.

**Out** (and where it belongs instead):

- Diceroll's adoption (→ [D-02](D-02-diceroll-after-p1.md)).
- Automated Asset Store uploads (no API or CLI exists yet; revisit when one ships).
- `pkey sdk godot`, `pkey init --template godot` and a Godot tab in the console's quick-start
  (report §6.1, `packages/admin/src/views/ProductOverview.tsx`; not owned by any work package).
- A C# facade (report §5.12: later; Godot C# cannot export to web).
- Native plugins (→ P5-05, P5-06, P5-07).
- `PKeyDeviceList` (see the P1-10 hand-off; it could land here since this package depends on
  P1-05, if the lead adds it).

## Design notes

- **The zip is the addon folder only:** `addons/polaris_key/**` with every `.uid`, `plugin.cfg`,
  `LICENSE` and `README.md`, and nothing from `tests/`, the corpus mirror, `.godot/` or
  `build/`. Asset Store rules want the licence and readme inside the plugin folder.
- **Versions:** `plugin.cfg` `version`, the tag `godot-vX.Y.Z`, `PolarisKey.SDK_VERSION` and the
  `X-PKey-SDK-Version` header are one value. The first published version is the human's call
  (recommend `0.1.0`, as a pre-1.0 while P3 and P4 still change the API).
- **The Asset Store** takes a manual upload with a minimum Godot version (4.4) and a changelog per
  version; the legacy Asset Library reaches editors up to 4.6. Record both listing URLs in the PR.
- **Caveats the README must state** (from the P1 briefs):
  - web: needs the Worker's CORS allowlist (P0-05); no fingerprint, no keyless enrolment, no
    strict tiers; `user://` is IndexedDB and may be cleared, which mints a new device id;
  - device-code sign-in sends no fingerprint, so `strict` tiers fail on that path;
  - `clientScoped` secrets are readable by anyone with the build; use edge-mint;
  - iOS: the device id resets when every app from the vendor is uninstalled, and a re-enrolment
    mints a new free licence;
  - iOS and Android: unlocking paid content with an externally bought key conflicts with store
    rules; sign-in is fine;
  - the client gate is UX, not DRM (the anti-piracy-realism review).
- **Docs conventions:** quoted frontmatter values; internal links absolute with a trailing slash;
  no bare `{` or `}` in MDX prose. The SDK page imports the README, so there is one copy.
- **Language count:** after this package, `AGENTS.md` says six languages and rule 2's "all five
  implementations" becomes six; every later wire change names Godot in its plan.

## Steps

1. Write the README and changelog; add the licence file once the human has chosen.
2. Add the docs page and index row; build the docs site and run the link check.
3. Update the P1-12 inventory rows; grep for leftovers.
4. Write `release-godot.yml` and the clean-install smoke test; dry-run it with a pre-release tag
   on a branch or fork.
5. Hand the tag push, the Asset Store upload and the Asset Library submission to the human;
   record the URLs.

## Acceptance criteria

- [ ] A dry run of `release-godot.yml` produces `polaris-key-godot-vX.Y.Z.zip` containing only
      `addons/polaris_key/**`, every `.gd` with its `.uid`, `LICENSE` and `README.md`.
- [ ] The workflow fails when the tag, `plugin.cfg` and `SDK_VERSION` disagree (shown in the PR).
- [ ] The `godot` CI job has green 4.5 and 4.6 legs beside 4.4.1 and 4.7.2, and the README's tested
      range names only engines that ran.
- [ ] The clean-install smoke test passes on Godot 4.4 and 4.7.2: import and plugin enable log no
      errors, and the autoload `PolarisKey` and the dock appear.
- [ ] `/docs/build/sdks/godot/` builds and renders the README;
      `mise exec node@22 -- pnpm --filter @polaris-key/docs check:links` and `gen:check` pass.
- [ ] `grep -rnE "four SDKs|five-language|four client SDKs|four runners"` over the inventory's
      P1-12 paths returns nothing.
- [ ] `pnpm parity:check` passes with Godot's P1 rows `implemented` or an allowed `na` (once
      P1b-01 has landed).
- [ ] The GitHub Release, the Asset Store listing and the Asset Library entry exist, with their
      URLs in the PR (human steps).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm format
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- The published zip and version, the README's API tour and the docs page: D-02 adopts from
  them.
- From here on, "all SDKs" in every brief and plan includes Godot, and the Godot job is part of
  the definition of done for any corpus or wire change.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-12 done`, and note
  the milestone in the PR.

## Corrections from the code (recorded during implementation)

- **The human inputs, as the lead decided them.** Licence MIT (the addon's `LICENSE` already
  existed from the repository's relicensing, commit `7a27c562`), first version 0.1.0 (already
  `plugin.cfg`'s and `SDK_VERSION`'s value). The tag push and both store submissions stay with the
  owner: this package prepares them instead. `sdks/godot/store/LISTING.md` has every listing field
  and `sdks/godot/store/CHECKLIST.md` the step-by-step uploads. The "GitHub Release, Asset Store
  listing and Asset Library entry exist" criterion is open until the owner has done them.
- **Two zips, not one.** `polaris-key-godot-vX.Y.Z.zip` is the brief's artefact (only
  `addons/polaris_key/**`). Godot's asset installer drops a zip's single top-level directory by
  default when it installs from the Asset Library, and only 4.7 exempts `addons/`
  (`editor/asset_library/editor_asset_installer.cpp`, "Don't skip "addons" by default"; 4.4, 4.5
  and 4.6 call `open_asset(file, true)` with no exemption). The legacy library reaches exactly
  those editors, so it gets `polaris-key-godot-vX.Y.Z-assetlib.zip`, the same files under one
  wrapper directory. Because the repository is a monorepo, the Asset Library entry uses the
  **Custom** provider with the release download URL (a GitHub-commit download would install
  `sdks/godot/addons/...`).
- **The zips come from a script.** `sdks/godot/tools/package.py` checks the version agreement
  (plugin.cfg, SDK_VERSION, the tag), zips `git ls-files addons/polaris_key` reproducibly (sorted
  entries, fixed timestamps and modes; byte-identical on one zlib), requires every `.gd.uid`,
  `LICENSE` and `README.md`, and extracts the CHANGELOG section used as release notes and as the
  Asset Store changelog. `sdks/godot/tools/smoke_install.sh` is the clean-install test.
- **The README split in two.** `sdks/godot/README.md` (the docs page) is now the adopter guide,
  followed by the service-by-service reference it already had; the contributor sections (layout,
  running the tests, the runner protocol, the corpus mirror, writing GDScript here, measured
  pitfalls) moved to `sdks/godot/CONTRIBUTING.md`, with a new "Releasing" section, and the code
  comments that cited them were re-pointed. `addons/polaris_key/README.md` is a short readme for
  the plugin folder (the Asset Store rule), not a copy.
- **Brand assets are generated and never imported.** `pnpm gen:brand` now also writes
  `addons/polaris_key/brand/` (the kit's bit-less 16 px Pinned K glyphs, the `games/` "Powered by"
  credit screens and the compact badges, each SVG verbatim after a GENERATED comment) with a
  `.gdignore`. Measured: an SVG's `.import` file written by 4.7.2 is rewritten by a fresh 4.4.1
  import (it drops `compress/uastc_level`, `process/channel_remap/*`, …), which the CI job's
  clean-tree check would fail on. The setup dock rasterises the glyph at run time
  (`Image.load_svg_from_string`) and sets it as the `EditorDock`'s `dock_icon` on 4.6+. The
  listing icon is the kit's own `05-app-icons/key/desktop/app-256.png`, linked, not copied.
- **The engine legs are 4.5.2 and 4.6.3, each with its release template**, pinned in
  `tools/godot.sha512` (plus the macOS editors and 4.4.1's macOS editor for local runs). Both
  needed a test fix before they were green, neither a change to a verdict:
  - **4.5.2 segfaults** reading through a mounted pack whose file is gone: `FileAccessPack` seeks
    before its null check (4.4.1 checks first; 4.6.3 checks both paths). The `uid` group removed
    its mounted `dataB.pck`, the next mount (the `types` group's zip) read
    `res://.godot/uid_cache.bin` through it and the editor crashed. The group now leaves its
    mounted packs on disk, as a game does; the README's engine notes state the rule.
  - **4.6.3 cannot mount the `bake` group's 4.7.2-exported base** (`Pack version unsupported: 4`;
    4.6 reads PCK format 3). Below format 4 the group now checks the refusal and logs that the
    mounted-base reads are not exercised; every delta-decode check still runs.
- **Dry run: local, not on GitHub.** This package may not push, so `release-godot.yml` has not run
  on Actions. Its steps ran locally on macOS: `package.py` twice (identical `SHA256SUMS`), the
  version check failing on a mismatched tag (shown in the report), and the smoke test over both
  zips on 4.4.1, 4.5.2, 4.6.3 and 4.7.2. The workflow has a `workflow_dispatch` dry-run mode
  (every job but the release); the owner checklist runs it before the tag. The smoke test enables
  the plugin through `EditorInterface.set_plugin_enabled` from a throwaway helper plugin and saves
  the project settings itself (4.7 writes `project.godot` on its own schedule; it also records the
  autoload by UID, which the check accepts).
- **Inventory lines had drifted**; the rows were found by grep. Also fixed beyond the listed paths:
  the docs site's description in `astro.config.mjs`, `build/index.md`'s SDK row, the client-core
  README and Swift/Python/Node comments naming three or four runners. Two headings changed, and
  with them their anchors (`start/` "Five SDKs, one corpus, …" and `contribute/waves/` "… in six
  languages"); nothing linked to the old anchors.
- **Parity.** `pnpm parity:check` is green. Godot's two P1 rows that are not implemented stay
  `planned` and unowned, because the registry allows Godot no `na` for them: `core.store` (no work
  package owns a desktop keyring; iOS and Android have their stores) and `identity.oidc` (no
  redirect completion in native Godot; device-code sign-in instead).
- **Not added:** `PKeyDeviceList` (optional in the brief).
