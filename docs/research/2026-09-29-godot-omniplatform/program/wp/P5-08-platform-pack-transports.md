# P5-08 Platform pack transports: Background Assets, Play Asset Delivery, Steam depots, with CI steps

| Field       | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                                                        |
| Size        | 2 engineer-weeks                                                                                                                                                                                                                                      |
| Depends on  | [P5-02](P5-02-asc-connector.md), [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md), [P4-14](P4-14-readiness-gc-rollouts.md), [P4-08](P4-08-godot-packs.md), [P4-03](P4-03-ci-patch-artifacts.md), [P5-03](P5-03-play-connector.md) |
| Unblocks    | [D-05](D-05-diceroll-after-p6.md)                                                                                                                                                                                                                     |
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
    `fileSelectors`), runs `xcrun ba-package` (macOS or the Linux tools);
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
  cellular downloads, absolute pack path), `steam.gd` (GodotSteam when present: install dir, DLC
  installed, build id, beta name; read the marker from the depot; never write there). Each verifies
  the marker, then every file against the files index, before handing the pack to the handler.
- `parity.json` for Godot: `packs.transport.apple`, `packs.transport.play`, `packs.transport.steam`.
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
