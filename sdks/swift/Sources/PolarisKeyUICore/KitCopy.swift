// @pkey-feature ui.i18n
// The kit copy catalog (UI-KITS §4.7; plans/UK-02.md §3): every string a kit screen shows, in the
// launch locales, as ICU MessageFormat-subset text, formatted here without a runtime ICU library.
//
// The tables are `Resources/kit-copy.json`, written by `pnpm gen:brand` from
// packages/brand/kit-copy/ and the core copy (`core.*` keys, conformance/parity/copy.<locale>.json),
// the same tables the web kits and the terminal read. Lookup is UI-KITS §4.7's, key by key: the
// locale's override, the locale's table, the English override, then English. A locale with no pack
// is English; a locale whose core pack is pending carries English core copy in its table (the
// generator's doing).
//
// The subset (kit-copy.ts): plain `{arg}` arguments; at most one complex argument, either
// `{n, plural, …}` on an integer with the locale's CLDR categories and `#` for the number in plain
// ASCII digits, or `{formFactor, select, …}`, where an unknown value takes `other`. No quoting,
// no nesting. A missing argument is written back as `{arg}`, so a gap is visible, never silent.

import Foundation

/// An argument of a copy line: a word (a name, a version, a URL), an integer (a count), or
/// another catalog line ("this iPhone" inside "To use it on this iPhone, …"), formatted in the
/// same locale.
public enum CopyArgument: Sendable, Equatable, Hashable, ExpressibleByStringLiteral,
    ExpressibleByIntegerLiteral
{
    case text(String)
    case number(Int)
    indirect case line(CopyLine)

    public init(stringLiteral value: String) { self = .text(value) }
    public init(integerLiteral value: Int) { self = .number(value) }

    /// The value as the message shows it: integers in plain ASCII digits (the subset's `#`).
    public var rendered: String {
        switch self {
        case .text(let s): return s
        case .number(let n): return String(n)
        case .line(let l): return KitCopy.bundled.format(l, locale: "en")
        }
    }

    var integer: Int? {
        switch self {
        case .number(let n): return n
        case .text(let s): return Int(s)
        case .line: return nil
        }
    }
}

/// One visible string of a screen: its catalog key and the arguments the state supplies.
public struct CopyLine: Sendable, Equatable, Hashable {
    public let key: String
    public let args: [String: CopyArgument]

    public init(_ key: String, _ args: [String: CopyArgument] = [:]) {
        self.key = key
        self.args = args
    }
}

/// A platform variant of an English string (UI-KITS §4.7: only the verb or the casing varies).
public enum CopyVariant: String, Sendable, CaseIterable {
    case macos, ios, tv, terminal
}

/// The catalog: every launch locale's table plus the English platform variants, and a host's
/// per-locale overrides (`theme.copy`).
public struct KitCopy: Sendable {
    /// The launch locales in the generator's order, English first.
    public let locales: [String]
    let tables: [String: [String: String]]
    let variants: [String: [String: String]]
    /// The integrator's overrides, per locale, key by key (UI-KITS §3.1 `copy`).
    public var overrides: [String: [String: String]]

    public init(
        locales: [String], tables: [String: [String: String]],
        variants: [String: [String: String]] = [:],
        overrides: [String: [String: String]] = [:]
    ) {
        self.locales = locales
        self.tables = tables
        self.variants = variants
        self.overrides = overrides
    }

    /// The bundled catalog (Resources/kit-copy.json), decoded once.
    public static let bundled: KitCopy = {
        guard let url = Bundle.module.url(forResource: "kit-copy", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let file = try? JSONDecoder().decode(File.self, from: data)
        else {
            // The resource ships in the package; a build without it is broken, and an empty
            // catalog would show raw keys, which `format` writes back visibly.
            return KitCopy(locales: ["en"], tables: ["en": [:]])
        }
        return KitCopy(locales: file.locales, tables: file.tables, variants: file.variants)
    }()

    private struct File: Decodable {
        let locales: [String]
        let tables: [String: [String: String]]
        let variants: [String: [String: String]]
    }

    /// This catalog with `overrides` merged over the existing ones, per locale and key.
    public func overriding(_ more: [String: [String: String]]) -> KitCopy {
        var copy = self
        for (locale, map) in more {
            copy.overrides[locale, default: [:]].merge(map) { _, new in new }
        }
        return copy
    }

    /// Whether any table carries `key` (the core uses it to fall back to `core.fallback.*` for a
    /// code the catalog does not know).
    public func has(_ key: String) -> Bool { tables["en"]?[key] != nil }

    /// The pack a requested locale reads: the exact launch locale, else its language's
    /// (`pt` → `pt-BR`, `zh-Hans-CN` → `zh-Hans`, `de-AT` → `de`), else English.
    public func packLocale(for requested: String) -> String {
        let id = requested.replacingOccurrences(of: "_", with: "-")
        if tables[id] != nil { return id }
        let lower = id.lowercased()
        if let exact = locales.first(where: { $0.lowercased() == lower }) { return exact }
        if lower.hasPrefix("zh-hans") || lower == "zh" || lower.hasPrefix("zh-cn")
            || lower.hasPrefix("zh-sg")
        {
            return locales.contains("zh-Hans") ? "zh-Hans" : "en"
        }
        let language = lower.split(separator: "-").first.map(String.init) ?? lower
        if let match = locales.first(where: {
            $0.lowercased().split(separator: "-").first.map(String.init) == language
        }) {
            return match
        }
        return "en"
    }

    /// The unformatted message for `key` in `locale`, by §4.7's lookup, or nil when no table and
    /// no override has it. `variant` picks an English platform variant (title case on macOS) when
    /// the active pack is English and the key has one.
    public func message(_ key: String, locale: String, variant: CopyVariant? = nil) -> String? {
        let pack = packLocale(for: locale)
        if let v = overrides[locale]?[key] ?? overrides[pack]?[key] { return v }
        if pack != "en", let v = tables[pack]?[key] { return v }
        if let v = overrides["en"]?[key] { return v }
        if let variant, let v = variants[key]?[variant.rawValue] { return v }
        return tables["en"]?[key]
    }

    /// `key` formatted in `locale` with `args`. An unknown key is written back as the key itself,
    /// so a missing string shows rather than vanishing.
    public func format(
        _ key: String, locale: String, args: [String: CopyArgument] = [:],
        variant: CopyVariant? = nil
    ) -> String {
        guard let message = message(key, locale: locale, variant: variant) else { return key }
        let resolved = args.mapValues { arg -> CopyArgument in
            if case .line(let nested) = arg {
                return .text(format(nested, locale: locale, variant: variant))
            }
            return arg
        }
        return KitMessageFormat.format(message, locale: packLocale(for: locale), args: resolved)
    }

    /// A copy line formatted in `locale`.
    public func format(_ line: CopyLine, locale: String, variant: CopyVariant? = nil) -> String {
        format(line.key, locale: locale, args: line.args, variant: variant)
    }
}

/// The ICU MessageFormat subset of the kit catalog (see the file header).
public enum KitMessageFormat {
    /// Format one message. Never throws: a malformed message (the generator refuses them) renders
    /// its text as is.
    public static func format(_ message: String, locale: String, args: [String: CopyArgument])
        -> String
    {
        guard let parsed = Parsed(message) else { return message }
        var out = ""
        func render(_ piece: Piece, number: Int?) {
            switch piece {
            case .text(let t): out += t
            case .arg(let name): out += args[name]?.rendered ?? "{\(name)}"
            case .hash: out += number.map(String.init) ?? "#"
            }
        }
        for p in parsed.head { render(p, number: nil) }
        if let complex = parsed.complex {
            let value = args[complex.arg]
            let category: String
            switch complex.kind {
            case .plural:
                let n = value?.integer ?? 0
                let c = PluralRules.category(n, locale: locale)
                category = complex.cases[c] != nil ? c : "other"
                for p in complex.cases[category] ?? [] { render(p, number: value?.integer) }
            case .select:
                let v = value?.rendered ?? ""
                category = complex.cases[v] != nil ? v : "other"
                for p in complex.cases[category] ?? [] { render(p, number: nil) }
            }
        }
        for p in parsed.tail { render(p, number: nil) }
        return out
    }

    enum Piece: Equatable {
        case text(String)
        case arg(String)
        case hash
    }

    struct Complex {
        enum Kind { case plural, select }
        let arg: String
        let kind: Kind
        let cases: [String: [Piece]]
    }

    struct Parsed {
        var head: [Piece] = []
        var complex: Complex?
        var tail: [Piece] = []

        init?(_ source: String) {
            let s = Array(source)
            var i = 0
            func isIdent(_ c: Character, first: Bool) -> Bool {
                c.isASCII && (c.isLetter || (!first && c.isNumber))
            }
            func identifier() -> String? {
                guard i < s.count, isIdent(s[i], first: true) else { return nil }
                var name = ""
                while i < s.count, isIdent(s[i], first: name.isEmpty) {
                    name.append(s[i])
                    i += 1
                }
                return name
            }
            func skipSpaces() { while i < s.count, s[i] == " " { i += 1 } }
            /// Text and plain arguments up to a `}` (in a case) or a complex argument's `{`.
            func pieces(inPlural: Bool, inCase: Bool) -> [Piece]? {
                var out: [Piece] = []
                var text = ""
                func flush() {
                    if !text.isEmpty { out.append(.text(text)) }
                    text = ""
                }
                while i < s.count {
                    let c = s[i]
                    if c == "}" { break }
                    if c == "#", inPlural {
                        flush()
                        out.append(.hash)
                        i += 1
                        continue
                    }
                    if c == "{" {
                        let start = i
                        i += 1
                        guard let name = identifier() else { return nil }
                        if i < s.count, s[i] == "}" {
                            i += 1
                            flush()
                            out.append(.arg(name))
                            continue
                        }
                        if i < s.count, s[i] == ",", !inCase {
                            i = start
                            break
                        }
                        return nil
                    }
                    text.append(c)
                    i += 1
                }
                flush()
                return out
            }
            guard let head = pieces(inPlural: false, inCase: false) else { return nil }
            self.head = head
            if i >= s.count { return }
            // `{arg, plural|select, case {…} … }`
            i += 1
            guard let arg = identifier(), i < s.count, s[i] == "," else { return nil }
            i += 1
            skipSpaces()
            guard let kindWord = identifier() else { return nil }
            let kind: Complex.Kind
            switch kindWord {
            case "plural": kind = .plural
            case "select": kind = .select
            default: return nil
            }
            skipSpaces()
            guard i < s.count, s[i] == "," else { return nil }
            i += 1
            var cases: [String: [Piece]] = [:]
            while true {
                skipSpaces()
                guard i < s.count else { return nil }
                if s[i] == "}" {
                    i += 1
                    break
                }
                guard let name = identifier() else { return nil }
                skipSpaces()
                guard i < s.count, s[i] == "{" else { return nil }
                i += 1
                guard let body = pieces(inPlural: kind == .plural, inCase: true), i < s.count,
                    s[i] == "}"
                else { return nil }
                i += 1
                cases[name] = body
            }
            complex = Complex(arg: arg, kind: kind, cases: cases)
            guard let tail = pieces(inPlural: false, inCase: false), i >= s.count else {
                return nil
            }
            self.tail = tail
        }
    }
}

/// CLDR cardinal plural categories for the launch locales, on integers (the subset plurals only
/// integers). Matches `Intl.PluralRules(locale).select(n)` for every integer.
public enum PluralRules {
    public static func category(_ n: Int, locale: String) -> String {
        let language =
            locale.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(
                String.init) ?? "en"
        let millions = n != 0 && n % 1_000_000 == 0
        switch language {
        case "ja", "ko", "zh":
            return "other"
        case "fr":
            if n == 0 || n == 1 { return "one" }
            return millions ? "many" : "other"
        case "pt":
            // pt-BR (CLDR "pt"): i = 0..1 is one.
            if n == 0 || n == 1 { return "one" }
            return millions ? "many" : "other"
        case "es", "it":
            if n == 1 { return "one" }
            return millions ? "many" : "other"
        default:
            // en, de and every locale without a pack (they read English).
            return n == 1 ? "one" : "other"
        }
    }
}
