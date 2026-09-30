# D-01 Diceroll: fix updater issues that need no Polaris Key changes

| Field       | Value                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | D: Diceroll adoption (vladzaharia/diceroll); stage "Now", before any Polaris Key change                                                                                                                                                                     |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                        |
| Depends on  | none                                                                                                                                                                                                                                                        |
| Unblocks    | none                                                                                                                                                                                                                                                        |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                          |
| Gates       | Diceroll's CI (`ci.yml`: tests including the updater suites, `tools/ci/selftest.sh`, export smoke) and one tagged pre-release through `release.yml`                                                                                                         |
| Human input | Android developer verification registration. Also needed, not in the graph: the App Store Apple ID for the real listing URL (if the app exists), the release keystore in CI secrets, and access to Windows, Linux and macOS machines to run exported builds |
| Repo        | `vladzaharia/diceroll`                                                                                                                                                                                                                                      |

> **Re-verify first.** Every Diceroll path and line below comes from
> [notes/A4](../../notes/A4-diceroll-mapping.md), read at Diceroll commit `4e78bb6` on 2026-09-29.
> This brief was written without access to the Diceroll repository. Open each cited file and
> confirm the line before changing it; if the code has moved on, follow the code and say so in the PR.

## Goal

Diceroll's shipped builds stop misbehaving in the four ways
[README §9.2](../../README.md#92-diceroll-for-the-diceroll-side) items 1, 2, 3 and 8 describe; every
exported artifact carries the stamp of the outlet it is uploaded to; and `gg.vlad.diceroll`, with
every key that signs a shipping APK or AAB, is registered for Android developer verification. No
Polaris Key code or service is involved. **Diceroll deletes nothing at this step.**

## Why

- **#1:** the updater relaunches with `--main-pack` (`game/update/updater.gd:313`), which official
  Godot 4.6+ templates ignore (godotengine/godot#111909). Staged code packs most likely never
  apply on shipped desktop builds, and the updater may churn `boot_attempts`
  ([README §0.4](../../README.md#04-findings-that-should-change-plans-now) item 1).
- **#2:** Steam and itch upload the `github`-stamped zips (`release.yml:403-461`), so the updater is
  live inside those installs, contrary to `docs/RELEASE.md:107-108`.
- **#3:** the sideload APK is stamped `play` and the sideload IPA `appstore` (`release.yml:185,246`);
  the iOS listing URL is a placeholder, `id0000000000` (`tools/ci/update_manifest.py:32`).
- **#8:** `DICEROLL_UPDATE_TOKEN` is sent on every request and up to 10 redirects are followed
  (`update_fetcher.gd:142,157,186`). Godot 4.7.2's `HTTPRequest` forwards `Authorization` across
  hosts (measured by `prototype/tests/http_probe.gd`; [prototype/README.md](../../prototype/README.md)).
- **Developer verification:** enforcement began on 2026-09-30 for participating stores in four
  countries and goes global in 2027; an unregistered package or key then cannot install or update,
  and a lost key cannot be registered ([notes/E2 §B1](../../notes/E2-android.md#b1-android-developer-verification-status-at-2026-09-29)).

## Read first

- Diceroll: `docs/RELEASE.md`; `.github/workflows/release.yml` and `ci.yml`; `tools/ci/stamp_version.py`,
  `tools/export.sh`, `tools/ci/ios_build.sh`, `tools/ci/update_manifest.py`; `game/update/*.gd`;
  `tests/test_update_*.gd`; `export_presets.cfg`.
- Research: [README §9.2](../../README.md#92-diceroll-for-the-diceroll-side), [§13](../../README.md#13-diceroll-adoption-path), [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet) (build stamp), [§5.6](../../README.md#56-code-updates-without---main-pack) (replacements for `--main-pack`), [§4.2](../../README.md#42-android) (direct APK row).
- [notes/A4 §1.4–§1.8](../../notes/A4-diceroll-mapping.md#14-check-cadence-and-gating), [§1.11](../../notes/A4-diceroll-mapping.md#111-release-workflow--jobs-and-every-store-upload-path), [§1.13](../../notes/A4-diceroll-mapping.md#113-export-presets-that-matter), [§7](../../notes/A4-diceroll-mapping.md#7-diceroll-findings-worth-fixing-regardless-of-pkey); [notes/A6 §2.7](../../notes/A6-godot-patching.md#27-mount-semantics); [notes/E2 §B1](../../notes/E2-android.md#b1-android-developer-verification-status-at-2026-09-29).
- S-07's note, if it exists, for the current developer-verification facts.

## Scope

**In:**

1. **#1, verify then fix.** On exported release builds for Windows x86_64, Linux x86_64, Linux arm64
   and macOS, record whether a staged pack applies and how `boot_attempts` in
   `user://updates/state.cfg` moves. Then:
   - detect a relaunch that did not take: the relaunched process has `--diceroll-pack=<ver>`
     (`updater.gd:328-347`) but its running `build_info.version` (`updater.gd:148-149`) is not
     `<ver>`. Stop relaunching, do not count it as a boot attempt, and offer BINARY instead;
   - on Windows x86_64 and Linux x86_64 portable builds, replace the relaunch with a **sidecar-PCK
     swap**: verify the staged pack, keep the current `<exe-name>.pck` as `previous`, rename the
     staged pack into `<exe-name>.pck` as the process exits, and restart with
     `OS.set_restart_on_exit(true)`. Keep the rollback after two failed boots by restoring the
     previous sidecar;
   - never swap on macOS (the pack is inside the signed `.app`) or on Linux arm64 (the desktop pack
     is S3TC-only, §9.2 #12); those builds get BINARY.
2. **#2.** Stamp `steam` and `itch` and export their own desktop PCKs. Desktop presets use
   `embed_pck=false` (`export_presets.cfg:378,422,452`), so only the sidecar `.pck` differs; the
   macOS variant is signed and notarised like the `github` one. Update `docs/RELEASE.md:107-108`.
3. **#3.** Stamp the sideload APK and sideload IPA `github`, which the code already treats as
   "sideloaded mobile": channel locked, no checks (`update_policy.gd:151-164`, `updater.gd:124-128`).
   Keep `play` for the AAB and `appstore` for the signed IPA. Replace `id0000000000` with the real
   listing, or publish no `stores.ios` until it exists (the decision then returns NONE,
   `update_policy.gd:229-237`).
4. **#8.** Set `max_redirects = 0` in `update_fetcher.gd` and follow 3xx responses in code (at most
   10). Send `Authorization` only when the request's origin (scheme, host, port) equals the
   configured base URL's origin; drop it on any cross-origin hop; refuse an `https` → `http` hop.
5. **Stamp per artifact.** Each exported artifact has exactly one stamp, matching its upload target.
   The publish job's build manifest (`release.yml:256-349`) records `distribution` per artifact, and
   a CI step reads `build_info.json` back out of every exported PCK and fails on a mismatch (vendor
   the PCK reader `prototype/patching/tools/pck.py` from the Polaris Key repo, or use
   `godotpcktool`).
6. **Developer verification.** List every key that signs a shipping APK or AAB (upload key, Play
   app-signing key, the release keystore used by `tools/export.sh:241-272`, any F-Droid-repo key)
   with its SHA-256 certificate fingerprint in `docs/RELEASE.md`. The human registers
   `gg.vlad.diceroll` and those keys. A tagged release fails if an APK is debug-signed (the export
   falls back to the debug key today).

**Out** (and where it belongs instead):

- Any Polaris Key adoption (→ [D-02](D-02-diceroll-after-p1.md)); the SDK updater, Sparkle and
  Velopack (→ P3-10, P5-07, [D-03](D-03-diceroll-after-p3.md)).
- §9.2 items 4, 5, 7, 9, 11, 13 and 14, which go away when the SDK and Polaris Key feeds replace
  the updater (→ D-03); items 10 and 12 (→ [D-04](D-04-diceroll-after-p4.md)). Item 6 (build-code
  collisions in `stamp_version.py:57-62`) outlives D-03: propose it as a separate fix.
- Telling TestFlight from App Store installs: the same signed IPA is promoted, so no stamp can
  (→ `AppDistributor` in P5-05, adopted in [D-05](D-05-diceroll-after-p6.md)).
- Recording keys in Polaris Key's key inventory (→ P2b-03, D-03).

## Design notes

- **Keep Diceroll's stamp vocabulary** (`github`, `web`, `play`, `appstore`, `testflight`,
  `steam`, `itch`, `dev`; `update_policy.gd:17-21`). Polaris Key's outlet ids (`direct`,
  `altstore`, `obtainium`, …, [README §3.1](../../README.md#31-vocabulary)) arrive with the SDK's
  export plugin in D-03.
- **One pack, two platforms.** The published desktop pack is exported from the Linux preset
  (`tools/export.sh:224-238`), so the swap puts a Linux-exported pack beside the Windows executable.
  The old updater meant to do the same, but it never ran; prove the Windows build boots on it, or
  publish a Windows-exported pack as well.
- **Never overwrite a pack in use.** Overwriting a mounted pack corrupts reads
  ([notes/A6 §2.7](../../notes/A6-godot-patching.md#27-mount-semantics)), so the swap happens only as
  the process exits. Godot opens pack files per read rather than holding them open, but Windows
  file locking was never tested (A6 §7): test the rename on Windows while the game runs and at
  exit. Diceroll's store already retries renames 12 × 250 ms (`update_store.gd:269-274`). If Windows
  still refuses, leave pack application off on Windows and ship BINARY; record which in the PR.
- The existing properties stay: exact engine match for packs (`update_policy.gd:248`), the binary
  supersedes older content (`update_store.gd:230-242`), no downgrade, and skip after rollback.
- Custom export templates with `disable_path_overrides=no` would keep `--main-pack` but cost 6–8
  template builds per engine bump; the report rejects them unless PCK encryption is also wanted
  ([README §11](../../README.md#11-decisions-needed) decision 6).
- **Signing keys:** Play App Signing apps are claimed automatically; the sideload key must be added
  and proven. If cross-channel upgrades matter, one app-signing key across Play (enrolled with
  PEPK), direct and F-Droid is the report's advice ([README §4.2](../../README.md#42-android)). If the
  Play app already uses a Google-generated key, that choice is the human's; record it.
- **While waiting for the human:** items 1–5 need no input. Ship without `stores.ios` until the
  Apple ID arrives; keep registration as an open checkbox in the PR.

## Steps

1. Re-verify every cited path and line; note differences in the PR.
2. Record #1 on the four desktop exports; fix it with tests; re-run the exports.
3. Change stamping in `release.yml`; add the stamp check and the debug-key guard; fix the fetcher.
4. Collect key fingerprints (`apksigner verify --print-certs`, `keytool -list -v`) for the human.
5. Cut a tagged pre-release and check every artifact's stamp and behaviour.

## Acceptance criteria

- [ ] The PR carries a before/after log per desktop target for #1 (pack applied or not; boot attempts).
- [ ] Updater tests cover: a relaunch that did not take; a sidecar swap that succeeds; one that fails
      to rename; rollback after two failed boots; no swap on macOS or Linux arm64.
- [ ] Fetcher tests cover: `Authorization` present on a same-origin request; absent after a
      cross-origin redirect; `https` → `http` refused; more than 10 redirects refused.
- [ ] On the pre-release, CI's stamp check passes, and a deliberately wrong stamp fails it once.
- [ ] Steam and itch installs of the pre-release make no update check; the sideload APK and IPA show
      the "sideloaded" lock and no store prompt.
- [ ] `stores.ios` is the real listing URL or absent.
- [ ] `docs/RELEASE.md` lists every signing key with its SHA-256 fingerprint and registration state;
      a tagged release refuses a debug-signed APK.
- [ ] `gg.vlad.diceroll` and its keys are registered (human-confirmed), or the PR says what is pending.
- [ ] Diceroll's `ci.yml` is green.

## Verify

```sh
# In the Diceroll repository (re-read ci.yml for the exact test command first):
bash tools/ci/selftest.sh
# the updater suites, as ci.yml runs them (tests/test_update_*.gd)
apksigner verify --print-certs <the sideload APK>
# the stamp inside an exported PCK (pck.py vendored from the Polaris Key prototype):
python3 -c 'import sys,json,pck; f=sys.argv[1]; e=[x for x in pck.read_pck(f)["entries"] if x["path"].endswith("build_info.json")][0]; print(json.loads(pck.read_entry(f,e))["distribution"])' <exported>.pck
```

## Hand-off

D-03 relies on: one stamp per artifact (it moves into the SDK export plugin's `polaris_key/outlet`
preset option), the signing-key list with fingerprints (imported into Polaris Key's key inventory), and
the measured behaviour of the sidecar swap on Windows, which the lead should copy to P3-10's brief.
Diceroll deletes nothing here. The status lives in the Polaris Key repo: the lead runs
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set D-01 done` there when the
Diceroll PR merges.
