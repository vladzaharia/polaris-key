# P5-08 Platform pack transports: Background Assets, Play Asset Delivery, Steam depots, with CI steps

| Field       | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                                                        |
| Size        | 2 engineer-weeks                                                                                                                                                                                                                                      |
| Depends on  | [P5-02](P5-02-asc-connector.md), [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md), [P4-14](P4-14-readiness-gc-rollouts.md), [P4-08](P4-08-godot-packs.md), [P4-03](P4-03-ci-patch-artifacts.md), [P5-03](P5-03-play-connector.md) |
| Unblocks    | [P6-10](P6-10-godot-android-binding-on-kotlin.md), [D-05](D-05-diceroll-after-p6.md), [SP-28](SP-28-steam-desktop-transport.md), [SP-29](SP-29-msix-flatpak-node-python.md)                                                                           |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                                                    |
| Gates       | none listed; touches the `pkey` CLI and the `polaris-key/publish` Action, and `parity.json` for Godot. If it adds a Worker route, rule 10 applies                                                                                                     |
| Human input | Apple developer account (an app with Apple-hosted asset packs enabled, a CI App Store Connect key with the Developer role); a Play Console app with an internal track; a Steamworks partner account with a build account and a test branch; devices   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                             |

## Goal

One pack identity reaches devices through the platform transports as well as through `pkey-cdn`.
CI can package a pack release for Apple-hosted Background Assets and upload it, generate Play Asset
Delivery modules for an Android App Bundle, and generate Steam depot builds, each writing the
`.pkey/pack.json` marker and reporting availability to distribution. On the device, the Godot SDK's
`apple_ba`, `play_pad` and `steam` transports take the pack from the platform, verify the marker
and every file against the signed files index, and hand it to the `godot.pck` handler. Store
availability of those packs feeds readiness holds. This package closes the program milestone
"Background Assets packs on iOS; in-app updates on Play" (the latter with P5-06's plugin).

## Why

- Store builds must take content through the store's own transport: Apple-hosted Background Assets
  on the App Store, Play Asset Delivery or embedded on Play, depots on Steam
  ([§0.4](../../README.md#04-findings-that-should-change-plans-now) item 7,
  [CONTENT §7](../../CONTENT.md#7-transports)).
- Each transport narrows the pack's binding per outlet
  ([CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet)), and changing
  `contentApi` on the App Store needs the new level's asset packs approved before the app goes live
  ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 1; readiness in P4-14).
- The CI steps are listed in [CONTENT §11](../../CONTENT.md#11-server-side-by-service):
  `xcrun ba-package` plus the ASC upload, AAB asset-pack modules, Steam depot scripts; "each writes
  the marker and reports availability to distribution".

## Read first

- `AGENTS.md`; the hand-offs of P5-02 (`apple-ba` availability rows, ASC ids in
  `platform_ref_json`), P5-05 (`PKeyApple`), P5-06 (`PKeyAndroid`), P4-14 (`dist_readiness`), P4-08
  (the `godot.pck` handler and transport interface), P4-01/P4-04 (the marker format and its
  vectors), P2-06 (`pkey release publish`, the Action) and P2b-03 (`pkey distribution report`).
- [CONTENT §6.6–§6.7, §7, §11–§12](../../CONTENT.md#7-transports) and
  [PARITY §6.4](../../PARITY.md#64-what-stays-platform-bound).
- notes/E1 §E2 (`ba-package` manifest, download policies, shared namespace), §E5 (upload
  endpoints, one live version per pack, "all installed app versions switch"), §E7–§E8.
- notes/E2 §A3 (PAD modes, texture targeting, limits, Godot status), notes/E9 §7.1–§7.3,
  notes/E3 §B3 (SteamPipe, `SetLive`, DLC).
- `packages/cli/src/index.ts` (the command switch).

## Scope

**In:**

- **CLI and Action** (`packages/cli`), proposed commands:
  - `pkey transport apple-ba package --deliverable <packId> --release <v>`: writes the marker,
    generates `Manifest.json` (asset-pack id, download policy from the pack's `delivery`,
    `fileSelectors`), runs `xcrun ba-package` on macOS (Apple's Linux tools sit behind a developer sign-in and are
    unverified; S-01 hand-off);
  - `pkey transport apple-ba upload`: `POST /v1/backgroundAssets` (first time),
    `/v1/backgroundAssetVersions`, `/v1/backgroundAssetUploadFiles`, the part uploads and the commit,
    with CI's own ASC key (never the Worker's);
  - `pkey transport play-pad modules`: writes `com.android.asset-pack` Gradle modules
    (`fast-follow` / `on-demand`; texture-format suffixes `#tcf_astc` etc. mapped from pack variants)
    and patches the Godot Gradle build;
  - `pkey transport steam-depot vdf`: app and depot build VDFs for a content-only build of the pack's
    depot on a branch, with `setlive` for named branches only;
  - each ends by calling `pkey distribution report` with the transport's availability.
- **Asset-pack ids** carry the content level: `<pack>-c<contentApi>` (e.g. `foes-c3`; a dotted
  pack id `diceroll.foes` maps to `diceroll-foes-c3`), because a live asset-pack version switches
  every installed app version (CONTENT §6.6). App Store Connect accepts only alphanumerics and
  hyphens, and an archived id can never be reused (notes/S-01 §5); validate with
  `^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$` and at most 64 characters before the first upload.
  The mapping is lossy (`diceroll.foes` and `diceroll-foes` both become `diceroll-foes-c3`), and a
  collision would upload a new version into another pack's asset pack, permanently. Pack ids follow
  P2-03's deliverable grammar `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, so only `.` is rewritten to `-`
  (anything else outside `[a-z0-9-]` is rejected as defence in depth). That grammar admits ids such
  as `x-.foes` whose mapping has a double hyphen (`x--foes-c3`), which the regex rejects. Resolution
  maps every `apple-ba` pack id of the product at once and fails with a typed error, before any
  upload, when a mapped id collides with another pack's, fails the regex, or exceeds 64 characters
  after the `-c<contentApi>` suffix. The first upload records the ASC asset-pack resource id against the pack
  id, and later uploads refuse when the asset pack found by identifier is not that one (notes/S-01
  §Recommendation; `asc/upload_pack.mjs --expect-resource`).
- **Distribution:** link P5-02's `apple-ba` availability rows to pack releases through the uploaded
  asset-pack id and version; move P4-14's `dist_readiness` from `blocked` to `ready` when the new
  level's packs reach `READY_FOR_DISTRIBUTION`; list asset packs for levels no longer live as
  retire candidates, with the 200-pack and 200 GB quotas shown.
- **Godot transports** in `addons/polaris_key/content/transports/`: `apple_ba.gd` (ensure,
  progress, fresh `url(for:)` path each launch), `play_pad.gd` (fetch, confirmation dialog on large
  cellular downloads, absolute pack path: `assetsPath() + "/<pack>.pck"`, re-read every launch, per
  S-05 §4.2), `steam.gd` (GodotSteam when present: install dir, DLC
  installed, build id, beta name; read the marker from the depot; never write there). Each verifies
  the marker, then every file against the files index, before handing the pack to the handler.
- `parity.json` for Godot: `packs.transport.apple`, `packs.transport.play`, `packs.transport.steam`.
  Keep the runtime `except` entries P1-01 declared when marking them implemented.
  `packs.transport.apple` on macOS has no owner (P5-05 Out).
- End-to-end device runs (human): one Apple-hosted pack on TestFlight, one fast-follow pack on the
  internal track, one content-only Steam build on a test branch.

**Out** (and where it belongs instead):

- Readiness-hold machinery and server GC (→ [P4-14](P4-14-readiness-gc-rollouts.md)); this package
  feeds it.
- `msix-optional` and `flatpak-ext` transports: no work package owns them yet.
- Paid-pack gating on stores (StoreKit, Billing, Steam DLC ownership) (→ [P6-01](P6-01-commerce-bridge.md)).
- The native plugins themselves (→ [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md)).
- Self-hosted managed Background Assets: `pkey-cdn` covers non-store outlets (notes/E1 §E7,
  notes/S-01).

## Design notes

- **The platform moves bytes; Polaris Key keeps identity.** After the platform says "installed",
  the SDK reads the marker beside the payload (P4-01's `pkey-marker/1`: `packId`, `version` and
  the compact `pkey-release+jws`, checked with the release-record verifier), then hashes the
  payload or every file against the signed record and files index before mount (CONTENT §7,
  layering rule). Never trust a platform's own hashes (CONTENT §12).
- **Data-only on store builds.** The CI lint from P4-03 runs before any platform packaging; a pack
  with scripts never reaches `apple-ba`, `play-pad` or a Steam depot of a store build.
- **Apple quotas and switching.** One live App Store version per asset pack; a new version switches
  every installed app version. Retire old `contentApi` packs promptly; whether the ASC API can
  archive them was unverified before S-01: archiving is `PATCH /v1/backgroundAssets/{id}`
  `{archived: true}` and is irreversible, so the first cut lists candidates for the operator.
- **S-01 upload facts.** Start from `prototype/apple-ba/asc/upload_pack.mjs` (request shapes from
  the ASC OpenAPI 4.5 spec). App Store review of a pack version is a `reviewSubmissionItems` item
  with a `backgroundAssetVersion` relationship; external TestFlight review of a pack has no API
  (`betaAppReviewSubmissions` relates only to builds), so it is an operator step in the UI.
  `ba-package` output is not byte-reproducible (packaging time in the archive root and manifest):
  hash the pack's inputs, never the `.aar`. Updates are whole-pack on the wire (notes/S-01 §3).
- **PAD pins.** PAD packs change only with a new AAB; a `compatible` pack delivered by PAD is
  effectively pinned on Play. Its availability is the AAB's: take it from P5-03's Play mirror when
  present, otherwise from the CI report (P5-03 is not a declared dependency).
- **Steam** never writes into the install directory; paid packs are DLC depots (P6-01 checks
  ownership).
- **Size disclosure and cellular choice** (Apple 4.2.3(ii)) stay the planner's and `PKeyBoot`'s job;
  the transports expose sizes and the confirmation hooks.
- **What can be built before a human supplies anything:** the CLI against a fake ASC server and
  golden VDF and Gradle outputs; `xcrun ba-serve` and `bundletool --local-testing` for local device
  runs; the transports against the plugins' stub facades. Uploads and store availability wait for
  the accounts.

## Steps

1. Marker writing and the three packaging commands with golden-file tests.
2. The ASC upload command against a fake server; the Action inputs.
3. Distribution linking, readiness clear, retire candidates; tests.
4. The three Godot transports with stub-backed tests.
5. Device runs; `parity.json`; docs for adopters (per-transport CI setup).

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/cli test` covers the Background Assets manifest, the Gradle
      modules (including texture suffixes) and the VDFs against golden files, and the upload
      sequence against a fake ASC server. The fake-server tests include a product whose pack ids
      `x.foes` and `x-foes` map to the same asset-pack id, a pack id `x-.foes` that maps to a double
      hyphen, and a 62-character pack id; each fails with a typed error before any request, and an upload whose found asset
      pack is not the recorded resource id is refused.
- [ ] Worker tests show a `BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED` to
      `READY_FOR_DISTRIBUTION` for `foes-c4` moves readiness to `ready` for the app release that
      needs level 4, and a `REJECTED` state leaves it `blocked`.
- [ ] Headless Godot tests show each transport refuses a pack whose marker or file hash does not
      match, and returns `Unsupported` when its plugin is absent.
- [ ] The three device runs are recorded in the PR by the person who ran them.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`), including rule 10 if a route was added.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- readiness asc
GODOT_BIN=godot-4.7.2 sdks/godot/tools/run_tests.sh   # P1-01's runner; add suite_transports to the ci set
```

## Hand-off

- `pkey transport …` commands and the Action inputs Diceroll's CI uses in D-05.
- The `apple_ba`, `play_pad` and `steam` transports behind P4-08's transport interface.
- The asset-pack id convention `<pack>-c<contentApi>`.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-08 done`.

## Plan amendments (P4-13)

The approved [`plans/P4-13.md`](../plans/P4-13.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from implementation

Recorded by the implementer on 2026-10-03. Where this brief and the code disagree, the code is
the fact.

- **Paths.** The Godot transports follow P4-08's layout, not `content/transports/`. They are
  `addons/polaris_key/packs/transport_platform.gd` (`PKeyPackPlatformTransport`, the shared base)
  and `transport_apple_ba.gd`, `transport_play_pad.gd` and `transport_steam.gd`. The CLI is
  `packages/cli/src/transport.ts`, `transportAppleBa.ts`, `transportPlayPad.ts` and
  `transportSteam.ts`.
- **One mapping for CLI and Worker.** `@polaris-key/manifest` `transportIds.ts` holds the
  mappings: `assetPackId`/`resolveAssetPackIds` (`.` → `-`, `<base>-c<contentApi>`, the grammar,
  64 characters, product-wide collisions, typed `TransportIdError`), and the Play asset-pack names
  (`resolvePadPackNames`, `.` and `-` → `_`, collisions refused). P4-14's readiness mapped the
  pack id's last segment only (`<pack leaf>-c<n>`). It now uses the brief's full-id convention
  (`djdl.foes` → `djdl-foes-c4`).
- **CLI surface.** Each command takes `--deliverable <packId> --release <version>`. Commands that
  write payloads also take `--from <dir>`: the `--out` cache of `pkey release publish
--deliverable`. The payload is re-hashed against the cached record and P4-03's lint runs again,
  before anything is written, so a pack with scripts never reaches a store transport. The steps
  are:
  - `apple-ba package` (default `--out build/pkey-transport/apple-ba`, `--content-api` defaulting
    to the app's `content.contentApi` and checked against the pack's `requires.contentApi`,
    `--no-archive` off macOS);
  - `apple-ba upload` (`--dir`, `--expect-resource`, `--lock`, `--wait`);
  - `play-pad modules` (`--project`, `--delivery`, `--default-texture`);
  - `steam-depot vdf` (`--depot`, `--branch` or `--channel`, `--setlive`, `--app`).

  A pack that `.pkey/distribution` does not route through the transport is refused.

- **Recording the asset pack's resource id.** It is recorded in the repository, in
  `.pkey/asset-packs.json` (`pkey-asset-packs/1`), which the first upload writes and the operator
  commits. A server-side record would need a CI read route, a wire addition this brief did not
  plan. An upload is refused in three cases: the asset pack found by identifier is another
  resource (`asset-pack-resource-mismatch`); one exists that nothing records
  (`asset-pack-unrecorded`, adopted only with `--expect-resource`); or the recorded one is gone
  (`asset-pack-missing`). App Store Connect credentials come from `ASC_KEY_ID`, `ASC_ISSUER_ID`,
  `ASC_PRIVATE_KEY` or `ASC_KEY_PATH`. The app is the `apple-ba` outlets' `appleId`, or
  `ASC_APP_ID`.
- **Reports.** `apple-ba package` reports `pending` with `{assetPackIdentifier, contentApi}`.
  `apple-ba upload` reports `processing` on `testflight` outlets and `pending` on `app-store`
  outlets, with `{assetPackIdentifier, ascBackgroundAssetId, ascBackgroundAssetVersionId,
ascVersion, contentApi}`. `play-pad modules` reports `pending` with `{padPack, deliveryType}`,
  and `steam-depot vdf` reports `pending` with `{steamAppId, steamDepotId, steamBranch}`. Each
  step takes `--no-report`. The upload does not wait for processing by default (`--wait <minutes>`
  polls), because the connector follows the states.
- **Device layouts.** These are the directories the CLI writes and the Godot transports read:
  - Apple: `pkey/<assetPackId>/` inside the asset pack, one file selector.
  - Play: `src/main/assets/pkey/` for the default variant, `pkey#tcf_<alias>/` for each other
    texture variant (`etc2` is the default when published).
  - Steam: `<depot root>/pkey_packs/<packId>/`.

  Each directory holds one container with its `X.pkey.json` marker (named `<assetPackId>`,
  `<padName>` or `<packId>` plus `.pck`/`.zip`), or a tree with `.pkey/pack.json`. Two markers in
  one directory are refused as ambiguous.

- **The Godot engine.**
  - **Boot.** A platform copy is verified like an embedded baseline: the marker, then the payload
    or treeDigest against the signed record. The stamp pin check is replaced by a platform pin
    rule: the copy must be the pinned release, or, when the transport floats (`apple-ba`,
    `steam-depot`, CONTENT §6.6), a higher `seq` of the same pack. Play copies must be exactly the
    pin. An accepted copy replaces the pack's `res://` baseline and is never written to the state
    document, because its path is re-resolved at every boot.
  - **Planning.** A pack the platform carries gets a target bound to the platform's transport,
    and caps list that transport only while the platform is available. The result is `noop`,
    `platform` or `plan-transport-unsupported`, never a CDN fallback.
  - **Delivery.** The `platform` strategy asks the transport to deliver, re-reads the copy and
    accepts it under the float rule above (`record-mismatch` otherwise; a bad marker or payload is
    `marker-rejected` with the step).
  - **`noop` onto a platform copy** returns early and commits nothing to the state document
    (fixed in review round 1).
- **Distribution.** `connectors/asc/apply.ts` `resolveBackgroundAssetRelease` links a Background
  Asset object to a pack release. It looks, in order, at the upload report's
  `ascBackgroundAssetVersionId`, then at an already-linked object with that version, then at
  `assetPackIdentifier` + `ascVersion`. It accepts only a pack release whose `assetPackBase` is the
  identifier's base, and never links when two releases claim the same version. A CI report also
  links objects that arrived before it (`availability.ts` `linkBackgroundAssetObjects`). The
  connector's next read writes their availability. The new console-only read `GET
…/distribution/asset-packs` (`assetPacks.ts`) lists asset packs with their level, newest
  version, states, `live` and `retireCandidate`, plus the 200-pack and 200 GB quotas. It never
  archives. There is no migration, no wire change and no public route (rule 10 is not
  triggered).
- **Action.** The `polaris-key/publish` inputs added are `transport` (`apple-ba-package`,
  `apple-ba-upload`, `play-pad-modules`, `steam-depot-vdf`), `content-api`, `variant`,
  `transport-out`, `gradle-project`, `pad-delivery`, `steam-depot`, `steam-branch`,
  `steam-setlive`, `asc-expect-resource` and `transport-report`. With `transport`, `dir` is the
  publish cache, or the package output for the upload, and publish-only inputs are refused.
- **CI.** The `apple` job now runs `pkey transport apple-ba package` against the real `xcrun
ba-package` (`PKEY_REAL_BA_PACKAGE=1`). It also runs `suite_transports` beside the PKeyApple
  stubs, and the `android` job runs it beside the PKeyAndroid stubs. The suite is in the `ci` set,
  so the `godot` job runs it too. No secrets are used. The generated Gradle modules are not built
  in CI, because that needs a full Godot Android export; this is owner checklist row 3.
- **Parity (Godot).** `packs.transport.apple`, `.play` and `.steam` are `implemented`, keeping
  their runtime `except` entries. Each note says the proof is stub-based and the device run is the
  owner's. Apple on macOS answers `unsupported` (`runtime`): no package owns a macOS binding
  (P5-05 Out), and the registry allows no N/A there. No other SDK had a row planned under P5-08.
- **Timings (`suite_transports`, 82 checks).** 985 ms on the 4.7.2 editor, 824 ms on the 4.7.2
  macOS release template, and 949 ms on the 4.4.1 editor. After review round 1 and the merge of
  main (90 checks, full `ci` set green on each): 1376 ms on the 4.7.2 editor, 1003 ms on the
  4.7.2 macOS release template, and 2010 ms on the 4.4.1 editor.
- **Not done here, with owners.**
  - **Holding a store release through a connector** (`PENDING_DEVELOPER_RELEASE`). P4-14's Out
    points here, but this brief's scope does not include it. The docs now tell the operator to set
    a manual release. Follow-up: P5-02's controls plus readiness. Lead to schedule.
  - **The chunk HTTP transcript** (P4-11 follow-up). The platform transports make no ranged
    requests, and they declare `supports_range()` false. The work is a Worker scenario for the
    `pkey-cdn` bundle route, a `transcript` proof on `packs.apply.chunk` in `features.json` (a
    registry change), and replayers in Node, Python, Swift and Godot. None of that overlaps this
    package. It stays a lead-scheduled follow-up.
  - **P4-18 dcz.** This package does not touch the web transport, so there was nothing to confirm
    on the payload URL.
  - **Steam.** It is not verified that an app build listing only the pack's depot leaves the other
    depots' manifests on the branch unchanged. This is owner checklist row 4.
  - **PAD texture suffix stripping** is not configured. The transport reads `pkey/` and any
    `pkey#tcf_*` directory, so it works either way.

- **Review round 1.**
  - **A copy that floated in is current.** A platform copy that `load_state` accepted under the
    float rule against the stamp's pin counts as current for that pin, so `ensure()` succeeds when
    Apple has auto-updated an installed asset pack. `_ensure_platform` applies the same platform pin
    rule when the target is the stamp's pin. A decision's exact target still takes only that
    release. An older copy, or a float the rule refused (Play, or a revoked release), fails closed
    with `record-mismatch`. The `noop` edge is closed: a `noop` onto a platform copy returns that
    copy and commits nothing.
  - **One availability row per asset pack.** An apple-ba row's `build_id` is now its asset-pack
    id, from both the connector (`syncBackgroundAsset`) and the CI report.
    - The CI report keeps its request shape. The Worker keys a pack report on an outlet whose
      transport for that pack is `apple-ba`, and whose `platformRef.assetPackIdentifier` maps back
      to the pack. The OpenAPI description of `POST /{product}/distribution/report` says so.
    - Readiness and the asset-pack listing find a level's row by that key. A whole-release row
      (`''`) still counts when it names the level's asset pack, or names none.
    - No migration: production holds no pack releases, so no existing apple-ba row needed re-keying.
  - **`apple-ba upload` re-hashes the packaged content** against the package step's
    `payloadSha256`. With `--from <cache>` it also checks the content against the signed record:
    the record hash, the variant's payload and the marker. Any mismatch is refused with
    `asset-pack-inputs-mismatch` before any request.
  - **Docs and threat model.**
    - THREAT-MODEL.md has a "Platform pack transports (P5-08)" section, and platform copies are
      listed among the release-key surfaces.
    - `transport.ts` explains why the CLI does not verify the cached record's JWS.
    - The adopter docs say collisions are checked only among the current apple-ba packs, and that
      `.pkey/asset-packs.json` is the guard across time.
    - D-05's brief notes the full-id convention.

- **What "supported" means.** `SUPPORTED_TRANSPORTS` (`outlets.ts`) means "Polaris Key acts on
  it", and now lists `pkey-cdn`, `web`, `embedded`, `apple-ba`, `play-pad` and `steam-depot`.
  - `DERIVED_TRANSPORTS` (`availability.ts`) is its own list, `pkey-cdn`, `web` and `embedded`,
    with a test keeping it a subset. Availability is still derived only for transports Polaris Key
    delivers. The store transports get theirs from CI reports and the connector.
  - `msix-optional` and `flatpak-ext` stay unsupported.
  - The device's `plan-transport-unsupported` does not depend on this list. It applies whenever
    the build has no transport for a pack's binding.
  - `Matrix.tsx` is untouched (a separate branch rewords its label). Only the `supported` comment
    in `admin/src/api.ts` changed.

### Owner checklist (device, accounts; not run)

1. **Apple.** Use an app with Apple-hosted asset packs enabled and a CI App Store Connect key with
   the Developer role. Steps:
   1. Set `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY`.
   2. Run `pkey transport apple-ba package` on macOS, then `upload`.
   3. Commit `.pkey/asset-packs.json`.
   4. Confirm the connector shows the version going through `PROCESSING`, then `COMPLETE`, then
      internal `READY_FOR_TESTING`.
   5. Install the TestFlight build (P5-05's store export, iOS 26.4 or later). Confirm the
      transport's `installed()` holds the pack, and that the marker is verified and the pack is
      mounted.
   6. Record the timeline (S-01 §4 table).
2. **App Store review.** Add the pack version to a review submission with the app build. Confirm
   readiness turns `ready` at `READY_FOR_DISTRIBUTION`, and that `GET …/asset-packs` lists the old
   level as a retire candidate.
3. **Play.** Use an app on the internal track. Steps:
   1. Run `pkey transport play-pad modules` into `android/build`.
   2. Export the AAB and build it with Gradle.
   3. Check the modules with `bundletool build-apks --local-testing`, then upload to the internal
      track.
   4. Install from Play. Confirm the fast-follow pack reaches `COMPLETED` and that its
      `assetsPath()` holds `pkey/<name>.pck`, or the `#tcf` variant on an ASTC device.
   5. Confirm the marker is verified and the pack is mounted.
   6. Confirm the cellular confirmation dialog for a pack over 200 MB.
4. **Steam.** Use a build account and a test branch. Steps:
   1. Run `pkey transport steam-depot vdf --setlive` on the test branch, then `steamcmd
+run_app_build`.
   2. Confirm the other depots keep their manifests.
   3. Confirm the game with GodotSteam reads `pkey_packs/<packId>/`, verifies it and mounts it,
      and that `build_id()` and `beta_name()` report the branch.
5. **Record each run in the PR** (acceptance criterion 4).
