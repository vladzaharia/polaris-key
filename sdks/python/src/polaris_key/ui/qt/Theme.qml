// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.
pragma Singleton
import QtQuick

// The Polaris Key theme for the Qt Quick kit (docs/design/UI-KITS.md §2.1, §3.2): the palette
// per scheme, the product accent (set by polaris_key.ui.qt from polaris_key.ui.accent), the
// component measures and the type scale of the platform variant. Register it with the qmldir
// beside it and read `Theme.surfacePage`, `Theme.controlHeight`, `Theme.typeTitle.size`.
QtObject {
    // "dark" or "light". The kit sets it from the theme's colorScheme (the OS under "system").
    property string scheme: "dark"
    readonly property bool dark: scheme !== "light"

    // "macos", "windows" or "gnome": the platform variant (UI-KITS §3.1 `platform`).
    property string platform: Qt.platform.os === "osx" ? "macos" : Qt.platform.os === "windows" ? "windows" : "gnome"

    // The product accent, resolved for the scheme. Ink until a product colour is set (no icon,
    // no accent: never Polaris violet by default).
    property color accent: textStrong
    property color accentOn: surfacePage
    property color accentFg: textStrong
    property color accentSubtle: surfaceSunken
    property color focusRing: accentFg

    // The palette.
    readonly property color surfacePage: dark ? "#060912" : "#f6f8ff"
    readonly property color surfaceRaised: dark ? "#0d111b" : "#ffffff"
    readonly property color surfaceOverlay: dark ? "#121722" : "#ffffff"
    readonly property color surfaceSunken: dark ? "#020408" : "#ebeef8"
    readonly property color textStrong: dark ? "#ffffff" : "#060912"
    readonly property color textDefault: dark ? "#dbe4ff" : "#262d40"
    readonly property color textMuted: dark ? "#b5bed3" : "#48536b"
    readonly property color textSubtle: dark ? "#969eb2" : "#5d667b"
    readonly property color textOnAccent: dark ? "#060912" : "#ffffff"
    readonly property color borderSubtle: dark ? "#212633" : "#dadee9"
    readonly property color borderStrong: dark ? "#61697b" : "#7e8699"
    readonly property color focus: dark ? "#9a5cff" : "#7a2fff"
    readonly property color action: dark ? "#f6f8ff" : "#060912"
    readonly property color actionOn: dark ? "#060912" : "#ffffff"
    readonly property color actionHover: dark ? "#dee0e7" : "#23262e"
    readonly property color actionPressed: dark ? "#c1c3cb" : "#444750"
    readonly property color actionDisabled: dark ? "#2c2f38" : "#d4d7de"
    readonly property color actionDisabledOn: dark ? "#969eb2" : "#5d667b"
    readonly property color success: dark ? "#56d57b" : "#167337"
    readonly property color successOn: dark ? "#060912" : "#ffffff"
    readonly property color successBorder: dark ? "#3b9555" : "#348f4f"
    readonly property color successSubtle: dark ? "#10211f" : "#e0ebeb"
    readonly property color warning: dark ? "#c38d18" : "#814d00"
    readonly property color warningOn: dark ? "#060912" : "#ffffff"
    readonly property color warningBorder: dark ? "#896100" : "#9d6726"
    readonly property color warningSubtle: dark ? "#1d1913" : "#eae7e6"
    readonly property color danger: dark ? "#f2513f" : "#be2323"
    readonly property color dangerOn: dark ? "#060912" : "#ffffff"
    readonly property color dangerBorder: dark ? "#c83b2c" : "#db423c"
    readonly property color dangerSubtle: dark ? "#221217" : "#f0e3e9"
    readonly property color info: dark ? "#b688fe" : "#7a2fff"
    readonly property color infoOn: dark ? "#060912" : "#ffffff"
    readonly property color infoBorder: dark ? "#8f54dc" : "#8e66f1"
    readonly property color infoSubtle: dark ? "#1b182e" : "#eae4ff"
    readonly property color signed: dark ? "#ffc24d" : "#c47300"
    readonly property color signedOn: dark ? "#060912" : "#060912"
    readonly property color signedBorder: dark ? "#ba882e" : "#bf7101"
    readonly property color signedSubtle: dark ? "#241f19" : "#f1ebe6"
    readonly property color signedMark: dark ? "#ffc24d" : "#d07a00"
    readonly property color brandViolet: dark ? "#9a5cff" : "#7a2fff"
    readonly property color brandGold: dark ? "#ffc24d" : "#d07a00"
    readonly property color dangerSolid: dark ? "#db3a2b" : "#be2323"
    readonly property color dangerSolidOn: dark ? "#ffffff" : "#ffffff"
    readonly property color scrimColor: dark ? "#020408" : "#060912"

    // The highlight edge.
    readonly property color highlight: dark ? Qt.rgba(1, 1, 1, 0.05) : Qt.rgba(1, 1, 1, 0.9)

    // Type.
    readonly property string fontFamily: "Rubik"
    readonly property string monoFamily: "JetBrains Mono"
    readonly property int weightRegular: 400
    readonly property int weightMedium: 500
    readonly property int weightSemibold: 600
    readonly property var typeDisplay: platform === "macos" ? ({ size: 26, lineHeight: 32, weight: 600, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 40, lineHeight: 52, weight: 600, tracking: 0, mono: false }) : ({ size: 28, lineHeight: 34, weight: 600, tracking: 0, mono: false })
    readonly property var typeTitle: platform === "macos" ? ({ size: 22, lineHeight: 28, weight: 600, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 28, lineHeight: 36, weight: 600, tracking: 0, mono: false }) : ({ size: 22, lineHeight: 28, weight: 600, tracking: 0, mono: false })
    readonly property var typeBody: platform === "macos" ? ({ size: 13, lineHeight: 16, weight: 400, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 14, lineHeight: 20, weight: 400, tracking: 0, mono: false }) : ({ size: 15, lineHeight: 21, weight: 400, tracking: 0, mono: false })
    readonly property var typeLabel: platform === "macos" ? ({ size: 13, lineHeight: 16, weight: 500, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 14, lineHeight: 20, weight: 500, tracking: 0, mono: false }) : ({ size: 15, lineHeight: 21, weight: 500, tracking: 0, mono: false })
    readonly property var typeButton: platform === "macos" ? ({ size: 13, lineHeight: 16, weight: 500, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 14, lineHeight: 20, weight: 500, tracking: 0, mono: false }) : ({ size: 15, lineHeight: 21, weight: 500, tracking: 0, mono: false })
    readonly property var typeMeta: platform === "macos" ? ({ size: 12, lineHeight: 15, weight: 400, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 12, lineHeight: 16, weight: 400, tracking: 0, mono: false }) : ({ size: 13, lineHeight: 18, weight: 400, tracking: 0, mono: false })
    readonly property var typeFootnote: platform === "macos" ? ({ size: 12, lineHeight: 15, weight: 400, tracking: 0, mono: false }) : platform === "windows" ? ({ size: 12, lineHeight: 16, weight: 400, tracking: 0, mono: false }) : ({ size: 13, lineHeight: 18, weight: 400, tracking: 0, mono: false })
    readonly property var typeCode: platform === "macos" ? ({ size: 28, lineHeight: 34, weight: 600, tracking: 0.06, mono: true }) : platform === "windows" ? ({ size: 28, lineHeight: 36, weight: 500, tracking: 0.06, mono: true }) : ({ size: 28, lineHeight: 34, weight: 500, tracking: 0.06, mono: true })

    // Component measures; a radius of -1 is a capsule (half the height).
    readonly property real controlHeight: platform === "macos" ? 28 : platform === "windows" ? 32 : 34
    readonly property real radiusControl: platform === "macos" ? -1 : platform === "windows" ? 4 : 8
    readonly property real cardPad: platform === "macos" ? 24 : platform === "windows" ? 24 : 24
    readonly property bool focusSystem: platform === "macos" ? true : platform === "windows" ? false : false
    readonly property real focusWidth: platform === "macos" ? 0 : platform === "windows" ? 2 : 2
    readonly property real focusOffset: platform === "macos" ? 0 : platform === "windows" ? 0 : -2
    readonly property real focusInner: platform === "macos" ? 0 : platform === "windows" ? 1 : 0
    readonly property real focusGlow: platform === "macos" ? 0 : platform === "windows" ? 0 : 0
    readonly property bool hasScrim: platform === "macos" ? false : platform === "windows" ? true : true
    readonly property real scrimDarkOpacity: platform === "macos" ? 0 : platform === "windows" ? 0.3 : 0.35
    readonly property real scrimDarkBlur: platform === "macos" ? 0 : platform === "windows" ? 0 : 0
    readonly property real scrimLightOpacity: platform === "macos" ? 0 : platform === "windows" ? 0.3 : 0.12
    readonly property real scrimLightBlur: platform === "macos" ? 0 : platform === "windows" ? 0 : 0
    readonly property real radiusSurface: platform === "macos" ? 18 : platform === "windows" ? 8 : 14

    // Motion (ms).
    readonly property int durationFast: 120
    readonly property int durationBase: 200
    readonly property int durationSlow: 320
    readonly property real pressScale: 0.98
}
