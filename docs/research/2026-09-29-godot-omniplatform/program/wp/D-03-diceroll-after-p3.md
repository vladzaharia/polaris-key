# D-03 Diceroll: publish through the Action, take feeds from Polaris Key, delete the old updater

| Field       | Value                                                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | D: Diceroll adoption (vladzaharia/diceroll); stage "After P2–P3"                                                                                                                                                                                                       |
| Size        | 1–2 engineer-weeks                                                                                                                                                                                                                                                     |
| Depends on  | [P3-10](P3-10-godot-updater.md), [P2b-05](P2b-05-storefront-feeds.md), [P2-06](P2-06-publish-cli-action.md)                                                                                                                                                            |
| Unblocks    | none in the graph                                                                                                                                                                                                                                                      |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                     |
| Gates       | `pkey validate` clean; Diceroll's CI; one tagged pre-release published end to end through the Action                                                                                                                                                                   |
| Human input | none in the graph. Needed in practice: a GitHub Environment `release` with required reviewers holding the new Ed25519 release key; the trusted-publisher policy set in the console; an F-Droid repo signing key as a CI secret; the go-ahead to retire the `channels` release |
| Repo        | `vladzaharia/diceroll`                                                                                                                                                                                                                                                 |

> **Re-verify first.** Diceroll paths below come from [notes/A4](../../notes/A4-diceroll-mapping.md)
> (Diceroll `4e78bb6`, 2026-09-29) plus what D-01 and D-02 changed; this brief was written without
> access to the Diceroll repository. Confirm every path before deleting it, and list the actual
> deletions in the PR.

## Goal

Diceroll publishes each release with `polaris-key/publish`; installed players on self-updating
outlets get updates decided by the Godot SDK from Polaris Key's signed channel feed; and its
AltStore/SideStore source, F-Droid repository and Obtainium configuration come from Polaris Key.
Diceroll's own updater, manifest generator and source generator are deleted.

**Diceroll deletes at this step** ([README §13](../../README.md#13-diceroll-adoption-path),
[notes/A4 §4.1](../../notes/A4-diceroll-mapping.md#41-deleted-moves-into-pkey-or-the-godot-sdk)):

- `game/update/*` (`updater.gd`, `update_client.gd`, `update_fetcher.gd`, `update_manifest.gd`,
  `update_policy.gd`, `update_store.gd`, `semver.gd`, `update_keys.gd`) and its six suites,
  `tests/test_update_{manifest,policy,store,e2e,semver,channel}.gd`, with their fixtures;
- `tools/ci/update_manifest.py` and `tools/ci/altstore_source.py`, and their steps in `release.yml`;
- the rolling `channels` release, after the bridge period below;
- the `UPDATE_SIGNING_KEY` secret, replaced by the Ed25519 release key;
- the distribution half of `tools/ci/stamp_version.py` (version and build-number rewriting stays);
- `DICEROLL_UPDATE_BASE_URL`, the `diceroll/update/base_url` setting and `DICEROLL_UPDATE_TOKEN`;
  selftest step 4 (`tools/ci/selftest.sh:55-64`); the dev menu's UPDATES internals
  (`ui/modals/dev_menu.gd:158-222,305-381`), replaced by the SDK's section.

**Diceroll keeps:** the content registry, UI visuals (banner presentation, settings toggle),
BootShell visuals, the DevGesture/DevMenu shell, and CI export, signing, notarisation and store
uploads.

## Why

[README §10](../../README.md#10-roadmap-and-effort) makes this P3's Diceroll outcome: once wire v4's
feed, the Godot updater and the storefront feeds exist, Diceroll's single-surface updater (RSA-signed
manifests on a rolling release, [notes/A4 §1](../../notes/A4-diceroll-mapping.md#1-dicerolls-current-updatedistribution-architecture))
is redundant, and several of its bugs disappear with it: beta regressing (§9.2 #4), unset floors
(#5), unchecked binary hashes (#7), no resume (#9), the failed-check throttle (#11), the freeze
attack (#13) and missing SideStore fields (#14) ([README §9.2](../../README.md#92-diceroll-for-the-diceroll-side)).

## Read first

- In the Polaris Key repo: `AGENTS.md`, `.claude/skills/authoring-pkey-manifests/SKILL.md`, and the
  hand-offs of P2-04 (`.pkey/release` v2 fields), P2b-02 (`.pkey/distribution`), P2-06 (the Action's
  inputs), P2b-05 (feed URLs) and P3-10 (the updater's signals and configuration).
- Research: [README §3.3](../../README.md#33-trust-model-two-signers-two-documents), [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative), [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet), [§5.6](../../README.md#56-code-updates-without---main-pack), [§6.1](../../README.md#61-developer-adopter); [notes/A4 §4](../../notes/A4-diceroll-mapping.md#4-what-diceroll-deletes-vs-keeps-if-pkey--a-godot-sdk-provided-this-natively), [§5](../../notes/A4-diceroll-mapping.md#5-correctness-properties-pkeys-model-must-preserve-and-current-conflicts) (properties P1–P17 and the trust-root shift).
- Diceroll: `release.yml` (`:256-349` publish job), `docs/RELEASE.md` (`:91` "never delete the
  channels release", `:150` the signing key), and D-01's signing-key list.

## Scope

**In:**

- `.pkey/release` v2: the `app` deliverable, the declared artifact map, `beta` including `stable`,
  the public release key and the trusted publisher; `.pkey/distribution`: outlets `direct`,
  `app-store`, `testflight`, `altstore`, `play`, `obtainium`, `fdroid-repo`, `steam`, `itch`, `web`
  (README §3.12 is the illustrative shape; the field names are the validators' from P2-04 and P2b-02).
- `release.yml`: `polaris-key/publish@v1` after the existing export and signing steps, the release
  key from the `release` Environment, the F-Droid index generation and signing step P2b-05 defines.
- Build stamp: the SDK export plugin's per-preset Outlet and Channel options (P1-11), overridden per
  artifact in CI through `get_or_env`, keeping D-01's one-stamp-per-artifact rule.
- Updater: the SDK's (P3-10): outlet adapters, the sidecar-PCK swap on portable Windows and Linux
  x86_64, and the boot guard (rollback after two failed boots, reported as `boot_rolled_back`).
  Diceroll connects the SDK's signals to its banner and settings toggle.
- The bridge and the key inventory (Design notes).
- Tests in Diceroll for the properties players can see: no downgrade on channel switch, rollback,
  no update activity on store, Steam and itch builds.

**Out** (and where it belongs instead):

- Sparkle on macOS and Velopack for the Windows installer need P5-07's native bridges, which are
  not a dependency. If P5-07 has landed, adopt them here; otherwise macOS and installer builds get
  the SDK's binary prompt and the gap is recorded in the PR (→ [P5-07](P5-07-desktop-plugins.md)).
- Packs (→ [D-04](D-04-diceroll-after-p4.md)); store transports, In-App Updates and IAP
  (→ [D-05](D-05-diceroll-after-p6.md)).

## Design notes

- **Trust root shift** ([notes/A4 §5.7](../../notes/A4-diceroll-mapping.md#57-trust-root-shift-important),
  [README §3.3](../../README.md#33-trust-model-two-signers-two-documents)): the Worker signs the feed
  (freshness, pointers, rollout); the CI-held release key signs release records (bytes). The Worker
  never holds the release key. It lives in a GitHub Environment secret with required reviewers
  ([README §11](../../README.md#11-decisions-needed) decision 3), and its public half is pinned in
  `res://polaris_key.tres`. The old RSA key cannot become the release key: it is a new Ed25519 key.
- **Bridge for installed clients.** Installed builds trust only the RSA key and read
  `update-<channel>.json` from the `channels` release. The last old-format manifest advertises the
  first SDK build as a BINARY update, with `pack: null` and `min_supported` set to it, so the
  prompt cannot be dismissed ([notes/A4 §1.2](../../notes/A4-diceroll-mapping.md#12-manifest-schema-1)). The old AltStore source gets a final `news` item with `notify` pointing to the new
  source URL. Keep `channels` until the human decides enough players have moved; then delete it and
  update `docs/RELEASE.md:91`.
- **Preserve the updater's properties** (notes/A4 §5, P1–P17): no downgrade, beta ⊇ stable, channel
  binding, engine gate, `min_binary`, a mandatory floor distinct from the licence's grant floor,
  hash pinning, rollback and skip, staged content dropped on channel switch, store builds never
  self-updating code, fail closed. Map each to the SDK's behaviour in the PR description.
- **Outlet capabilities** come from the outlet, not the game; the server may narrow them, never
  widen the security-relevant ones ([README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet)).
- **Key inventory:** import D-01's signing-key fingerprints into Polaris Key's key inventory (P2b-03).
  The F-Droid repo key stays in CI; Polaris Key never holds it.
- Obtainium users who track GitHub releases keep working; the Polaris Key configuration is an
  addition, not a replacement.

## Steps

1. Re-verify paths; write `.pkey/release` and `.pkey/distribution`; `pkey validate`; resync.
2. With the human: create the release key and Environment; set the trusted-publisher policy; store
   the F-Droid repo key.
3. Add the Action and feed steps to `release.yml`; switch the build stamp to the export plugin.
4. Replace `game/update/*` with the SDK updater; port the game-visible tests; delete the files listed
   in Goal.
5. Publish the bridge release through both paths; cut a tagged pre-release through the Action.
6. After the human's go-ahead, delete `channels` and `UPDATE_SIGNING_KEY`.

## Acceptance criteria

- [ ] The PR lists every deleted file, and no reference to `game/update/` remains in code, CI or docs.
- [ ] A tagged pre-release is published through the Action with no long-lived upload secret, and
      its artifacts, hashes and per-artifact stamps show correctly in the console.
- [ ] A portable Windows x86_64 and a Linux x86_64 build on the previous release update through the
      SDK, and a forced double boot failure rolls back.
- [ ] A build with the old updater sees a mandatory BINARY prompt to the SDK build.
- [ ] The AltStore/SideStore source, the F-Droid repository and the Obtainium configuration are
      served from Polaris Key URLs, and a device adds and updates from each; the old source carries
      the `news` item.
- [ ] Steam, itch and store builds make no update downloads.
- [ ] `UPDATE_SIGNING_KEY` is removed after the bridge (human-confirmed).
- [ ] Diceroll's CI is green.

## Verify

```sh
# In the Diceroll repository:
pkey validate
grep -rn "game/update" --include='*.gd' --include='*.yml' --include='*.md' . || echo "no references"
# Diceroll's test suites, as ci.yml runs them
```

## Hand-off

D-04 relies on the published app deliverable, the SDK updater and the export plugin's build stamp.
D-05 relies on the outlet configuration in `.pkey/distribution`. The lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set D-03 done` in the Polaris
Key repo when the Diceroll PR merges and the bridge release is out.
