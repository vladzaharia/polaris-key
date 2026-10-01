# S-05 Spike: Godot platform mechanics (Android pack stall, PAD paths, web multi-pack, MSIX `user://`, Velopack hooks)

| Field       | Value                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                                                                           |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                |
| Depends on  | none                                                                                                                                                                                                                |
| Unblocks    | [P3-10](P3-10-godot-updater.md), [P4-08](P4-08-godot-packs.md), [P5-06](P5-06-kotlin-aar.md), [P5-07](P5-07-desktop-plugins.md)                                                                                     |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                                  |
| Gates       | none beyond `pnpm format` on the files it adds                                                                                                                                                                      |
| Human input | none in the graph. Needed in practice: an Android phone (the low-end one from S-04 if possible), a Windows 10/11 machine where a self-signed certificate may be trusted, and a Mac or iPhone for the Safari web run |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                           |

## Goal

A research note, `notes/S-05-godot-platform-mechanics.md`, answers six engine-level questions on
Godot 4.7.x official templates, each with a measured answer and the design consequence:

- **(a)** How long does `ProjectSettings.load_resource_pack` block the UI on Android, as a function
  of pack size and entry count (godotengine/godot#105009)?
- **(b)** Can a pack delivered by Play Asset Delivery be mounted from its absolute path?
- **(c)** How do several packs behave in a web export: memory, boot time, persistence?
- **(d)** Where does `user://` live inside a full-trust MSIX package, and is the install directory
  writable?
- **(e)** Can Godot survive Velopack's lifecycle hooks, or is a launcher shim required?
- **(f)** Do UIDs from the main pack and several independently built data packs all resolve when
  mounted in order, and does a pack carrying a class cache wipe `class_name` globals?

## Why

[README §12](../../README.md#12-risks-and-open-questions) lists these as unverified platform
mechanics to spike before committing, and [CONTENT §17](../../CONTENT.md#17-open-questions-and-spikes)
Q5 repeats (a) and (c). Each answer changes a design already written down:

- `PKeyBoot`'s MOUNT stage mounts "one pack per frame" because of the Android stall
  ([README §5.7](../../README.md#57-packs-at-runtime), [§5.8](../../README.md#58-ui-kit-and-pkeyboot));
  the budget per frame is unknown (P1-10, P4-08).
- The Kotlin AAR mounts PAD packs from `getPackLocation(...).assetsPath()`; absolute-path loading
  was not verified ([notes/E2 §A3](../../notes/E2-android.md#a3-play-asset-delivery-pad-play-feature-delivery-and-godot-4),
  [§G](../../notes/E2-android.md#g-open--unverified-items-spot-check-before-building)) (P5-06, P5-08).
- Web packs should stay out of `user://`, which is held in memory, but this was read from source,
  not run ([notes/A6 §2.6](../../notes/A6-godot-patching.md#26-web-source-level-not-run)) (P4-08).
- MSIX `user://` virtualisation is flagged "needs a spike"
  ([notes/E3 §A1](../../notes/E3-windows-linux-web.md#a1-microsoft-store)); the sidecar-PCK swap needs
  a writable install directory ([README §5.6](../../README.md#56-code-updates-without---main-pack))
  (P3-10, P5-07).
- Velopack re-launches the main executable with `--veloapp-*` hook arguments and kills it if it
  does not exit in time; notes/E3 recommends a native launcher but did not test Godot
  ([notes/E3 §A3](../../notes/E3-windows-linux-web.md#a3-classic-installer--portable--self-update-frameworks))
  (P3-10, P5-07).
- A6 showed pack UIDs register only with `replace_files=true`
  ([notes/A6 §2.7](../../notes/A6-godot-patching.md#27-mount-semantics)), and Diceroll's own experiment
  saw `class_name` globals drop from 180 to 0 when an export pack that dragged in autoload scripts
  and caches was mounted with `replace_files=true`
  ([notes/A4 §2.4](../../notes/A4-diceroll-mapping.md#24-building-and-mounting-52)). The directory
  check in P4-08 needs the exact rule.

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [README §5.6](../../README.md#56-code-updates-without---main-pack), [§5.7](../../README.md#57-packs-at-runtime), [§5.8](../../README.md#58-ui-kit-and-pkeyboot), [§12](../../README.md#12-risks-and-open-questions).
- [notes/A6 §2.6–§2.7](../../notes/A6-godot-patching.md#26-web-source-level-not-run) and [§7](../../notes/A6-godot-patching.md#7-what-could-not-be-re-run-and-limits).
- [notes/E4 §5](../../notes/E4-godot-ecosystem.md#5-runtime-content-loading), [§6](../../notes/E4-godot-ecosystem.md#6-self-update-of-the-main-packbinary) and [§9.5](../../notes/E4-godot-ecosystem.md#95-spikes-to-run-before-committing-ordered-by-risk) (spikes 2–4).
- [notes/E2 §A3](../../notes/E2-android.md#a3-play-asset-delivery-pad-play-feature-delivery-and-godot-4); [notes/E3 §A1](../../notes/E3-windows-linux-web.md#a1-microsoft-store), [§A3](../../notes/E3-windows-linux-web.md#a3-classic-installer--portable--self-update-frameworks), [§C1](../../notes/E3-windows-linux-web.md#c1-godot-4x-web-export-requirements-43--47).
- Code to reuse: `prototype/patching/` (`tools/gen_project.py` and `make_v2.py` build realistic
  data packs, `tools/pck.py` reads and writes PCKs, `runner/t7_semantics.gd`, `t7c_uid.gd` and
  `t7d_uid_rep.gd` are the mount and UID probes, `tplrun.sh` runs a probe on the release template).

## Scope

**In** (in this order; stop at the time box and report what is left):

1. **(a) Android stall.** Release APK on the phone; data-only packs of 5, 50 and 200 MB, and a
   many-small-files pack against a few-large-files pack of equal size; mounted from `user://` and
   from `res://` (APK assets). Measure the call's main-thread time and frame hitches with a
   spinner, on first launch and warm; try mounting after the first frame and from a `Thread` (and
   record whether that is safe).
2. **(e) Velopack hooks.** `vpk pack` on Windows with (1) the Godot executable as `--mainExe`: do
   `--veloapp-install|obsolete|updated|uninstall` reach `OS.get_cmdline_args()` on a 4.6+ template,
   can an autoload exit before a window appears and within 30/15/15/30 s, how long it takes; then
   (2) a tiny launcher (Rust `velopack` crate or the C++ library) that runs
   `VelopackApp::Build().Run()` and then starts Godot. Confirm an update applies end to end and that
   a sidecar `.pck` in the package directory survives it.
3. **(c) Web multi-pack.** Single-threaded web export over HTTPS; mount 1, 3 and 6 packs totalling
   50–150 MB via (i) `HTTPRequest` into `user://`, and (ii) page JavaScript writing into a non-`user://`
   in-memory path through `JavaScriptBridge`, then `load_resource_pack` on that path. Measure memory,
   boot time with N packs installed, persistence across reload and in a private window, in Chrome,
   Firefox and Safari (including the point at which iOS Safari reloads the page).
4. **(d) MSIX.** Wrap a Windows export (executable plus sidecar `.pck`) as a full-trust MSIX with
   `makeappx` and a self-signed certificate; record `OS.get_user_data_dir()`, where writes really
   land, persistence across a package update, cleanup on uninstall, writability of the install
   directory, and `OS.get_executable_path()` (a detection hint for S-06 and P3-11).
5. **(b) PAD paths.** An AAB with Godot's install-time pack plus a fast-follow or on-demand pack
   fetched through a minimal Kotlin plugin (`com.google.android.play:asset-delivery:2.3.0`);
   `bundletool build-apks --local-testing`; mount `assetsPath() + "/<name>.pck"`.
6. **(f) UIDs and class cache.** Two data packs built independently, each with its own
   `.godot/uid_cache.bin`, mounted in order with `replace_files=true`: do `uid://` references into
   the main pack and both packs resolve? Then a pack that carries
   `.godot/global_script_class_cache.cfg`: confirm the loss of `class_name` globals.

**Out** (and where it belongs instead):

- Building any of this into the SDK: mount pacing and the directory check (→ P4-08), Velopack and
  MSIX handling (→ P3-10, P5-07), PAD (→ P5-06, P5-08), boot stages (→ P1-10).
- Outlet signals beyond the MSIX path hint (→ S-06).

## Design notes

- Official 4.6+ templates ignore `--path`, `--script` and `--main-pack` (godotengine/godot#111909),
  so run probes as exported projects with `application/run/main_loop_type`, as
  `prototype/patching/tplrun.sh` does.
- Packs must be data-only (no `.gd`) except in (f), where the class-cache pack is the negative case.
- Never overwrite a mounted pack; mount new payloads at new paths (A6 §2.7).
- Record the engine version, template, device or OS build, and whether each number is cold or warm.

## Steps

1. Set up `prototype/platform-mechanics/` with one exported probe project per item, driven by
   `application/run/main_loop_type`, and a README that records the device, OS and template.
2. Run the items in the order listed under Scope, (a) first. Record cold and warm numbers, and stop
   at the time box.
3. Write `notes/S-05-godot-platform-mechanics.md`. Each item ends with the rule the named brief
   should adopt.
4. Copy those rules into the affected briefs (P1-10, P3-10, P4-08, P5-06, P5-07, P5-08), or list
   them in the report for the lead.

## Acceptance criteria

- [ ] `notes/S-05-godot-platform-mechanics.md` exists with the provenance blockquote, question,
      short answer per item, method, environment, results, recommendation, affected briefs and
      sources, with evidence tags; items not reached are listed as open, with the reason.
- [ ] (a) gives stall time against size and entry count, and a per-frame mount budget for the
      low-end phone.
- [ ] (e) says whether a launcher shim is required, with the measured hook timings.
- [ ] (c) gives memory and boot time per pack count and browser, and recommends a web pack path.
- [ ] (d) gives the real `user://` location and the install-directory writability, and says whether
      P3-10 must disable the sidecar swap under MSIX.
- [ ] (b) and (f) each end with a rule the named brief can adopt verbatim.
- [ ] `prototype/platform-mechanics/` holds the probes with a README; generated packs are git-ignored.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
# Desktop control run of the mount probes before the device runs:
# (set up the Godot binary, templates and test packs as prototype/patching/README.md describes)
# tplrun.sh uses the Linux templates; on a macOS host run the macOS equivalent instead:
( cd docs/research/2026-09-29-godot-omniplatform/prototype/patching && ./tplrun.sh release T7Semantics newpath )
( cd docs/research/2026-09-29-godot-omniplatform/prototype/platform-mechanics && ./f_uid/run_f.sh )  # macOS, via tplrun_mac.sh
```

## Hand-off

P4-08 and P1-10 take the mount budget, the web pack path and the UID and class-cache rule for the
directory check. P3-10 and P5-07 take the Velopack decision and the MSIX behaviour. P5-06 and
P5-08 take the PAD mounting rule. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-05 done`.
