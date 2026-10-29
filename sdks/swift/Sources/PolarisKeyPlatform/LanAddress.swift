// The LAN address rule (WIRE-CONTRACT-V5 §15.4.1): which peer address a device may dial or accept on
// the local network, and the keys of the per-address and per-/64 connection counts. Pure: text in, a
// verdict out, with no Network.framework, so the Bonjour pipes and the corpus runner share it. It
// follows client-core's `lanVerdict` (`peer/lanAddress.ts`) and is proven by the `lanAddresses`
// rows of `conformance/corpus/v2/peer-matrix.json`.
//
//   - Literals only. The parsers read an IPv4 or IPv6 literal (RFC 3986 grammar, no leading-zero
//     octet, no port, prefix, bracket, whitespace or non-ASCII digit) and never resolve a name.
//   - A zone is `%` and 1 to 15 characters of U+0021 to U+007E other than `%`. Any other zone, a
//     second `%`, a zone on IPv4 and a zone on an IPv4-mapped address are malformed. The verdict
//     ignores a zone; the key of a link-local address keeps it.
//   - An IPv4-mapped address (::ffff:0:0/96) is judged as its IPv4 address.
//   - IPv4: 10/8, 172.16/12, 192.168/16; 127/8 only with `allowLoopback`.
//   - IPv6: fe80::/10; fc00::/7 (when `local` is known it must be IPv6 in the same /64); ::1 only
//     with `allowLoopback`; 2000::/3 outside 2001::/32 (Teredo) and 2002::/16 (6to4) only when the
//     local address is IPv6 in the same /64 (the on-link global rule).
//   - Everything else is refused, including text that is not an address.

/// What `lanVerdict` decided about one peer address.
public struct LanVerdict: Sendable, Equatable {
    /// The address may be dialled or accepted.
    public let dial: Bool
    /// The per-address count key: dotted IPv4, or RFC 5952 lower-case IPv6 text; a link-local address
    /// keeps its zone (`fe80::1%en0`), any other drops it. Nil when `dial` is false. Never the /64.
    public let key: String?

    public init(dial: Bool, key: String?) {
        self.dial = dial
        self.key = key
    }

    static let refused = LanVerdict(dial: false, key: nil)
}

/// Judge a peer address.
///
/// - Parameters:
///   - remote: the peer's address as text, with or without a zone.
///   - local: the socket's own address; nil when unknown (a global IPv6 address is then refused, and
///     a ULA address is judged on its own).
///   - allowLoopback: accept 127/8 and ::1. Tests and same-host peers only; production never sets it.
public func lanVerdict(_ remote: String, local: String?, allowLoopback: Bool) -> LanVerdict {
    guard let p = LanAddr.parse(remote) else { return .refused }
    switch p.addr {
    case .v4(let o):
        return LanAddr.allowed4(o, allowLoopback: allowLoopback)
            ? LanVerdict(dial: true, key: o.map(String.init).joined(separator: ".")) : .refused
    case .v6(let g):
        let accept = LanVerdict(dial: true, key: LanAddr.text6(g))
        if g[0..<7].allSatisfy({ $0 == 0 }) && g[7] == 1 { return allowLoopback ? accept : .refused }  // ::1
        if (g[0] & 0xFFC0) == 0xFE80 {  // fe80::/10
            let z = p.zone.map { "%" + $0 } ?? ""
            return LanVerdict(dial: true, key: LanAddr.text6(g) + z)
        }
        if (g[0] & 0xFE00) == 0xFC00 {
            // fc00::/7 is routed, so it is on-link only when the local address says so.
            guard let local else { return accept }
            return LanAddr.sameSlash64(g, local) ? accept : .refused
        }
        if (g[0] & 0xE000) != 0x2000 { return .refused }  // not 2000::/3
        if g[0] == 0x2001 && g[1] == 0 { return .refused }  // Teredo
        if g[0] == 0x2002 { return .refused }  // 6to4
        guard let local else { return .refused }
        return LanAddr.sameSlash64(g, local) ? accept : .refused
    }
}

/// The per-/64 count key (§15.4.1) for a verdict `key`: the /64 of an IPv6 address
/// (`2001:db8:1:2::/64`; a link-local /64 keeps the zone, `fe80::/64%en0`); nil for IPv4 and for no key.
public func lanGroupKey(_ key: String?) -> String? {
    guard let key, key.utf8.contains(UInt8(ascii: ":")), let p = LanAddr.parse(key), case .v6(let g) = p.addr else {
        return nil
    }
    let head = LanAddr.text6(Array(g[0..<4]) + [0, 0, 0, 0]) + "/64"
    return p.zone.map { head + "%" + $0 } ?? head
}

/// The text of a socket's address as the platform reports it in bytes: 4 (IPv4) or 16 (IPv6), network
/// order, with the zone the platform names for a link-local address. Nil for any other length.
func lanAddressText(bytes b: [UInt8], zone: String? = nil) -> String? {
    switch b.count {
    case 4: return b.map(String.init).joined(separator: ".")
    case 16:
        var g: [Int] = []
        for i in 0..<8 { g.append(Int(b[2 * i]) << 8 | Int(b[2 * i + 1])) }
        // An IPv4-mapped address carries no zone (the rule refuses one).
        let mapped = g[0..<5].allSatisfy { $0 == 0 } && g[5] == 0xFFFF
        let z = (zone == nil || zone!.isEmpty || mapped) ? "" : "%" + zone!
        return LanAddr.text6(g) + z
    default: return nil
    }
}

enum LanAddr {
    enum Addr: Equatable {
        case v4([Int])
        case v6([Int])
    }

    struct Parsed {
        let addr: Addr
        let zone: String?
    }

    private static let dot = UInt8(ascii: ".")
    private static let colon = UInt8(ascii: ":")
    private static let percent = UInt8(ascii: "%")

    /// Split on a separator, keeping empty parts, like JavaScript's `split`.
    private static func split(_ b: [UInt8], _ sep: [UInt8]) -> [[UInt8]] {
        var out: [[UInt8]] = []
        var cur: [UInt8] = []
        var i = 0
        while i < b.count {
            if b.count - i >= sep.count && Array(b[i..<(i + sep.count)]) == sep {
                out.append(cur)
                cur = []
                i += sep.count
            } else {
                cur.append(b[i])
                i += 1
            }
        }
        out.append(cur)
        return out
    }

    private static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

    private static func hexValue(_ c: UInt8) -> Int? {
        switch c {
        case 0x30...0x39: return Int(c) - 0x30
        case 0x61...0x66: return Int(c) - 0x61 + 10
        case 0x41...0x46: return Int(c) - 0x41 + 10
        default: return nil
        }
    }

    /// Four decimal octets, no sign and no leading zero.
    static func parseV4(_ b: [UInt8]) -> [Int]? {
        let parts = split(b, [dot])
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.count <= 3, p.allSatisfy(isDigit) else { return nil }
            if p.count > 1 && p[0] == 0x30 { return nil }
            let n = p.reduce(0) { $0 * 10 + Int($1 - 0x30) }
            guard n <= 255 else { return nil }
            out.append(n)
        }
        return out
    }

    private static func groups(_ part: [UInt8], last: Bool) -> [Int]? {
        if part.isEmpty { return [] }
        let items = split(part, [colon])
        var out: [Int] = []
        for (i, it) in items.enumerated() {
            if it.contains(dot) {
                // Dotted IPv4 closes the address and stands for two groups.
                guard last, i == items.count - 1, let o = parseV4(it) else { return nil }
                out.append(o[0] * 256 + o[1])
                out.append(o[2] * 256 + o[3])
            } else {
                guard (1...4).contains(it.count) else { return nil }
                var n = 0
                for c in it {
                    guard let h = hexValue(c) else { return nil }
                    n = n * 16 + h
                }
                out.append(n)
            }
        }
        return out
    }

    /// Eight 16-bit groups, or nil.
    static func parseV6(_ s: [UInt8]) -> [Int]? {
        guard !s.isEmpty, s.allSatisfy({ hexValue($0) != nil || $0 == colon || $0 == dot }) else { return nil }
        let halves = split(s, [colon, colon])
        guard halves.count <= 2 else { return nil }
        if halves.count == 1 {
            guard let g = groups(s, last: true), g.count == 8 else { return nil }
            return g
        }
        guard let head = groups(halves[0], last: false), let tail = groups(halves[1], last: true) else { return nil }
        // `::` stands for one or more zero groups.
        let gap = 8 - head.count - tail.count
        guard gap >= 1 else { return nil }
        return head + [Int](repeating: 0, count: gap) + tail
    }

    /// 1 to 15 characters of U+0021 to U+007E other than `%`.
    private static func validZone(_ z: ArraySlice<UInt8>) -> Bool {
        (1...15).contains(z.count) && z.allSatisfy { $0 >= 0x21 && $0 <= 0x7E && $0 != percent }
    }

    static func parse(_ text: String) -> Parsed? {
        var s = Array(text.utf8)
        var zone: String?
        if let pct = s.firstIndex(of: percent) {
            let z = s[(pct + 1)...]
            guard validZone(z) else { return nil }  // empty, a second `%`, a control, a space, non-ASCII, too long
            zone = String(decoding: z, as: UTF8.self)
            s = Array(s[..<pct])
            if !s.contains(colon) { return nil }  // only IPv6 carries a zone
        }
        if s.contains(colon) {
            guard let g = parseV6(s) else { return nil }
            if g[0..<5].allSatisfy({ $0 == 0 }) && g[5] == 0xFFFF {
                if zone != nil { return nil }  // a zone on a mapped address is ambiguous
                return Parsed(addr: .v4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]), zone: nil)
            }
            return Parsed(addr: .v6(g), zone: zone)
        }
        guard let o = parseV4(s) else { return nil }
        return Parsed(addr: .v4(o), zone: nil)
    }

    /// RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups is `::`.
    static func text6(_ g: [Int]) -> String {
        var at = -1
        var len = 0
        var i = 0
        while i < 8 {
            if g[i] != 0 {
                i += 1
                continue
            }
            var j = i
            while j < 8 && g[j] == 0 { j += 1 }
            if j - i > len {
                at = i
                len = j - i
            }
            i = j
        }
        func join(_ xs: ArraySlice<Int>) -> String { xs.map { String($0, radix: 16) }.joined(separator: ":") }
        return len < 2 ? join(g[...]) : "\(join(g[0..<at]))::\(join(g[(at + len)...]))"
    }

    static func allowed4(_ o: [Int], allowLoopback: Bool) -> Bool {
        if o[0] == 10 { return true }
        if o[0] == 172 && (16...31).contains(o[1]) { return true }
        if o[0] == 192 && o[1] == 168 { return true }
        return o[0] == 127 && allowLoopback
    }

    /// `local` is IPv6 (not mapped) and shares the first 64 bits with `g`.
    static func sameSlash64(_ g: [Int], _ local: String) -> Bool {
        guard let l = parse(local), case .v6(let lg) = l.addr else { return false }
        return Array(lg[0..<4]) == Array(g[0..<4])
    }
}
