# S-09 probe code

Research code behind [notes/S-09](../S-09-apple-storekit-distributor.md). It is not part of the
green gate and not a published SDK. P5-05 rewrites it as `PolarisKeyPlatform`, the Godot binding
and the facade.

| Path                                        | What it is                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkplat/`                                   | A Swift package (tools 6.0, Swift 6 language mode, iOS 17 / macOS 14) shaped like the proposed `PolarisKeyPlatform`: distributor with a deadline, AppTransaction, StoreKit 2, Keychain, and the C surface `pkp_call` / `pkp_free` / `pkp_set_event_callback`. Its tests use `SKTestSession` |
| `skhost/`                                   | An XcodeGen project: a minimal iOS app plus a unit-test bundle hosted in it. This is the only setup in which StoreKit Testing worked headless (see the note)                                                                                                                                |
| `gdx/pkap.m`                                | The GDExtension glue, built on the C interface only (adapted from S-01's `pkba.m`). It registers `PolarisKeyApple.cmd(json) -> String`, queues Swift events from any thread, and `{"op":"poll"}` drains the queue                                                                           |
| `gdx/SKTestHook.swift`                      | Probe only, simulator slice only: starts an `SKTestSession` inside the Godot process                                                                                                                                                                                                        |
| `gdx/build.sh`                              | Builds `pkap.xcframework`: the Swift sources and the glue in one dynamic framework per slice, at `MIN_IOS` (default 17.0)                                                                                                                                                                   |
| `gdx/run.sh`                                | Exports the Godot project, builds it for the simulator (ad hoc signing plus `get-task-allow`) or the device (unsigned), installs it, launches a plan and prints the app's log                                                                                                               |
| `gdx/godot/addons/pkey_probe/pkey_apple.gd` | The facade P5-05 should ship (`PKeyApple`). Its signals are declared in GDScript. It returns `Unsupported` with reason `runtime` or `dependency`                                                                                                                                            |
| `gdx/godot/main.gd`                         | Plans: `binding`, `nosession`, `kc_write`, `kc_read`, `pollcost`, `stub`                                                                                                                                                                                                                    |
| `swift6/Core.swift`                         | The concurrency patterns without Apple frameworks, so the Swift 6.0, 6.1 and 6.2 Linux images can type-check them                                                                                                                                                                           |

## Commands (Xcode 27.0, iOS 26.5 simulator, Godot 4.7.2)

```sh
# 1. Package: macOS and iOS builds; StoreKit Testing fails under both of these runners (see the note)
( cd pkplat && swift build && swift test )
( cd pkplat && xcodebuild -scheme PKPlatformProbe -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build )
( cd pkplat && xcodebuild test -scheme PKPlatformProbe -destination "platform=iOS Simulator,id=$UDID" )

# 2. Hosted StoreKit Testing (this setup works)
( cd skhost && xcodegen generate && xcodebuild test -project SKHost.xcodeproj -scheme SKHost \
    -destination "platform=iOS Simulator,id=$UDID" ) | grep '^S09 '

# 3. Godot binding. The official 4.7.2 simulator libgodot.a is x86_64 only, so build an arm64 slice:
git clone --depth 1 --branch 4.7.2-stable https://github.com/godotengine/godot.git godot-src
( cd godot-src && scons platform=ios target=template_release arch=arm64 simulator=yes -j16 )  # 2 min 19 s on an M5 Pro
gdx/build.sh && rm -rf gdx/godot/bin/pkap.xcframework && cp -R gdx/build/pkap.xcframework gdx/godot/bin/
export UDID=<iOS 26.5 simulator udid>
gdx/run.sh export_proj && gdx/run.sh build_sim && gdx/run.sh install
# The in-process SKTestSession needs XCTest loaded (probe only):
P=$(xcode-select -p)/Platforms/iPhoneSimulator.platform/Developer
SIMCTL_CHILD_DYLD_FRAMEWORK_PATH="$P/Library/Frameworks" SIMCTL_CHILD_DYLD_LIBRARY_PATH="$P/usr/lib" \
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$P/Library/Frameworks/XCTest.framework/XCTest" gdx/run.sh launch binding 90
gdx/run.sh applog
gdx/run.sh clearlog && gdx/run.sh launch kc_write 30 && gdx/run.sh uninstall && gdx/run.sh install && gdx/run.sh launch kc_read 30 && gdx/run.sh applog
( cd gdx/godot && godot --headless --path . -- --plan=stub )   # desktop: Unsupported(runtime)

# 4. Composition with S-01's Background Assets patch (the gem setup is in prototype/apple-ba/README.md)
cp -R gdx/build/export gdx/build/patched
ruby ../../prototype/apple-ba/patch/patch_ba.rb gdx/build/patched/probe.xcodeproj --app-group group.dev.polariskey.research.pkap
PROJ=gdx/build/patched gdx/run.sh xb iphoneos dd-dev CODE_SIGNING_ALLOWED=NO

# 5. Swift 6 language checks on older compilers
for v in 6.0 6.1 6.2; do docker run --rm -v "$PWD/swift6":/src -w /src swift:$v \
  swiftc -swift-version 6 -parse-as-library -typecheck -D SHORTCUTS Core.swift; done
```

Generated outputs (`build/`, `godot-src/`, `.godot/`, `*.xcodeproj` under `skhost/`, `.build/`,
`pkap.xcframework`) are git-ignored.
