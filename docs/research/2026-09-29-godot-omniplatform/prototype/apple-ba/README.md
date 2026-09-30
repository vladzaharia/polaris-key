# Apple-hosted Background Assets from a Godot 4.7 iOS export (S-01)

Research code for [Godot on Polaris Key](../../README.md) that backs
[S-01: Apple-hosted Background Assets](../../notes/S-01.md). It is not part of the green gate and
not a published SDK; P5-05 turns the patch and the shim into the Apple plugin package.

It exports a throwaway Godot 4.7.2 project for iOS ("Export Project Only"), proves the unpatched
export still builds, adds an Apple-hosted Background Download extension and an App Group to a copy
with a re-runnable Ruby `xcodeproj` script, builds both for device (unsigned) and simulator, and
drives `BAAssetPackManager` from GDScript through a small GDExtension. Four data-only asset packs
(v1 and v2) are built with `xcrun ba-package`; a logging mock server stands in for Apple's CDN on
the simulator.

## What is here

| Path                  | What                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.sh`              | the harness: `./run.sh shim packs export build sim ids` (or `all`); logs to `build/logs/`                                                                                                                        |
| `patch/patch_ba.rb`   | the post-export patch: extension target (`com.apple.product-type.extensionkit-extension`), its Swift file, Info.plist and entitlements, embed phase, App Group on both targets, the three `BA*` keys. Idempotent |
| `shim/pkba.m`         | the GDExtension (C interface only, Objective-C, no godot-cpp): class `PKAppleBA`, one static `cmd(json) -> String`; async ops answer with a request id and push events that `poll` drains                        |
| `shim/build.sh`       | builds `pkba.xcframework` (ios-arm64, ios-arm64-simulator) and a macOS dylib, and copies them to `godot/bin/`                                                                                                    |
| `godot/`              | the probe project: `main.gd` runs a plan (`install`, `update`, `mount`, `live`, `emulate`) and logs one JSON line per event to `user://pkba_log.jsonl`                                                           |
| `packs/make_packs.py` | builds the four packs for v1 and v2 (`pkba-essential-c1`, `-prefetch-`, `-ondemand-`, `-big-`), each with a `.pkey/pack.json` marker, via `xcrun ba-package`; the big pack is A6's 36 MiB v1/v2 pair             |
| `packs/aar_diff.py`   | offline analysis of a v1/v2 `.aar` pair: container, 1 MiB LZFSE block reuse, `zstd --patch-from` over the archives and over the decoded Apple Archive streams                                                    |
| `packs/id_rules.sh`   | which asset-pack ids `ba-package` accepts (all of them; App Store Connect is stricter, see the note)                                                                                                             |
| `mock/serve.py`       | HTTPS stand-in for `xcrun ba-serve` that reads a PEM cert from files (no keychain), serves a `ba-package download-manifest` and the `.aar` files with Range support, and logs bytes sent per request             |
| `mock/session.sh`     | one measured simulator session: set the served version, launch a plan, save the app and server logs                                                                                                              |
| `mock/summarize.py`   | condenses a probe log                                                                                                                                                                                            |
| `asc/upload_pack.mjs` | the App Store Connect upload and poll sequence (Node 22, no deps, ES256 JWT); `--dry-run` prints the requests. The live run is a hand-off                                                                        |

## Prerequisites

| Tool                     | Version measured                                   | Needed for                                            |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------- |
| macOS, Xcode             | macOS 27.0, Xcode 27.0 (27A266a), iOS 26.5 runtime | everything; `xcrun ba-package` 2.0                    |
| Godot                    | 4.7.2-stable official (`ed1daf0bf`) + iOS template | export                                                |
| Ruby, `xcodeproj` gem    | system Ruby 2.6.10, `xcodeproj` 1.27.0             | the patch                                             |
| Python                   | 3.14 (stdlib only), `zstd` CLI 1.5.7               | packs, analysis, mock server                          |
| Node                     | 22                                                 | `asc/upload_pack.mjs`                                 |
| A6's v1/v2 PCKs          | `prototype/patching` README steps 1–2              | the big pack (`A6_OUT`)                               |
| arm64 simulator template | optional, see below                                | running on an Apple Silicon simulator without Rosetta |

Install the gem locally: `GEM_HOME=.gems gem install xcodeproj -v 1.27.0` (the harness sets
`GEM_PATH` to `.gems` plus the system gems, which provide `CFPropertyList`).

**Simulator template.** The official 4.7.2 `ios.zip` ships the simulator slice of `libgodot.a`
as x86_64 only, so an arm64 simulator link fails with undefined symbols. Either install Rosetta,
or build the slice from the same tag and pass it as `GODOT_SIM_LIB`; `run.sh` merges it into the
exported xcframework with `lipo`:

```sh
git clone --depth 1 --branch 4.7.2-stable https://github.com/godotengine/godot.git godot-src
cd godot-src && scons platform=ios target=template_release arch=arm64 simulator=yes -j16
# -> bin/libgodot.ios.template_release.arm64.simulator.a (5 min 52 s on an M5 Pro)
```

The simulator template has no Metal or Vulkan, so the probe uses the Compatibility renderer.

## Run it

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/apple-ba
export A6_OUT=<dir with A6 v1.pck and v2.pck>
export GODOT_SIM_LIB=<path to libgodot.ios.template_release.arm64.simulator.a>
./run.sh shim packs export build   # export, unpatched builds, patch, re-run patch, patched builds
./run.sh sim                        # install; plans install (no server) and emulate
./run.sh ids                        # asset-pack id acceptance by ba-package
```

`build` prints one line per step (`rc`, seconds, `** BUILD SUCCEEDED **`) and checks that a second
patch run leaves the project byte-identical. Re-running `export` + `build` is the "re-runs on a
clean export" check.

**Mock-server sessions (simulator only).** These need a throwaway CA trusted by one simulator
(never by the Mac):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=throwaway CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
# issue leaf.pem/leaf.key for DNS:localhost signed by ca.pem, then:
xcrun simctl keychain <udid> add-root-cert ca.pem
# point the simulator's Background Assets at the mock (the value ba-serve url-override writes on macOS:
# an NSKeyedArchiver-archived NSURL under MBAURLOverride)
xcrun simctl spawn <udid> defaults write com.apple.backgroundassets.managed MBAURLOverride -data <hex>
python3 mock/serve.py --cert leaf.pem --key leaf.key --packs build/packs --log build/mock/req.jsonl &
SIM_UDID=<udid> MOCK_CA=ca.pem mock/session.sh install-v1 1 install 40
SIM_UDID=<udid> MOCK_CA=ca.pem mock/session.sh update-v2 2 update 40
```

Clean up afterwards: `defaults delete com.apple.backgroundassets.managed MBAURLOverride` inside the
simulator and `xcrun simctl keychain <udid> reset`.

**Device and TestFlight (human).** Sign both targets with the team's two App IDs and the App Group,
archive and upload the patched project; build the packs; then
`ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=… ASC_APP_ID=… node asc/upload_pack.mjs --pack-id
pkba-essential-c1 --aar build/packs/v1/pkba-essential-c1.aar` per pack. The note lists the
measurements still owed.

## Limits

- Device builds are unsigned and never uploaded; TestFlight processing, Apple's CDN and install-time
  (essential/prefetch) downloads are unmeasured here.
- The mock server is Apple's documented local-testing path re-implemented, not Apple's CDN; its
  whole-pack behaviour is a lower bound on what the client asks for, not proof of what Apple serves.
- `ba-package` output is not byte-reproducible (the archive root, `Contents` and the embedded
  manifest carry the packaging time).
