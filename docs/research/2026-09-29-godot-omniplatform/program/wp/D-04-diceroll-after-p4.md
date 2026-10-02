# D-04 Diceroll: packs as release deliverables, with `PKeyBoot` driving the boot shell

| Field       | Value                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | D: Diceroll adoption (vladzaharia/diceroll); stage "After P4"                                                                                                                             |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                      |
| Depends on  | [P4-08](P4-08-godot-packs.md), [P4-12](P4-12-compat-resolution.md), [P4-03](P4-03-ci-patch-artifacts.md), [P4-05](P4-05-pack-transports-cdn.md), [P4-24](P4-24-content-decision-godot.md) |
| Unblocks    | none                                                                                                                                                                                      |
| Role        | `pkey-godot-engineer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                        |
| Gates       | `pkey validate` clean; the publish-time checks P4-12 adds (dry run first); Diceroll's CI including its asset rules                                                                        |
| Human input | none                                                                                                                                                                                      |
| Repo        | `vladzaharia/diceroll`                                                                                                                                                                    |

> **Re-verify first.** Diceroll paths below come from [notes/A4](../../notes/A4-diceroll-mapping.md)
> (Diceroll `4e78bb6`, 2026-09-29), including its summary of Diceroll's own content-streaming
> design (`docs/design/2026-09-29-content-streaming.md`), plus what D-01 to D-03 changed. This
> brief was written without access to the Diceroll repository; confirm each path, and what of the
> design has been built since, before changing or deleting anything.

## Goal

Diceroll's content ships as **pack deliverables**: declared in `.pkey/release`, built and published
by CI, delivered by distribution (`pkey-cdn` and `embedded`), planned and mounted by the Godot SDK.
`PKeyBoot` runs the boot sequence and Diceroll's BootShell visuals plug into its signals. A
`compatible` pack release (for example a `diceroll.foes` fix) reaches direct and web players
without an app release.

**Diceroll deletes at this step** ([README §13](../../README.md#13-diceroll-adoption-path)): the pack
store and mount plumbing. notes/A4 found none of it built at `4e78bb6`, so delete whatever exists
by now (for example a `ContentPacks.mount()`, a `user://packs/` store, manifest schema-2 pack
fields, pack download code) and do not build it.

**Diceroll keeps:** `game/content/packs.gd`, `game/content/needs.gd`, `Content.available()` and
`Content.missing()` gating, the save-compatibility rules, the asset rules and their tests (no
`uid://` or `preload` into `assets/**`), BootShell visuals, the DevGesture/DevMenu shell,
`tools/ci/assets.py` and AssetCheck ([notes/A4 §4.2](../../notes/A4-diceroll-mapping.md#42-stays-game-side)).

## Why

Diceroll's own design splits its ~73 MB content into staged packs so that updates shrink from
~73 MB to ~5 MB and web reaches the title sooner ([notes/A4 §2](../../notes/A4-diceroll-mapping.md#2-the-proposed-content-pack-design-not-implemented)).
Polaris Key P4 provides exactly that as release deliverables ([CONTENT §15](../../CONTENT.md#15-diceroll-mapping),
[§6.8](../../CONTENT.md#68-diceroll-worked-through)), so Diceroll adopts it instead of building its
own. It also fixes two open player bugs: turning Auto-update off reverts content (§9.2 #10) and the
S3TC-only pack is applied on arm64 Linux (§9.2 #12) ([README §9.2](../../README.md#92-diceroll-for-the-diceroll-side)).

## Read first

- In the Polaris Key repo: `AGENTS.md`; the hand-offs of P4-02 and P4-12 (field names for
  deliverables, bindings, holds, floors, the dry run), P4-03 (`pkey release publish --deliverable`
  and the pack lint), P4-05 (byte route and embedded transport) and P4-08 (`PolarisKey.update.packs`,
  `PKeyBoot` stages and signals, the directory check).
- Research: [CONTENT §6](../../CONTENT.md#6-app--pack-relationships-binding-compatibility-and-lifecycle), [§15](../../CONTENT.md#15-diceroll-mapping); [README §3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative), [§5.7](../../README.md#57-packs-at-runtime), [§5.8](../../README.md#58-ui-kit-and-pkeyboot); [notes/A4 §2.3–§2.7](../../notes/A4-diceroll-mapping.md#23-pack-taxonomy-and-stages-51); S-05's note (Android mount budget, web pack path), if it exists.
- Diceroll: `game/content/`, `game/boot/` (`MissingAssetsScreen`, `asset_check.gd`), `main.gd`,
  `export_presets.cfg`, `tools/ci/assets.py`, the content-streaming design document.

## Scope

**In:**

- **Deliverables** in `.pkey/release`, following CONTENT §15 (types `godot.pck`):
  - `diceroll.ui`: `pinned`, required, `mountOrder` 1;
  - `diceroll.core3d`, `diceroll.foes`, `diceroll.nature`: `compatible`, required, with embedded
    baselines;
  - `diceroll.audio` (prefetch) and `diceroll.extra` (on demand): `compatible`, optional;
  - texture variants `s3tc` and `etc2`/`astc` where textures differ (this fixes §9.2 #12);
  - `contentApi: 1` on the app deliverable from the first release that declares packs (the README
    sketch's `3` is illustrative).
- **CI:** a pack builder (the design's PCKPacker approach: data only, no `uid_cache.bin`, no class
  cache), `pkey release publish --deliverable <packId>` per changed pack, and the dry run of
  P4-12's publish checks before any real publish.
- **Builds:** store builds (App Store, Play, Steam) embed the baseline of every required pack; direct
  and web builds stay lean and fetch through `pkey-cdn`. Transports stay `embedded` and `pkey-cdn`
  in this step.
- **Game:** `PKeyBoot` as the boot scene, with BootShell's visuals connected to its stage signals
  (the design's `SHELL` → `VERIFY` → `FETCH` → `MOUNT_*` → `READY` states map onto `PKeyBoot`'s
  stages);
  `Content.available()` and `Content.missing()` read `PolarisKey.update.packs` state through
  `needs.gd`; route prefetch ("Downloading Magma Depths (6 MB)…") uses `PolarisKey.update.packs.ensure`.
- The Auto-update setting maps to "no background downloads" and never stops mounting installed
  packs (fixes §9.2 #10).

**Out** (and where it belongs instead):

- Background Assets, Play Asset Delivery and Steam depots as transports (→ [D-05](D-05-diceroll-after-p6.md), P5-08).
- Chunk sync, if P4-11 has not landed (use it if it has); content-interface checks and
  `is_available(content_id)` from `provides` (→ P4-20).
- Localisation, event and supporter packs (→ P4-16, P4-19, and D-05 for paid packs).

## Design notes

- **Bindings.** `pinned` for content wired to code; `compatible` for content that should update
  between app releases; bump `contentApi` whenever code expects a new content shape, and make each
  pack's major track it (foes 1.x ↔ `contentApi` 1) ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications)).
- **Play narrows bindings.** With Play Asset Delivery, or packs embedded in the AAB, a compatible
  pack is effectively pinned on Play unless routed through `pkey-cdn` ([CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet)).
- **Data only.** Packs carry no scripts, `project.binary` or class cache; P4-03 strips the two
  engine files and lints at publish, and P4-08's directory check refuses at mount (S-05 §5 (f)). `replace_files` is not a security boundary.
- **Mounting** follows P4-08: `mountOrder`, one pack per frame (the Android stall), new
  content-addressed paths, and `replace_files=true` after the directory check (S-05 §5 (f)).
  Diceroll's rule of no `uid://` into `assets/**` stays a game choice; its PCKPacker packs carry no
  `uid_cache.bin`, so they are UID-free either way.
- **Engine bumps** invalidate every `godot.pck` pack; the publish check fails an app release on a new
  engine until matching pack releases exist ([CONTENT §6.8](../../CONTENT.md#68-diceroll-worked-through)).
- **Saves** reference content ids, never paths; never delete or migrate a save for a missing pack.
- **Web:** keep packs out of `user://`, which is held in memory; use P4-08's web pack path (Cache
  Storage API into a non-`user://` MEMFS path, S-05 §4.3) and its web size cap
  ([README §5.7](../../README.md#57-packs-at-runtime)).

## Steps

1. Re-verify paths; inventory any pack plumbing built since `4e78bb6`.
2. Declare the deliverables; `pkey validate`; resync; run P4-12's dry run.
3. Build the pack builder and CI publish steps; publish one pre-release of every pack.
4. Switch the boot to `PKeyBoot`; connect BootShell visuals; move `Content.available()` onto SDK state.
5. Delete the old plumbing; run the asset-rule tests and boot-stage screenshots.
6. Publish a `compatible` fix to one pack and watch a direct build pick it up.

## Acceptance criteria

- [ ] Every pack has a published release record; the app release pins `diceroll.ui` and declares
      `contentApi`; P4-12's dry run and publish checks pass.
- [ ] A store build with the network off boots to READY using embedded baselines.
- [ ] A lean direct build fetches the required set with size disclosure, then mounts it at the next
      boot; a Linux arm64 build gets the `etc2`/`astc` variant.
- [ ] A new `compatible` `diceroll.foes` release reaches a direct build without an app release.
- [ ] `Content.available()` is correct with an optional pack missing; saves load with it missing.
- [ ] Turning Auto-update off stops downloads but keeps installed packs mounted.
- [ ] The PR lists deleted plumbing (or states none existed); Diceroll's CI is green.

## Verify

```sh
# In the Diceroll repository:
pkey validate
# P4-03's dry run (lint, objects, bytes per strategy); P4-12's publish checks run on the real publish:
pkey release publish --deliverable diceroll.foes --dry-run
pkey release publish --deliverable app --dry-run   # contentApi, pins, embeds
# Diceroll's test suites and boot-stage screenshot scenarios, as ci.yml runs them
```

## Hand-off

D-05 relies on the pack deliverables and their `contentApi` levels, which it routes through
`apple-ba`, `play-pad` and `steam-depot`. The lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set D-04 done` in the Polaris
Key repo when the Diceroll PR merges.

## Plan amendments (P4-13)

The approved [`plans/P4-13.md`](../plans/P4-13.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.
