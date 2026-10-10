// Product presentation (WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1, plans/HA-13.md §3), pinned by
// `conformance/corpus/v2/presentation-matrix.json`. A port of client-core's `presentation.ts`.
//
// Discovery's `core.presentation` is UNSIGNED display data: the product's name, its developer, an
// accent for light and dark grounds, and an icon given as content-addressed image-host URLs with
// the original's hash and each WebP width's hash. No gate, entitlement or trust decision reads it.
//
//   PresentationRules.parsePresentation  the member, field by field: a malformed field is
//                                        dropped and the member never refuses discovery
//   PresentationRules.pickIconSize       which bytes to fetch for a hero `px` points wide on a
//                                        `scale` screen, given the types the platform decodes
//   PresentationRules.iconMatches        bytes are shown and cached only when their SHA-256 is
//                                        the pick's hash
//   PresentationRules.safeFetchUrl       the fetcher's safe-link rule: usable, https (or
//                                        loopback http), and on the original's origin
//   PresentationSource                   the seam every UI kit reads (plans/HA-11.md Q7)
//
// The rules are client-core's, character for character: every length is counted in UTF-16 code
// units for URLs (all of a usable URL is ASCII) and in UTF-8 bytes for text, and no URL parser or
// Unicode normalisation is involved. Every limit is a generated `PRESENTATION_*` constant. A Swift
// `String` cannot hold a lone surrogate (JSONDecoder refuses one), so rule 2's surrogate clause
// holds by construction.

import CryptoKit
import Foundation

/// One WebP width of the icon and the SHA-256 of its bytes.
public struct PresentationIconSize: Sendable, Equatable, Hashable, Codable {
    public let w: Int
    public let sha256: String

    public init(w: Int, sha256: String) {
        self.w = w
        self.sha256 = sha256
    }
}

/// The product's icon: the original and, when the image host made them, WebP widths.
public struct PresentationIcon: Sendable, Equatable, Hashable, Codable {
    /// The original's lower-case hex SHA-256.
    public let sha256: String
    /// One of `PRESENTATION_ICON_TYPES`.
    public let contentType: String
    public let width: Int?
    public let height: Int?
    /// The original's URL (usable, see `PresentationRules.usableUrlOrigin`).
    public let original: String
    /// The width template: exactly one `{w}`, on the original's origin. Nil with no sizes.
    public let url: String?
    /// Strictly ascending widths; empty when there are none (or they were malformed).
    public let sizes: [PresentationIconSize]

    public init(
        sha256: String, contentType: String, width: Int? = nil, height: Int? = nil,
        original: String, url: String? = nil, sizes: [PresentationIconSize] = []
    ) {
        self.sha256 = sha256
        self.contentType = contentType
        self.width = width
        self.height = height
        self.original = original
        self.url = url
        self.sizes = sizes
    }
}

/// Discovery's `core.presentation`, normalised (`PresentationRules.parsePresentation`).
public struct Presentation: Sendable, Equatable, Hashable, Codable {
    /// The product's display name (the member's, else the document's `name`, else the slug).
    public let name: String
    public let developerName: String?
    /// `#rrggbb`, lower case: the light scheme's accent.
    public let accent: String?
    /// `#rrggbb`, lower case: the dark scheme's accent.
    public let accentDark: String?
    public let icon: PresentationIcon?

    public init(
        name: String, developerName: String? = nil, accent: String? = nil,
        accentDark: String? = nil, icon: PresentationIcon? = nil
    ) {
        self.name = name
        self.developerName = developerName
        self.accent = accent
        self.accentDark = accentDark
        self.icon = icon
    }
}

/// What `PresentationRules.pickIconSize` chose: the URL to fetch and the hash its bytes must have.
public enum IconPick: Sendable, Equatable {
    case size(w: Int, sha256: String, url: String)
    case original(sha256: String, url: String)
    case none

    public var sha256: String? {
        switch self {
        case .size(_, let sha256, _), .original(let sha256, _): return sha256
        case .none: return nil
        }
    }

    public var url: String? {
        switch self {
        case .size(_, _, let url), .original(_, let url): return url
        case .none: return nil
        }
    }
}

/// The seam every UI kit reads (plans/HA-11.md Q7): the SDK implements it over discovery and its
/// icon cache, and a kit never fetches discovery or the icon itself.
public protocol PresentationSource: Sendable {
    /// The last parsed member, or nil (none served, or none known yet).
    func current() -> Presentation?
    /// Verified icon bytes for a hero drawn at `px` points on a `scale` screen, or nil.
    func icon(px: Double, scale: Double) async -> Data?
    /// Call `onChange` with the new member whenever it changes; the returned closure
    /// unsubscribes.
    func subscribe(_ onChange: @escaping @Sendable (Presentation?) -> Void) -> @Sendable () -> Void
}

// ── JSON form ──────────────────────────────────────────────────────────────────────────────────

extension PresentationIconSize {
    public var jsonValue: JSONValue { .object(["w": .int(w), "sha256": .string(sha256)]) }
}

extension PresentationIcon {
    /// The icon as the wire and `presentation.json` carry it (absent members omitted).
    public var jsonValue: JSONValue {
        var o: [String: JSONValue] = [
            "sha256": .string(sha256), "contentType": .string(contentType),
            "original": .string(original), "sizes": .array(sizes.map(\.jsonValue)),
        ]
        if let width { o["width"] = .int(width) }
        if let height { o["height"] = .int(height) }
        if let url { o["url"] = .string(url) }
        return .object(o)
    }
}

extension Presentation {
    /// The member as the wire and `presentation.json` carry it (absent members omitted).
    public var jsonValue: JSONValue {
        var o: [String: JSONValue] = ["name": .string(name)]
        if let developerName { o["developerName"] = .string(developerName) }
        if let accent { o["accent"] = .string(accent) }
        if let accentDark { o["accentDark"] = .string(accentDark) }
        if let icon { o["icon"] = icon.jsonValue }
        return .object(o)
    }

    /// The hashes this member names: the original's and every size's.
    public var iconHashes: Set<String> {
        guard let icon else { return [] }
        return Set([icon.sha256] + icon.sizes.map(\.sha256))
    }
}

extension IconPick {
    /// The pick as `presentation-matrix.json`'s `pickCases` write it.
    public var jsonValue: JSONValue {
        switch self {
        case .size(let w, let sha256, let url):
            return .object([
                "source": .string("size"), "w": .int(w), "sha256": .string(sha256),
                "url": .string(url),
            ])
        case .original(let sha256, let url):
            return .object([
                "source": .string("original"), "sha256": .string(sha256), "url": .string(url),
            ])
        case .none:
            return .object(["source": .string("none")])
        }
    }
}

// ── The rules ──────────────────────────────────────────────────────────────────────────────────

public enum PresentationRules {
    /// The loopback hosts plain http is allowed for.
    static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "[::1]"]

    /// `core.presentation` from a discovery document's `core` block, normalised, or nil when the
    /// member is absent or not an object. `docName` and `product` are the document's top-level
    /// `name` and its slug, the name's fallbacks.
    public static func parsePresentation(core: JSONValue?, docName: JSONValue?, product: String)
        -> Presentation?
    {
        guard case .object(let coreObject)? = core,
            case .object(let raw)? = coreObject["presentation"]
        else { return nil }
        return Presentation(
            name: text(raw["name"]) ?? text(docName) ?? product,
            developerName: text(raw["developerName"]),
            accent: colour(raw["accent"]),
            accentDark: colour(raw["accentDark"]),
            icon: icon(raw["icon"]))
    }

    /// Which bytes to fetch for a hero drawn at `px` points on a `scale` screen, given the
    /// content types the platform decodes. `need = ceil(px × scale)` (at least 1):
    ///
    ///   1. With sizes and WebP decodable: the smallest `w ≥ need`, else the largest `w`.
    ///   2. The original instead when it is decodable, its `width` is known and exceeds the
    ///      largest `w`, and `need` exceeds the largest `w`.
    ///   3. With no usable size: the original, when it is decodable.
    ///   4. Otherwise none.
    public static func pickIconSize<S: Sequence>(
        _ icon: PresentationIcon, px: Double, scale: Double, decodable: S
    ) -> IconPick where S.Element == String {
        let types = Set(decodable)
        let product = (px * scale).rounded(.up)
        let need = product.isFinite && product >= 1 ? product : 1
        let originalOk = types.contains(icon.contentType)
        let original = IconPick.original(sha256: icon.sha256, url: icon.original)
        if let template = icon.url, let largest = icon.sizes.last, types.contains("image/webp") {
            let fit = icon.sizes.first { Double($0.w) >= need } ?? largest
            if originalOk, need > Double(largest.w), let width = icon.width, width > largest.w {
                return original
            }
            return .size(
                w: fit.w, sha256: fit.sha256,
                url: replaceFirst(template, "{w}", with: String(fit.w)))
        }
        return originalOk ? original : .none
    }

    /// Whether `bytes` hash to `sha256`: their lower-case hex SHA-256 equals it exactly (an
    /// upper-case expectation never matches).
    public static func iconMatches(_ bytes: Data, sha256: String) -> Bool {
        hex(SHA256.hash(data: bytes)) == sha256
    }

    /// The lower-case hex SHA-256 of `bytes`.
    public static func sha256Hex(_ bytes: Data) -> String { hex(SHA256.hash(data: bytes)) }

    /// The fetcher's safe-link rule (plans/HA-13.md §3): `url` is usable (so https, or http to a
    /// loopback host only) and on `original`'s origin, so a `{w}` expansion can never reach
    /// another host.
    public static func safeFetchUrl(_ url: String, original: String) -> Bool {
        guard let origin = usableUrlOrigin(url) else { return false }
        return origin == usableUrlOrigin(original)
    }

    /// Rule 5: the URL's origin (scheme and authority, lower-cased) when it is usable, else nil.
    public static func usableUrlOrigin(_ v: JSONValue?) -> String? {
        guard case .string(let s)? = v else { return nil }
        return usableUrlOrigin(s)
    }

    /// Rule 5 over a string (see the JSON overload).
    public static func usableUrlOrigin(_ v: String) -> String? {
        let units = Array(v.utf16)
        guard units.count >= 1, units.count <= PRESENTATION_URL_MAX_BYTES else { return nil }
        for c in units where c < 0x21 || c > 0x7e || c == 0x23 /* # */ || c == 0x5c /* \ */ {
            return nil
        }
        // Printable ASCII only from here, so Swift's String operations are byte operations.
        let lower = asciiLower(v)
        let scheme: String
        if lower.hasPrefix("https://") {
            scheme = "https"
        } else if lower.hasPrefix("http://") {
            scheme = "http"
        } else {
            return nil
        }
        let rest = lower.dropFirst(scheme.count + 3)
        let authority = String(rest.prefix { $0 != "/" && $0 != "?" })
        guard let host = authorityHost(authority) else { return nil }
        // Only the loopback hosts may be plain http.
        if scheme == "http" && !loopbackHosts.contains(host) { return nil }
        return "\(scheme)://\(authority)"
    }

    // ── Rule helpers ─────────────────────────────────────────────────────────────────────────

    /// A lower-cased authority's host when it has a usable host and port, else nil.
    static func authorityHost(_ authority: String) -> String? {
        let host: String
        let port: String?
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[...close])
            let after = authority[authority.index(after: close)...]
            if !after.isEmpty && !after.hasPrefix(":") { return nil }
            port = after.isEmpty ? nil : String(after.dropFirst())
        } else if let colon = authority.firstIndex(of: ":") {
            host = String(authority[..<colon])
            port = String(authority[authority.index(after: colon)...])
        } else {
            host = authority
            port = nil
        }
        if let port {
            guard port.utf8.count >= 1, port.utf8.count <= 5, allDigits(port),
                let n = Int(port), n <= 65535
            else { return nil }
        }
        if host == "[::1]" || host == "127.0.0.1" { return host }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        for label in labels where !dnsLabel(label) { return nil }
        guard let last = labels.last else { return nil }
        // WHATWG's ends-in-a-number test: a last label that would parse as an IPv4 number.
        if allDigits(last) || isHexNumber(last) { return nil }
        return host
    }

    /// Rule 2: a display text, or nil.
    static func text(_ v: JSONValue?) -> String? {
        guard case .string(let s)? = v else { return nil }
        let bytes = s.utf8.count
        guard bytes >= 1, bytes <= PRESENTATION_TEXT_MAX_BYTES else { return nil }
        for u in s.unicodeScalars where u.value <= 0x1f || (u.value >= 0x7f && u.value <= 0x9f) {
            return nil
        }
        return s
    }

    /// Rule 3: a colour, lower-cased, or nil.
    static func colour(_ v: JSONValue?) -> String? {
        guard case .string(let s)? = v else { return nil }
        let b = Array(s.utf8)
        guard b.count == 7, b[0] == UInt8(ascii: "#"), b.dropFirst().allSatisfy(isHexDigit) else {
            return nil
        }
        return asciiLower(s)
    }

    /// `^[0-9a-f]{64}$`.
    static func isSha256(_ v: JSONValue?) -> String? {
        guard case .string(let s)? = v else { return nil }
        let b = Array(s.utf8)
        guard b.count == 64,
            b.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
        else { return nil }
        return s
    }

    /// JavaScript's `Number.isInteger` over a JSON number, as an `Int` (nil when not one). A
    /// whole number too large for an exact `Int` is out of every range this module checks.
    static func integer(_ v: JSONValue?) -> Int? {
        switch v {
        case .int(let i)?: return i
        case .double(let d)? where d.isFinite && d.rounded() == d && abs(d) < 9.0e15: return Int(d)
        default: return nil
        }
    }

    static func dimension(_ v: JSONValue?) -> Int? {
        guard let n = integer(v), n >= 1, n <= PRESENTATION_ICON_MAX_DIMENSION else { return nil }
        return n
    }

    /// Rule 4's `sizes`: the entries, `[]` when absent, or nil when any entry is bad.
    static func sizes(_ v: JSONValue?) -> [PresentationIconSize]? {
        guard let v else { return [] }
        guard case .array(let entries) = v, entries.count <= PRESENTATION_MAX_ICON_SIZES else {
            return nil
        }
        var out: [PresentationIconSize] = []
        var last = 0
        for e in entries {
            guard case .object(let o) = e, let w = integer(o["w"]), w >= 1,
                w <= PRESENTATION_MAX_ICON_WIDTH, w > last, let sha = isSha256(o["sha256"])
            else { return nil }
            out.append(PresentationIconSize(w: w, sha256: sha))
            last = w
        }
        return out
    }

    /// Rule 4: the icon, or nil.
    static func icon(_ v: JSONValue?) -> PresentationIcon? {
        guard case .object(let o)? = v, let sha = isSha256(o["sha256"]),
            case .string(let contentType)? = o["contentType"],
            PRESENTATION_ICON_TYPES.contains(contentType),
            case .string(let original)? = o["original"],
            let origin = usableUrlOrigin(original)
        else { return nil }
        let ladder = sizes(o["sizes"])
        var template: String?
        if let ladder, !ladder.isEmpty, case .string(let url)? = o["url"],
            url.utf16.count <= PRESENTATION_URL_MAX_BYTES, occurrences(of: "{w}", in: url) == 1
        {
            // `{w}` after the authority: the template begins with the original's own origin.
            let lower = asciiLower(url)
            if (lower.hasPrefix("\(origin)/") || lower.hasPrefix("\(origin)?"))
                && usableUrlOrigin(replaceFirst(url, "{w}", with: "1")) == origin
            {
                template = url
            }
        }
        return PresentationIcon(
            sha256: sha, contentType: contentType, width: dimension(o["width"]),
            height: dimension(o["height"]), original: original, url: template,
            sizes: template != nil ? (ladder ?? []) : [])
    }

    // ── Byte-level string helpers (UTF-16 code units, as JavaScript counts) ──────────────────

    static func isHexDigit(_ b: UInt8) -> Bool {
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
    }

    static func allDigits<S: StringProtocol>(_ s: S) -> Bool {
        !s.isEmpty && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// `^0x[0-9a-f]*$` (the label is already lower-cased).
    static func isHexNumber<S: StringProtocol>(_ s: S) -> Bool {
        let b = Array(s.utf8)
        guard b.count >= 2, b[0] == 0x30, b[1] == 0x78 else { return false }
        return b.dropFirst(2).allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    /// `^[a-z0-9-]{1,63}$`.
    static func dnsLabel<S: StringProtocol>(_ s: S) -> Bool {
        let b = Array(s.utf8)
        return b.count >= 1 && b.count <= 63
            && b.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
    }

    /// ASCII lower-casing; every other character is left alone.
    static func asciiLower(_ s: String) -> String {
        String(
            decoding: s.utf16.map { ($0 >= 0x41 && $0 <= 0x5a) ? $0 + 0x20 : $0 },
            as: UTF16.self)
    }

    /// Non-overlapping occurrences of `needle` in `haystack`, by UTF-16 code unit.
    static func occurrences(of needle: String, in haystack: String) -> Int {
        let h = Array(haystack.utf16)
        let n = Array(needle.utf16)
        guard !n.isEmpty, h.count >= n.count else { return 0 }
        var count = 0
        var i = 0
        while i + n.count <= h.count {
            if Array(h[i..<(i + n.count)]) == n {
                count += 1
                i += n.count
            } else {
                i += 1
            }
        }
        return count
    }

    /// `haystack` with its first `needle` replaced, by UTF-16 code unit (JavaScript's
    /// `String.prototype.replace` with a string pattern).
    static func replaceFirst(_ haystack: String, _ needle: String, with replacement: String)
        -> String
    {
        let h = Array(haystack.utf16)
        let n = Array(needle.utf16)
        guard !n.isEmpty, h.count >= n.count else { return haystack }
        var i = 0
        while i + n.count <= h.count {
            if Array(h[i..<(i + n.count)]) == n {
                let out = Array(h[..<i]) + Array(replacement.utf16) + Array(h[(i + n.count)...])
                return String(decoding: out, as: UTF16.self)
            }
            i += 1
        }
        return haystack
    }

    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
