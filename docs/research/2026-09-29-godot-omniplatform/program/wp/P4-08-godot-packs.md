# P4-08 Godot packs: `godot.pck` handler, delta bake, directory check, `PKeyBoot` pack stages

| Field       | Value                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                                                                                                                               |
| Size        | 2.75–3.25 engineer-weeks                                                                                                                                                                                                     |
| Depends on  | [P4-04](P4-04-content-corpus-v1.md), [P1-10](P1-10-godot-ui-kit.md), [P3-08](P3-08-v4-godot.md), [P3-10](P3-10-godot-updater.md), [S-05](S-05-godot-platform-mechanics.md), [P4-06](P4-06-client-core-packs.md)              |
| Unblocks    | [P4-11](P4-11-chunk-sync-sdks.md), [P4-16](P4-16-more-pack-types.md), [P4-20](P4-20-save-compat.md), [P4-24](P4-24-content-decision-godot.md), [P5-08](P5-08-platform-pack-transports.md), [D-04](D-04-diceroll-after-p4.md) |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                                                           |
| Gates       | corpus: the content corpus and `plan-matrix.json` pass on the Godot **editor and an official release template** (the delta route uses engine internals)                                                                      |
| Human input | none (Godot 4.7.2 editor and export templates are downloaded in CI, as P1-01 set up)                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                    |

Milestone: **Diceroll's content-streaming phases 1–3 run on Polaris Key** (with D-04).

## Goal

`PolarisKey.update.packs` works in the Godot SDK in pure GDScript. The addon carries a GDScript
port of the pack core (planner, full/file/delta appliers, files index, path rules, error registry,
`packSetId`, install state) that passes every content case and plan row on the editor and a release
template. A `godot.pck` handler stages, verifies (whole-pack SHA-256, engine header, directory
check), and activates at the next boot by mounting a rebuilt, CI-identical pack from a new
content-addressed path; per-entry deltas are decoded by Godot's own engine decoder and baked into a
full pack. A `files.tree` handler activates hot. Embedded baselines count as installed. `PKeyBoot`'s
FETCH, MOUNT and BACKGROUND stages drive required and optional packs with size disclosure,
cellular choice, pause and resume, and emit the pack signals.

## Why

Diceroll's six packs are `godot.pck` payloads, and moving onto Polaris Key must keep its offline,
embedded-first boot ([README §5.7](../../README.md#57-packs-at-runtime),
[§5.8](../../README.md#58-ui-kit-and-pkeyboot), [CONTENT §15](../../CONTENT.md#15-diceroll-mapping)).
notes/A6 measured every mechanism on 4.7.2 and found the rules that make it safe: rebuild a full
pack and hash it yourself (Godot never checks its own MD5s), never overwrite a mounted pack, never
leave delta overlays mounted (+2.9 ms per open, forever), check the directory instead of trusting
`replace_files` ([CONTENT §8.3](../../CONTENT.md#83-godot-measured-pure-gdscript-472)).

## Read first

- [S-07](S-07-policy-recheck.md) row 13, read in [notes/S-07-policy-recheck](../../notes/S-07-policy-recheck.md) (re-checked 2026-09-30): the data-only
  rule for packs on store builds is still the safe reading on every store: App Review 2.5.2 is
  stricter than DPLA 3.3.1(B), Play exempts interpreted code only if it cannot violate Play policy,
  and Microsoft Store 10.2.2 bans dynamic code that changes described functionality. Scripts in
  downloaded packs stay off store builds and need the `downloadedScripts` capability elsewhere.
- `AGENTS.md`; the approved `program/plans/P4-01.md` (formats, marker, `packSetId`, facet).
- [notes/A6](../../notes/A6-godot-patching.md) §2.2 (PCK rebuild), §2.4 (GDDL delta decode, the
  trailer and private-namespace bake), [§2.7](../../notes/A6-godot-patching.md#27-mount-semantics)
  (mount semantics), [§4](../../notes/A6-godot-patching.md#4-recommended-client-patch-strategy-ladder-godot)
  (the ladder and its rules), [§5](../../notes/A6-godot-patching.md#5-key-gdscript-snippets)
  (directory reader, exporter-identical writer, `gddl()`, `expose_private`), §6 (the
  `replace_files` findings), §7 (limits).
- [notes/A7 §6](../../notes/A7-xlang-content.md#6-results-by-language) (the Godot runner: 690
  lines, `patch_from(base, frame)` as a general primitive, `append_array`, unique namespaces).
- [CONTENT §4.1–§4.2](../../CONTENT.md#41-handler-contract-every-sdk), [§10](../../CONTENT.md#10-client-pipeline-every-sdk),
  [§14](../../CONTENT.md#14-experiences) (player experience); [README §5.9](../../README.md#59-editor-and-export-plugin),
  [§5.12](../../README.md#512-packaging-and-versions) (engine floor and feature gates).
- Reference code in `docs/research/2026-09-29-godot-omniplatform/prototype/`:
  `patching/runner/` (`lib.gd`, `t2_rebuild.gd`, `t4_delta_trick.gd`, `t7_semantics.gd`,
  `t9_private_bake.gd`), `content/runners/godot/content_runner.gd` (A7's 690-line runner, with
  the release-template export) and `README.md` (HTTP findings: gzip breaks `Range`,
  `download_file` truncates, redirects forward `Authorization`).
- The Godot SDK as P1-01, P1-10 and P3-08 left it: `sdks/godot/addons/polaris_key/`, `PKeyBoot`,
  the stage machine from P1-09, the corpus runner and CI job, the release-record verifier.
- [P4-06](P4-06-client-core-packs.md)'s `client-core/src/packs/` as the reference port, if merged.

## Scope

**In:**

- **Pack core in GDScript** (`addons/polaris_key/packs/`), identical in verdicts to
  `client-core`, with `patch_from(base, frame)` implemented through GDDL-wrapped delta PCKs.
- **`godot.pck` handler.** Stage into `user://pkey/staging/<planId>/`; strategies `delta`
  (private-namespace per-entry bake), `file` (type-neutral container rebuild from gaps and files),
  `full`; verify the whole-pack SHA-256 against the record, the PCK header's engine version
  (≤ running, inside `requires.engine`) and the **directory check**; commit to
  `user://pkey/store/<sha256>.pck`; activate `restart`.
- **Mounting at boot** from an autoload before first use: in `mountOrder`, one pack per frame, only
  the active set's content-addressed paths, after the directory check, with `replace_files=true`
  (S-05 §4.6: with `false` a pack's UIDs never register, and A6 §6: a delta overlay's full-file
  entries are dropped). `false` is allowed only for UID-free packs and gains nothing.
- **`files.tree` handler** (hot: `user://pkey/trees/<sha256>/` plus a pointer swap).
- **Embedded baselines**: packs shipped in the build with their markers (P4-03 writes the markers),
  found in one configured `res://` directory (proposed `res://pkey_packs/`) or listed in the build
  stamp; verify marker and hash once, then record them as installed and as delta bases.
- **Install state** at `user://pkey/content/state.json` (temp file plus rename), P4-06's machine;
  roll back to `previous` after N failed boots, sharing P3-10's boot guard if it has landed.
- **A transport interface** (how a pack's bytes arrive and how the SDK learns the installed
  version) with two v1 implementations: `pkey-cdn` (and `web`) and `embedded`.
  [P5-08](P5-08-platform-pack-transports.md) adds `apple_ba`, `play_pad` and `steam` behind it.
- **HTTP**: `Range` and `If-Range` downloads into `.part` files with resume (`HTTPClient`),
  `accept_gzip = false`, redirects followed manually without forwarding `Authorization`.
- **`PKeyBoot` stages**: FETCH (required packs, size disclosure, cellular choice, pause/resume),
  MOUNT (ordered mounts, theme swap), BACKGROUND (optional packs; corner pill), OFFLINE ("play with
  installed content"). Signals `pack_progress(id, bytes, total)`, `pack_ready(id)`,
  `pack_failed(id, err)`, `set_changed(activation)`.
- **Capabilities**: advertise `zstd-patch-from` only on engine `major.minor` versions whose GDDL
  check passes (4.6+; the list is pinned in the SDK), and never `chunk` in v1.
- **Runner**: the content corpus and `plan-matrix.json` (the paths P4-04 landed, through the
  Godot mirror) on the editor and the release template.
- `packSetId` in the device report.

**Out** (and where it belongs instead):

- Chunk sync (→ [P4-11](P4-11-chunk-sync-sdks.md)); `godot.zip`, `l10n.table`, `data.json`,
  `audio.bank`, `custom.*` handlers (→ [P4-16](P4-16-more-pack-types.md)).
- `is_available(content_id)` from `provides` (→ [P4-20](P4-20-save-compat.md)).
- Platform transports: Background Assets, PAD, Steam depots (→ P5-05, P5-06, P5-08).
- Web builds with large packs beyond the web cap below (IDBFS keeps all of `user://` in memory,
  A6 §2.6; S-05 §4.3 measured every web path holding mounted packs in JS memory).
- Export-plugin UI for choosing embedded or lean packs per preset (README §5.9). P1-11 builds only
  the build stamp and the dock, and no work package owns this yet; v1 games place embedded packs
  and their markers themselves.

## Design notes

- **Throughput for planning ([S-04](../../notes/S-04-low-end-performance.md)).** Plan chunk sync (the CPU part, output MB/s) at
  about 20 MB/s natively on an A53-class phone (range 16–30, derived) and 12 MB/s for the web
  build there (emulated), about 40 MB/s on mid-range, and 250 MB/s or more on desktop and current
  phones (measured 324–369 natively, 120–260 on desktop web). File rebuild and verified delta run
  at 0.5–0.8× that.
  - Sync payloads up to 50 MB natively, or 25 MB on web, inline at boot.
  - Above 50 MB, sync in the background with progress and keep the old content playable.
- **Never overwrite a mounted pack.** Overwriting corrupts reads (118 of 625 files correct) and can
  return another file's bytes; a same-session remount serves stale cached resources (A6 §2.7).
  Always write a new path and switch at the next boot.
- **The bake mutates the base.** The trailer appends a directory to the installed pack and
  truncates it afterwards; A6 §7 notes this was **not tested while the base was the live, mounted
  content pack**. Test exactly that case; if it misbehaves, use A6's copy-host variant for a mounted
  base. Record the base size before appending so a crash mid-bake is repairable by truncation.
- **Unique namespaces.** Mounts cannot be undone, so each staging operation uses its own private
  prefix (e.g. `__pkey/<planId>/base/`), never a path a game could load (A7 §6).
- **Verify before the decoder sees anything.** Check each delta's SHA-256 from the signed menu and
  the base's hash first; a wrong base otherwise fails only at first read (A6 §2.1).
- **Directory check** (the rule from S-05 §5 (f), verbatim, measured in S-05 §4.6): "Data packs are
  mounted with `replace_files=true`, in `mountOrder`. A `godot.pck` payload may contain only: (1)
  entries under one of the deliverable's `handler.prefixes`, including their `.remap` and `.import`
  files; (2) the `.godot/exported/…` and `.godot/imported/…` files that those `.remap` and `.import`
  files point to; and (3) `.godot/uid_cache.bin`, which is what makes the pack's `uid://`
  references resolve. Everything else is rejected with its path, in particular `project.binary`,
  `.godot/global_script_class_cache.cfg`, scripts (`.gd`, `.gdc`, `.cs`, and a `.remap` that points
  to one), native libraries and `.gdextension` files. `--export-pack` always adds `project.binary`
  and `.godot/global_script_class_cache.cfg`, even to a project with no scripts, so
  `pkey release publish --deliverable <packId>` removes exactly those two entries from a `godot.pck`
  payload before it lints, hashes and indexes it, and writes the stripped PCK back in place, so an
  embedded copy is the one its marker pins. The publish lint and the device-side directory check
  apply the same list; the directory check refuses a pack that still carries either file. `uid://`
  references into a pack are allowed once it is mounted. With `replace_files=false` a pack's UIDs
  never register, so only UID-free packs may use it." Why: mounting an unstripped pack with
  `replace_files=true` replaces the main pack's class cache (`get_global_class_list()` went from 6
  to 0); stripped, the main pack's UIDs and those of two independently built packs all resolved
  together and the class list stayed at 6. The strip step and the publish-side lint are
  [P4-03](P4-03-ci-patch-artifacts.md)'s; share its fixture PCKs so the two checks cannot drift.
  This replaces A6's "no `uid://` into packs" as the SDK rule; a game may still keep its own packs
  UID-free (Diceroll does, D-04).
- **GDScript performance.** Assemble output with `append_array` or `store_buffer` in 1 MiB steps
  (a byte loop runs at about 30 MB/s); hash with `HashingContext` (~220–240 MB/s); `decompress`
  needs the exact size, which every zstd reference carries.
- **Mount pacing** (S-05 §4.1, Android 14 emulator): the stall grows with a pack's entry count,
  not its size (about 16 µs per entry cold from `user://`, 4 µs warm; a 200 MB pack of 8 files
  mounts in ≤ 8 ms). Mount after the first frame, one pack per frame, on the main thread, because
  `PackedData` and the UID registry are not documented as thread-safe while the main thread loads
  resources (a `Thread` mount lowered the worst frame but did not remove it on the contended
  emulator, so the thread evidence is inconclusive). A mount in `_ready` held the first `_process`
  back by 88–276 ms, about its own call time.
  A mount freezes the spinner for the whole call, so the budget is at most 100 ms (6 frames at
  60 Hz) per mount on a low-end phone assumed 3–5× slower than the emulator: packs of up to 1,000
  entries (an estimated 48–80 ms) may mount while the spinner runs; larger ones only under a loading
  screen. The pack lint ([P4-03](P4-03-ci-patch-artifacts.md)) warns above 1,000 entries per pack
  and fails above 20,000; the directory check logs the entry count. The low-end
  phone run is still outstanding; replace the numbers when it lands.
- **Web pack path** (S-05 §4.3): packs never go to `user://`. The HTML shell (or a head include)
  fetches each pack by its content-addressed URL through the Cache Storage API, copies it into a
  MEMFS path outside `user://` (`/pkey/packs/<sha256>.pck`) with the engine's `copyToFS`, and
  GDScript mounts that path; a Cache Storage miss is a normal re-download. This path persisted
  across reload and browser restart in Chromium, WebKit and iOS Simulator Safari; its warm boots
  (engine ready plus fetch, 150 MB, n = 1 per cell) were 2.9–3.7 s in Chromium, 1.1–1.3 s in
  WebKit and 0.68–0.77 s on the iOS Simulator. Keeping packs in `user://` booted faster in Chromium
  (0.4–0.5 s) but loads every file there, mounted or not, into memory at each boot, which is why it
  is not the path. Do not use `HTTPRequest.download_file` on web: in 4.7.2 the file is deleted
  after a "successful" download. Cap the total mounted pack bytes on web (default 150 MB on mobile
  browsers, 300 MB on desktop) until device numbers exist, and mount packs one at a time (inferred,
  not measured: S-05 never tried concurrent copies). On the iOS Simulator a single load's
  footprint rose by up to about twice the mounted bytes at 1 and 3 packs (probably the transient
  copy; inferred, not measured), against 46–95% at the 150 MB cap; that ~2x was itself observed
  with packs fetched, copied and mounted one at a time, so leave headroom for that transient.

## Steps

1. Port the pack core; pass the corpus on the editor, then on the release template.
2. `godot.pck` staging with `full` and `file`, verification and the directory check.
3. The delta bake (trailer and private namespace), including the mounted-base test.
4. Install state, boot-time mounting, rollback; `files.tree`; embedded baselines.
5. HTTP downloads with resume; `PKeyBoot` stages and signals; capabilities; telemetry.
6. Docs (`build/sdks/godot`), registry manifest.

## Acceptance criteria

- [x] Every content case and plan row passes on the Godot 4.7.2 editor and the official
      `linux_release` template in CI. (Locally: the 4.7.2 editor and the official macOS release
      template; CI's `godot` job runs the same `run_tests.sh` on `linux_release`. The 4.4.1 floor
      passes too, with the delta decode cases held to fail closed.)
- [x] A v1→v2 `godot.pck` update by `delta`, by `file` and by `full` each produces a pack whose
      SHA-256 equals CI's, mounted at the next boot from `user://pkey/store/<sha256>.pck`.
      (`engine` group: the payload delta and the files delta separately.)
- [x] The bake over a base that is currently mounted leaves the running session's reads correct
      and restores the base byte for byte (SHA-256 re-checked). (`bake` group.)
- [x] The directory check refuses a pack with a script, `project.binary`,
      `.godot/global_script_class_cache.cfg` or an out-of-prefix path before mounting, and admits
      a stripped `--export-pack` pack (in-prefix `.remap`/`.import` files, the `.godot/exported/`
      and `.godot/imported/` files they name, `.godot/uid_cache.bin`); a tampered unpatched entry
      fails the whole-pack hash.
- [x] Two independently built, stripped packs mounted with `replace_files=true` resolve their own
      and the main pack's `uid://` references, and `get_global_class_list()` is unchanged (S-05
      §4.6's `f_uid` case, on the release template).
- [x] After two failed boots with a new set, `previous` is active again and a report says so.
- [x] `PKeyBoot` with a missing required pack goes FETCH → MOUNT → READY with size disclosure,
      and offline with the required set present goes to READY; the four signals fire in order.
- [x] The green gate passes (plus the Godot CI job).
- [x] The Godot `parity.json` marks the v1 pack features implemented (once P1b-01 has landed).

## Verify

```sh
# From the Godot CI job P1-01 set up; exact paths follow that job.
godot --headless --path sdks/godot --import
godot --headless --path sdks/godot -- --pkey-test content,plan   # templates ignore --script
# and the same suites through the exported runner on the linux_release template
```

## Hand-off

D-04 moves Diceroll's packs onto this facet (keeping `packs.gd`, `needs.gd` and
`Content.available()` reading `PolarisKey.update.packs` state). P4-11 adds chunk sync beside the
existing appliers; P4-16 adds more handler types; P4-20 adds `is_available`; P5-08 adds platform
transports behind the transport interface. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-08 done`.

## Plan amendments (P4-01)

The approved [`plans/P4-01.md`](../plans/P4-01.md) changes this package; its §8.4 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from implementation

- **The container index after a `full` install.** client-core's engine keeps a files index only
  for trees and for installs planned from seeds, so a container installed by `full` (or embedded)
  has no files, and its next release can only come by a payload delta or `full`. Godot's storage
  derives a `godot.pck`'s files from its own PCK directory (each entry hashed once, from the
  payload whose SHA-256 was verified at load, kept beside it as `store/<sha256>.files.json`), so
  `file` and a `files` delta work after any install. Node and React keep the reference behaviour;
  whether client-core should keep the target index at commit is a follow-up.
- **A restart pack fetched at boot mounts at this boot.** `fetch.done.installed` counts the running
  set, and a `godot.pck` is `restart`, so a required pack fetched in FETCH would never count.
  `PKeyGodotPckHandler.can_activate_now` lets a commit (or a guard rollback) join this boot while
  its id has not been mounted in this process; a later commit activates at the next boot, from its
  new path, as the brief requires.
- **The delta bake.** Prefix decodes are batched: every frame of a `files` set goes through one
  mount pair (a private namespace per batch). A prefix inside an installed store pack is exposed by
  A6's trailer (journalled for crash repair, truncated back and length-checked); anything else,
  including a tree's live files and an embedded `res://` pack, is copied into a helper host pack.
  The trailer over the **mounted** base was tested (`bake` group, editor and release template): the
  running session's reads are unchanged and the base comes back byte for byte, so A6's copy-host
  fallback was not needed for it.
- **Engine floor.** 4.4.1 has no `PACK_FILE_DELTA` and writes PCK v2, so `zstd-patch-from` is
  advertised only on `PATCH_FROM_ENGINES` (4.6, 4.7) after a start-up probe. On 4.4 the corpus's
  delta cases are held to their own verdict or a closed `delta-apply-failed`, and the kaykit update
  cases meet `pck-engine-mismatch` (a 4.7.2 pack) before anything commits.
- **The 4.4.1 exporter's `uid_cache.bin`** names the whole project's UIDs, excluded files included
  (4.7.2 names only what it exports). Mounted with `replace_files=true`, such a pack re-points a UID
  it shares with the main project. The f_uid case passes in full on 4.7.2 (editor and template);
  on 4.4.1 the suite pins the measured behaviour. After review (N6) the device check and the lint
  both refuse a `uid_cache.bin` entry naming a path outside the pack, so such a 4.4.1 pack is now
  `pck-directory-refused` at `.godot/uid_cache.bin`; the suite still mounts it unchecked to keep
  measuring why.
- **The header check** adds a device-only rule to the lint's `requires.engine`: a pack built by a
  newer engine than the running one is `pck-engine-mismatch`.
- **Shared fixtures.** `packages/cli/test/godotFixtures.test.ts` writes P4-03's fixture PCKs and
  `lintPck`'s verdicts (`sdks/godot/tests/fixtures/packs/check/`) and the kaykit v1→v2 objects
  (`update/`); the PCKs and verdicts are byte-compared, the zstd objects held to what they decode
  to. The device check's lines equal the lint's exactly.
- **The install state** gains one Godot member, `confirmed` (pack id → the record SHA-256 running
  at the last confirmed launch): the shared boot guard counts while an active install differs from
  it and rolls those packs back to `previous` with the binary. A packs-only rollback needs no
  restart (GUARD runs before MOUNT) and reports `rolled-back`.
- **PKeyBoot.** The host gained `fetch_with(required, send, opts)` (FETCH's intermediate events),
  `mount(required)` (a required pack that cannot mount is `fail`), `boot_options()`,
  `background_packs()` and `background(ids)`. The consent card is part of the boot view; the
  `theme` option applies a pack's Theme after MOUNT; BACKGROUND keeps the boot view alive as a
  transparent, input-free corner pill. `boot_fetch` sends `fetch.progress {0, 0}` when nothing is
  missing, as client-core's `runBootFetch` does.
- **Godot cannot stream a zstd decode** (`decompress` needs the whole frame), so `apply_full` is
  buffered and `PKeyPacks.one_shot_budget` may drop a `full` too large for the device.
- **Web.** The Cache Storage shell (S-05 §4.3) is not built: on web the mount cap applies and
  `PKeyPacks.root` may be a MEMFS path (`/pkey`), so packs re-download after a reload. A follow-up.
- **P4-10.** P4-10 has not landed (content corpus and plan matrix are still version 1), so
  `plan_target`'s chunk rule and the chunk sections stay with it (its §8.5).
- **Review round (B1–B4, N1–N6).** The review made downloaded GDScript run on 4.7.2 and 4.4.1
  through two holes the CLI lint shared, now closed on both sides with permanent fixtures:
  (B1) Godot simplifies pack paths at mount, so `packs/a/../../x` and `packs/a/evil.gd/.` escaped
  the prefix or the extension rule. `PKeyPck.path_ok` and the CLI's `pckPathOk` refuse any path
  that is not already normal, and duplicates, in the reader (`path-dotdot`, `path-trailing-dot`,
  `path-dot-segment`). (B2) the binary loader takes `.material`, `.mesh`, `.anim`…, so resources
  are judged by content: an `RSRC` head gets the binary scan, a `[gd_scene`/`[gd_resource` head the
  text scan, `RSCC` is refused under any name (`content-binary-extensions`), and `files.tree`
  outputs get the same scan (N5, `PKeyPck.tree_check`). (B3) a packs-only rollback re-fetched the
  same record on the next FETCH and looped. The install state gains `held` (pack id → {record SHA,
  count}); a held record is not planned or fetched until the stamp pins another (committing a different
  release clears the hold; re-review), the restored
  install counts as active, and `ensure` fails with the new code `pack-rolled-back`. (B4)
  THREAT-MODEL.md gains "Pack bytes on the device (P4-08)". N1: `on_bake` returns bool and a
  journal that cannot be written uses a copy host. N2/N3: the bake journal is a list naming only
  `store/<64 hex>.pck`. N4: a 403 from the blob route is `pack-not-entitled`. N6: `.remap`/`.import`
  targets and uid cache entries must be in the pack (`remap-outside-pack`,
  `uid-cache-outside-pack`).
