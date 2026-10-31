// Resolve-then-judge for a Bonjour browse hit (WIRE-CONTRACT-V5 §15.4 "Addresses", §15.4.1). Swift
// leaves address learning to the OS, so it cannot test a packet's source. It tests what it resolved,
// before it connects: the hit is resolved with DNS-SD on the interface the browse reported (the
// interface index comes back with every address), each address is judged by `lanVerdict` and must lie
// in a connected subnet of the interface it came back on, and only those addresses are dialled.
// Pure here: numbers in, the dialable addresses out. The `dnssd` calls and `getifaddrs` are in
// `BonjourResolve.swift`.
//
// What remains, and is the stated residual: the address is resolver-returned, not source-equal. An
// on-link host can publish an address of the connected subnet for a name it does not own, and the
// device then dials it (one connect and Noise message 1, which the handshake then refuses); it never
// reaches a trusted address. The interface of the answer is the resolver's word.

/// An address a browse hit resolved to, with the interface index it was answered on.
struct LanResolvedAddress: Equatable, Sendable {
    /// 4 (IPv4) or 16 (IPv6) bytes, network order.
    let bytes: [UInt8]
    let interfaceIndex: Int
}

/// One interface address and the length of its prefix.
struct LanInterfaceAddress: Equatable, Sendable {
    let bytes: [UInt8]
    let prefix: Int
}

/// What the subnet test needs to know about one interface.
struct LanInterface: Equatable, Sendable {
    let index: Int
    let name: String
    let up: Bool
    let loopback: Bool
    /// A VPN, `utun`, point-to-point or pseudo-interface, or one with no hardware address: never counts.
    let tunnel: Bool
    let addresses: [LanInterfaceAddress]

    init(
        index: Int, name: String, up: Bool = true, loopback: Bool = false, tunnel: Bool = false,
        addresses: [LanInterfaceAddress]
    ) {
        self.index = index
        self.name = name
        self.up = up
        self.loopback = loopback
        self.tunnel = tunnel
        self.addresses = addresses
    }
}

/// One address that may be dialled, on the interface named by `interfaceIndex`.
struct LanTarget: Equatable, Sendable {
    let bytes: [UInt8]
    let interfaceIndex: Int
    let interfaceName: String
    /// The address as text, with the interface name as zone for a link-local address.
    let text: String
}

enum LanResolve {
    /// A name keeps at most this many addresses, first-seen order (§15.4).
    static let maxAddresses = 4
    /// The SRV port must be at least this (§15.4); the top is the 16-bit limit.
    static let minPort = 1024

    /// An SRV port that the rule allows.
    static func portAllowed(_ port: Int) -> Bool { (minPort...65535).contains(port) }

    /// The first `maxAddresses` resolved addresses that pass, in order: the interface counts (up, and
    /// neither loopback unless `allowLoopback` nor a tunnel), `lanVerdict` allows the address, and the
    /// address lies in a connected subnet of the interface it was answered on. A link-local address is
    /// on-link by definition and is dialled with the interface name as zone. A ULA or global address
    /// needs an address of the interface in the same /64 as its `local`.
    static func dialable(_ resolved: [LanResolvedAddress], interfaces: [LanInterface], allowLoopback: Bool)
        -> [LanTarget]
    {
        var out: [LanTarget] = []
        for r in resolved {
            if out.count >= maxAddresses { break }
            guard let iface = interfaces.first(where: { $0.index == r.interfaceIndex }), iface.up,
                !iface.tunnel, allowLoopback || !iface.loopback,
                let text = lanAddressText(bytes: r.bytes, zone: r.bytes.first == 0xFE ? iface.name : nil),
                let parsed = LanAddr.parse(text)
            else { continue }
            // A resolver answers an IPv4 address as A, never as an IPv4-mapped AAAA.
            if r.bytes.count == 16, case .v4 = parsed.addr { continue }
            let ok: Bool
            switch parsed.addr {
            case .v4(let o):
                ok =
                    lanVerdict(text, local: nil, allowLoopback: allowLoopback).dial
                    && iface.addresses.contains { $0.bytes.count == 4 && inSubnet(o.map(UInt8.init), $0) }
            case .v6(let g):
                if (g[0] & 0xFFC0) == 0xFE80 {
                    ok = lanVerdict(text, local: nil, allowLoopback: allowLoopback).dial
                } else {
                    // Check against each of the interface's own addresses that holds the subnet.
                    ok = iface.addresses.contains { a in
                        guard a.bytes.count == 16, inSubnet(r.bytes, a),
                            let local = lanAddressText(bytes: a.bytes)
                        else { return false }
                        return lanVerdict(text, local: local, allowLoopback: allowLoopback).dial
                    }
                }
            }
            guard ok else { continue }
            let t = LanTarget(bytes: r.bytes, interfaceIndex: iface.index, interfaceName: iface.name, text: text)
            if !out.contains(t) { out.append(t) }
        }
        return out
    }

    /// `address` is inside the connected subnet `iface` (same length, first `prefix` bits equal).
    static func inSubnet(_ address: [UInt8], _ iface: LanInterfaceAddress) -> Bool {
        guard address.count == iface.bytes.count, (0...address.count * 8).contains(iface.prefix) else {
            return false
        }
        var bits = iface.prefix
        for i in 0..<address.count {
            if bits <= 0 { break }
            let mask: UInt8 = bits >= 8 ? 0xFF : UInt8(truncatingIfNeeded: 0xFF << (8 - bits))
            if (address[i] & mask) != (iface.bytes[i] & mask) { return false }
            bits -= 8
        }
        return true
    }
}
