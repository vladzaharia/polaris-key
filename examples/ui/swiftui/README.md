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

With `PKEY_KIT_BASELINES` every render is compared with its committed baseline;
`PKEY_KIT_RECORD=1` writes them instead (give the reason in the commit).

The kit's docs are the [SwiftUI](/docs/build/ui/frameworks/swiftui/) framework page.
