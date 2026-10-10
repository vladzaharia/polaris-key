// @pkey-feature ui.i18n
// Copy in the kit's views: every visible string is a catalog key (DL8, UI-KITS §4.7), formatted by
// the presentation core in the theme's locale with the theme's overrides. A view never writes a
// string of its own.

import PolarisKeyUICore
import SwiftUI

/// The catalog and locale a subtree's copy reads.
public struct KitStrings: Sendable {
    public var catalog: KitCopy
    public var locale: String

    public init(catalog: KitCopy = .bundled, locale: String = "en") {
        self.catalog = catalog
        self.locale = locale
    }

    /// The platform variant buttons take (title case on macOS).
    var variant: CopyVariant? {
        #if os(macOS)
            return .macos
        #elseif os(tvOS)
            return .tv
        #else
            return .ios
        #endif
    }

    public func string(_ line: CopyLine) -> String {
        catalog.format(line, locale: locale, variant: variant)
    }

    public func string(_ key: String, _ args: [String: CopyArgument] = [:]) -> String {
        catalog.format(key, locale: locale, args: args, variant: variant)
    }
}

private struct KitStringsKey: EnvironmentKey {
    static let defaultValue = KitStrings()
}

extension EnvironmentValues {
    /// The copy this subtree reads.
    public var polarisKeyStrings: KitStrings {
        get { self[KitStringsKey.self] }
        set { self[KitStringsKey.self] = newValue }
    }
}

/// One copy line as text, in a kit role and colour.
struct KitText: View {
    let line: CopyLine
    var role: KitTextRole = .body
    var color: KitTextColor = .default
    var alignment: TextAlignment = .leading

    @Environment(\.polarisKeyStrings) private var strings

    init(
        _ line: CopyLine, _ role: KitTextRole = .body, color: KitTextColor = .default,
        alignment: TextAlignment = .leading
    ) {
        self.line = line
        self.role = role
        self.color = color
        self.alignment = alignment
    }

    init(
        _ key: String, _ args: [String: CopyArgument] = [:], _ role: KitTextRole = .body,
        color: KitTextColor = .default, alignment: TextAlignment = .leading
    ) {
        self.init(CopyLine(key, args), role, color: color, alignment: alignment)
    }

    var body: some View {
        kitStyle { style in
            Text(strings.string(line))
                .font(style.font(role))
                .foregroundStyle(color.resolve(style.palette))
                .multilineTextAlignment(alignment)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The text colours a part may use.
enum KitTextColor {
    case strong, `default`, muted, subtle, accent, danger, success

    func resolve(_ p: KitPalette) -> Color {
        switch self {
        case .strong: return p.textStrong
        case .default: return p.textDefault
        case .muted: return p.textMuted
        case .subtle: return p.textSubtle
        case .accent: return p.accentFg
        case .danger: return p.danger
        case .success: return p.success
        }
    }
}

extension KitScreen {
    /// The line for `key` with the state's arguments, or the bare key's line when the state does
    /// not carry it (a part drawn outside its state).
    func lineOrKey(_ key: String) -> CopyLine { line(key) ?? CopyLine(key) }
}
