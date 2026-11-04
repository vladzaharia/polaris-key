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
    /// A weight over the role's own (the confirm step's license line reads 500).
    var weight: Font.Weight?
    /// A caption, not a control: the platform's button casing (macOS title case) does not apply.
    var plain = false

    @Environment(\.polarisKeyStrings) private var strings
    #if os(macOS)
        @Environment(\.kitLeadingText) private var leading
    #endif

    init(
        _ line: CopyLine, _ role: KitTextRole = .body, color: KitTextColor = .default,
        alignment: TextAlignment = .leading, weight: Font.Weight? = nil, plain: Bool = false
    ) {
        self.plain = plain
        self.line = line
        self.role = role
        self.color = color
        self.alignment = alignment
        self.weight = weight
    }

    init(
        _ key: String, _ args: [String: CopyArgument] = [:], _ role: KitTextRole = .body,
        color: KitTextColor = .default, alignment: TextAlignment = .leading
    ) {
        self.init(CopyLine(key, args), role, color: color, alignment: alignment)
    }

    /// The words: with the platform's casing for a control, as written for a caption.
    private var shown: String {
        plain ? strings.catalog.format(line, locale: strings.locale) : strings.string(line)
    }

    private var resolvedAlignment: TextAlignment {
        #if os(macOS)
            return leading ? .leading : alignment
        #else
            return alignment
        #endif
    }

    var body: some View {
        kitStyle { style in
            KitLeadText(shown)
                .font(weight.map { style.font(role).weight($0) } ?? style.font(role))
                .foregroundStyle(color.resolve(style.palette))
                .multilineTextAlignment(resolvedAlignment)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The text colours a part may use.
enum KitTextColor {
    case strong, `default`, muted, subtle, accent, control, danger, success

    func resolve(_ p: KitPalette) -> Color {
        switch self {
        case .strong: return p.textStrong
        case .default: return p.textDefault
        case .muted: return p.textMuted
        case .subtle: return p.textSubtle
        case .accent: return p.accentFg
        /// A text button's colour: the accent itself, so it reads as a control.
        case .control: return p.accentSolid
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

/// A formatted line as `Text`. A reason's lead-in sits between `**` marks (`KitFormat.leadParts`):
/// each run is its own `Text`, the lead-in semibold, joined into one so VoiceOver reads a sentence.
/// The string is never handed to a markup parser.
struct KitLeadText: View {
    let string: String

    init(_ string: String) { self.string = string }

    var body: some View {
        if string.contains("**") {
            KitFormat.leadParts(string).reduce(Text(verbatim: "")) { joined, run in
                joined + (run.strong ? Text(verbatim: run.text).fontWeight(.semibold) : Text(verbatim: run.text))
            }
        } else {
            Text(verbatim: string)
        }
    }
}
