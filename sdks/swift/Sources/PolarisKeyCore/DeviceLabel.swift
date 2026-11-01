// The device label (WIRE-CONTRACT-V5 §12.7.1, plans/PX-W13.md §2.1), pinned by
// `device-label.json` (`deviceLabelVersion` 2).
//
// The human name of this device the sign-in page shows ("Living room TV"), sent as `deviceName`
// on device-code sign-in, licence activation and registration. Display data only: no server
// decision reads it. The Worker applies the same normalisation on receipt:
//
//   1. map every White_Space code point and U+2800 to a space;
//   2. delete the controls, format characters, default-ignorable code points and surrogates;
//   3. collapse runs of spaces to one, then trim;
//   4. keep at most `DEVICE_LABEL_MAX_CODEPOINTS` Unicode scalars (never UTF-16 units or
//      grapheme clusters), and trim a space the cut exposes;
//   5. an empty result is no label (`nil`).
//
// `normalizeDeviceLabel` is steps 1 to 5 with no Unicode normalisation. `cleanDisplayLabel` is
// the peer HELLO cleaner (§15.6): steps 1 and 2, NFC, then steps 3 to 5. Cleaning a cleaned
// label changes nothing. Nothing is ever rejected. Works on `unicodeScalars`, so a Swift
// `String`'s canonical-equivalence comparison never merges two different labels.

import Foundation

#if canImport(UIKit)
    import UIKit
#endif

// Frozen at Unicode 16.0; the corpus `ranges` section pins both tables (DeviceLabelTests).
let deviceLabelSpaceRanges: [ClosedRange<UInt32>] = [
    0x0009...0x000D, 0x0085...0x0085, 0x00A0...0x00A0, 0x1680...0x1680, 0x2000...0x200A,
    0x2028...0x2029, 0x202F...0x202F, 0x205F...0x205F, 0x2800...0x2800, 0x3000...0x3000,
]
let deviceLabelStripRanges: [ClosedRange<UInt32>] = [
    0x0000...0x001F, 0x007F...0x009F, 0x00AD...0x00AD, 0x034F...0x034F, 0x0600...0x0605,
    0x061C...0x061C, 0x06DD...0x06DD, 0x070F...0x070F, 0x0890...0x0891, 0x08E2...0x08E2,
    0x115F...0x1160, 0x17B4...0x17B5, 0x180B...0x180F, 0x200B...0x200F, 0x202A...0x202E,
    0x2060...0x206F, 0x3164...0x3164, 0xD800...0xDFFF, 0xFE00...0xFE0F, 0xFEFF...0xFEFF,
    0xFFA0...0xFFA0, 0xFFF0...0xFFFB, 0x110BD...0x110BD, 0x110CD...0x110CD, 0x13430...0x1343F,
    0x1BCA0...0x1BCA3, 0x1D173...0x1D17A, 0xE0000...0xE0FFF,
]

/// Steps 1 and 2: a space for each blank, nothing for each invisible code point.
private func mapAndStrip(_ raw: String.UnicodeScalarView) -> [Unicode.Scalar] {
    var out: [Unicode.Scalar] = []
    for scalar in raw {
        let v = scalar.value
        if deviceLabelSpaceRanges.contains(where: { $0.contains(v) }) {
            out.append(" ")
        } else if !deviceLabelStripRanges.contains(where: { $0.contains(v) }) {
            out.append(scalar)
        }
    }
    return out
}

/// Steps 3 to 5.
private func collapseAndCut(_ scalars: [Unicode.Scalar], max: Int? = DEVICE_LABEL_MAX_CODEPOINTS) -> String? {
    var kept: [Unicode.Scalar] = []
    for s in scalars {
        if s == " " && (kept.isEmpty || kept.last == " ") { continue }
        kept.append(s)
    }
    while kept.last == " " { kept.removeLast() }
    var cut = max.map { Array(kept.prefix($0)) } ?? kept
    while cut.last == " " { cut.removeLast() }
    if cut.isEmpty { return nil }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: cut)
    return String(out)
}

/// §12.7.1: the label to send and store, or `nil` when nothing is left of `raw`.
public func normalizeDeviceLabel(_ raw: String?) -> String? {
    guard let raw else { return nil }
    return collapseAndCut(mapAndStrip(raw.unicodeScalars))
}

/// §15.6: a peer's `label` or `app` as shown. Steps 1 and 2, NFC, then steps 3 to 5 (the cut counts
/// scalars after NFC). `nil` when nothing is left.
public func cleanDisplayLabel(_ raw: String?) -> String? {
    guard let raw else { return nil }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: mapAndStrip(raw.unicodeScalars))
    return collapseAndCut(Array(String(view).precomposedStringWithCanonicalMapping.unicodeScalars))
}

/// §15.11: a transfer's `name` as shown. Cleaned as a HELLO label (steps 1 and 2, NFC, then steps 3 and 5)
/// without the 64 code point cut. `nil` when nothing is left. Display data only; never a path.
public func cleanDisplayName(_ raw: String?) -> String? {
    guard let raw else { return nil }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: mapAndStrip(raw.unicodeScalars))
    return collapseAndCut(Array(String(view).precomposedStringWithCanonicalMapping.unicodeScalars), max: nil)
}

/// The platform's own name for this device: on macOS the computer name
/// (`Host.current().localizedName`), on iOS, iPadOS, tvOS and visionOS `UIDevice.current.name`
/// (generic since iOS 16, no entitlement), elsewhere the host name without a trailing `.local`,
/// `.lan` or `.home`.
public func defaultDeviceName() async -> String? {
    #if canImport(UIKit) && !os(watchOS)
        return await MainActor.run { UIDevice.current.name }
    #elseif os(macOS)
        return Host.current().localizedName
    #else
        let host = ProcessInfo.processInfo.hostName
        for suffix in [".local", ".lan", ".home"]
        where host.lowercased().hasSuffix(suffix) {
            return String(host.dropLast(suffix.count))
        }
        return host.isEmpty ? nil : host
    #endif
}

/// `override` (per call) wins, then `configured` (the client option), then the platform default.
/// `""` at either level sends none.
public func resolveDeviceLabel(
    override: String?, configured: String?,
    platformDefault: () async -> String? = { await defaultDeviceName() }
) async -> String? {
    if let override { return normalizeDeviceLabel(override) }
    if let configured { return normalizeDeviceLabel(configured) }
    return normalizeDeviceLabel(await platformDefault())
}
