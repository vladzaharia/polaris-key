# SwiftUI kit sample: Tidewater Studio

The SwiftUI kit's sample (docs/design/UI-KITS.md §6.1): the fixture product Tidewater Studio (by
Harbor Audio, teal derived from its icon) on iPhone and iPad, iOS 18 and later.

- **No arguments:** a gallery of every preview state, drawn by the kit over the fixture inputs.
  No Worker is involved.
- **`-pkeyState <id>`:** one state full screen, for example `Welcome.default` or
  `SignInHandoff.code`, with `-pkeyScheme dark|light`, `-pkeyPreset native`,
  `-pkeyAccent #ff6a3d`, `-pkeyLocale de` and `-pkeyAmbient off`.
- **`--live`:** the whole integration, one modifier on the root view, against a real Worker:

  ```swift
  SessionsView().polarisKeyGate(client)
  ```

  Set `PKEY_PRODUCT` (default `tidewater`), `PKEY_BASE_URL` (default `https://key.plrs.im`) and
  the product's pins as JSON in `PKEY_PINS` in the scheme's environment.

## Run it

Needs Xcode 26 or later and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
./run.sh --open          # generate TidewaterKit.xcodeproj and open it
./run.sh                 # render every state on the iPhone simulator
```

`run.sh` runs `KitRenderTests`, which launches each state in both schemes (and, for the main
screens, at Dynamic Type AX3 and AX5, in landscape, under `native` and in `de` and `ja`). Each render
is written to `PKEY_KIT_SHOTS` (default `build/shots/`), checked with `performAccessibilityAudit`
and listed with what VoiceOver reads in `renders-<device>.json`.

```sh
DEVICE="iPad Air 11-inch (M4)" PKEY_KIT_DEVICE=ipad-820x1180 ./run.sh
PKEY_KIT_ONLY=Welcome.default,SignIn.methods PKEY_KIT_QUICK=1 ./run.sh
PKEY_KIT_BASELINES=../../../sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__ ./run.sh
```

The committed iPhone baselines are 440x956 renders from the iPhone 17 Pro Max on the iOS 26.5
simulator; `run.sh` pins that runtime (`IOS=26.5`), because Xcode 27's `OS:latest` is iOS 27, which
has no such device and draws some states differently. Name the files with
`PKEY_KIT_DEVICE=iphone-440x956` to compare or record against them. CI has no iOS render lane
(only the Mac one), so never record from another device or runtime.

With `PKEY_KIT_BASELINES` every render is compared with its committed baseline;
`PKEY_KIT_RECORD=1` writes them instead (give the reason in the commit).

## macOS (UK-08.2)

`TidewaterKitMac` is the same `App/` sources as a macOS 15+ app; `TidewaterKitMacUITests` is its
render harness (`UITests/KitRenderMacTests.swift`, XCUITest plus SnapshotTesting).

```sh
./run.sh --mac --build-only   # build the sample and the harness; needs no UI automation
PKEY_KIT_QUICK=1 ./run.sh --mac   # Welcome.default in both schemes, audited
PKEY_KIT_WINDOWS=900x640,480x520 PKEY_KIT_INACTIVE=1 ./run.sh --mac
```

Extra launch arguments: `-pkeyWindow WxH` (content size in points) and `-pkeyInactive` (Finder
takes the activation, so the window shows its inactive look). Renders are window screenshots named
`mac<OS>-<W>x<H>-<state>-<preset>-<scheme>[-inactive].png`, written with `renders-mac.json` to
`PKEY_KIT_SHOTS` (default `build/shots-mac`); the OS major is in the name, so a local render never
compares against CI's. `PKEY_KIT_BASELINES` and `PKEY_KIT_RECORD=1` work as on iOS. The test
runner needs UI automation (Accessibility) allowed; CI images have it.

The kit's docs are the [SwiftUI](/docs/build/ui/frameworks/swiftui/) framework page.
