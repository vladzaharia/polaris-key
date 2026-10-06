// The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1), pinned by
// `device-label.json`.
//
// The human name of this device the sign-in page shows ("Living room TV"), sent as `deviceName`
// on device-code sign-in, licence activation and registration. Display data only: no server
// decision reads it. The Worker applies the same normalisation on receipt:
//
//   1. map the whitespace controls (U+0009–000D, U+0085, U+00A0, U+2028, U+2029, U+3000) to a
//      space;
//   2. delete the controls, zero-width and bidi code points;
//   3. collapse runs of spaces to one, then trim;
//   4. keep at most `DEVICE_LABEL_MAX_CODEPOINTS` Unicode scalars (never UTF-16 units or
//      grapheme clusters), and trim a space the cut exposes;
//   5. an empty result is no label (`nil`).
//
// No Unicode normalisation; nothing is ever rejected. Works on `unicodeScalars`, so a Swift
// `String`'s canonical-equivalence comparison never merges two different labels.

import Foundation

#if canImport(UIKit)
    import UIKit
#endif

private let spaceRanges: [ClosedRange<UInt32>] = [
    0x0009...0x000D, 0x0085...0x0085, 0x00A0...0x00A0, 0x2028...0x2029, 0x3000...0x3000,
]
private let stripRanges: [ClosedRange<UInt32>] = [
    0x0000...0x001F, 0x007F...0x009F, 0x061C...0x061C, 0x200B...0x200F, 0x202A...0x202E,
    0x2060...0x2064, 0x2066...0x2069, 0xFEFF...0xFEFF,
]

/// §12.7.1: the label to send and store, or `nil` when nothing is left of `raw`.
public func normalizeDeviceLabel(_ raw: String?) -> String? {
    guard let raw else { return nil }
    var kept: [Unicode.Scalar] = []
    for scalar in raw.unicodeScalars {
        var s = scalar
        if spaceRanges.contains(where: { $0.contains(s.value) }) {
            s = " "
        } else if stripRanges.contains(where: { $0.contains(s.value) }) {
            continue
        }
        if s == " " && (kept.isEmpty || kept.last == " ") { continue }
        kept.append(s)
    }
    while kept.last == " " { kept.removeLast() }
    var cut = Array(kept.prefix(DEVICE_LABEL_MAX_CODEPOINTS))
    while cut.last == " " { cut.removeLast() }
    if cut.isEmpty { return nil }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: cut)
    return String(out)
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
