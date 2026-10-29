// DNS-SD resolution of a Bonjour browse hit, before any connect (WIRE-CONTRACT-V5 §15.4, §15.4.1; the
// rule itself is `LanResolve`). `DNSServiceResolve` gives the SRV target and port on the interface
// the browse reported; `DNSServiceGetAddrInfo` gives the target's addresses, each with the interface
// index it was answered on. Nothing here opens a socket to the peer. A hit with no network endpoint,
// or one that is not a service, resolves to nothing: the OS resolver is never left to pick an
// address at connect time.

import Foundation

#if canImport(Network)
    import Network
    import dnssd

    /// One result of resolving a service on one interface.
    struct BonjourResolution: Sendable {
        /// The SRV port (host order). Not yet range-checked.
        let port: Int
        let addresses: [LanResolvedAddress]
    }

    enum BonjourResolver {
        /// This device's interfaces as the subnet test needs them. Tunnel, point-to-point and
        /// pseudo-interfaces (a VPN, `utun`, `ppp`, `gif`, WireGuard) and any interface with no
        /// hardware address are marked `tunnel`.
        static func localInterfaces() -> [LanInterface] {
            var head: UnsafeMutablePointer<ifaddrs>?
            guard getifaddrs(&head) == 0, let first = head else { return [] }
            defer { freeifaddrs(head) }
            struct Acc {
                var flags: UInt32 = 0
                var hasHardware = false
                var addresses: [LanInterfaceAddress] = []
            }
            var byName: [String: Acc] = [:]
            var order: [String] = []
            var next: UnsafeMutablePointer<ifaddrs>? = first
            while let cur = next {
                defer { next = cur.pointee.ifa_next }
                let name = String(cString: cur.pointee.ifa_name)
                if byName[name] == nil {
                    byName[name] = Acc()
                    order.append(name)
                }
                byName[name]!.flags |= cur.pointee.ifa_flags
                guard let sa = cur.pointee.ifa_addr else { continue }
                switch Int32(sa.pointee.sa_family) {
                case AF_LINK:
                    let hw = sa.withMemoryRebound(to: sockaddr_dl.self, capacity: 1) { $0.pointee.sdl_alen }
                    if hw > 0 { byName[name]!.hasHardware = true }
                case AF_INET:
                    guard let mask = cur.pointee.ifa_netmask else { continue }
                    let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin_addr) { Array($0) }
                    }
                    let m = mask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin_addr) { Array($0) }
                    }
                    byName[name]!.addresses.append(LanInterfaceAddress(bytes: a, prefix: prefixLength(m)))
                case AF_INET6:
                    guard let mask = cur.pointee.ifa_netmask else { continue }
                    let a = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0) }
                    }
                    let m = mask.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0) }
                    }
                    byName[name]!.addresses.append(LanInterfaceAddress(bytes: a, prefix: prefixLength(m)))
                default:
                    break
                }
            }
            return order.compactMap { name in
                guard let acc = byName[name] else { return nil }
                let index = Int(if_nametoindex(name))
                guard index > 0 else { return nil }
                let loopback = acc.flags & UInt32(IFF_LOOPBACK) != 0
                return LanInterface(
                    index: index, name: name, up: acc.flags & UInt32(IFF_UP) != 0, loopback: loopback,
                    tunnel: !loopback
                        && (acc.flags & UInt32(IFF_POINTOPOINT) != 0 || !acc.hasHardware
                            || tunnelName(name)),
                    addresses: acc.addresses)
            }
        }

        static func tunnelName(_ n: String) -> Bool {
            ["utun", "ppp", "ipsec", "gif", "stf", "tun", "tap", "wg"].contains { n.hasPrefix($0) }
        }

        static func prefixLength(_ mask: [UInt8]) -> Int {
            var n = 0
            for b in mask {
                if b == 0xFF {
                    n += 8
                    continue
                }
                var m = b
                while m & 0x80 != 0 {
                    n += 1
                    m <<= 1
                }
                break
            }
            return n
        }

        /// This device's own IPv6 addresses on up interfaces, as text. With `interface` only that
        /// interface's addresses.
        static func ownIPv6Addresses(interface: String? = nil) -> [String] {
            localInterfaces().filter { $0.up && (interface == nil || $0.name == interface) }.flatMap { i in
                i.addresses.filter { $0.bytes.count == 16 }.compactMap { lanAddressText(bytes: $0.bytes) }
            }
        }

        /// Resolve `name` on `interfaceIndex`: the SRV port, then the target's addresses. Completes
        /// within `timeout` seconds; a hit that never resolves is `.timedOut`.
        static func resolve(
            name: String, type: String, domain: String, interfaceIndex: Int, timeout: TimeInterval
        ) async throws -> BonjourResolution {
            try await withCheckedThrowingContinuation { cont in
                let job = Job(
                    name: name, type: type, domain: domain, interfaceIndex: UInt32(interfaceIndex), timeout: timeout,
                    done: { cont.resume(with: $0) })
                job.start()
            }
        }

        /// One resolve-then-addrinfo run on a private serial queue. All state is touched on `queue`.
        private final class Job: @unchecked Sendable {
            let name: String, type: String, domain: String
            let interfaceIndex: UInt32
            let timeout: TimeInterval
            let queue = DispatchQueue(label: "im.plrs.key.bonjour-resolve")
            var ended = false
            let done: @Sendable (Result<BonjourResolution, Error>) -> Void
            var resolveRef: DNSServiceRef?
            var addrRef: DNSServiceRef?
            var port = 0
            var found: [LanResolvedAddress] = []
            var settle: DispatchWorkItem?

            init(
                name: String, type: String, domain: String, interfaceIndex: UInt32, timeout: TimeInterval,
                done: @escaping @Sendable (Result<BonjourResolution, Error>) -> Void
            ) {
                self.name = name
                self.type = type
                self.domain = domain
                self.interfaceIndex = interfaceIndex
                self.timeout = timeout
                self.done = done
            }

            func start() {
                queue.async { [self] in
                    let ctx = Unmanaged.passRetained(self).toOpaque()
                    let err = DNSServiceResolve(
                        &resolveRef, 0, interfaceIndex, name, type, domain,
                        { _, _, _, error, _, host, port, _, _, ctx in
                            let job = Unmanaged<Job>.fromOpaque(ctx!).takeUnretainedValue()
                            job.onResolved(error: error, host: host.map { String(cString: $0) }, port: port)
                        }, ctx)
                    if err != kDNSServiceErr_NoError { return end(.failure(Self.map(err))) }
                    DNSServiceSetDispatchQueue(resolveRef, queue)
                    queue.asyncAfter(deadline: .now() + timeout) { [self] in
                        // A run with addresses already in hand finishes on its own settle timer.
                        if found.isEmpty { end(.failure(BonjourPipeError.timedOut)) }
                    }
                }
            }

            /// Called on `queue` by the SRV callback. The ref is released on a later turn, not inside
            /// its own callback.
            func onResolved(error: DNSServiceErrorType, host: String?, port network: UInt16) {
                queue.async { [self] in
                    guard !ended, addrRef == nil else { return }
                    if error != kDNSServiceErr_NoError { return end(.failure(Self.map(error))) }
                    guard let host else { return end(.failure(BonjourPipeError.unresolvable)) }
                    port = Int(UInt16(bigEndian: network))
                    // The target is known; the SRV query is done.
                    if let r = resolveRef {
                        DNSServiceRefDeallocate(r)
                        resolveRef = nil
                    }
                    lookup(host)
                }
            }

            func lookup(_ host: String) {
                let ctx = Unmanaged.passUnretained(self).toOpaque()
                let err = DNSServiceGetAddrInfo(
                    &addrRef, 0, interfaceIndex,
                    UInt32(kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6), host,
                    { _, flags, index, error, _, sa, _, ctx in
                        let job = Unmanaged<Job>.fromOpaque(ctx!).takeUnretainedValue()
                        job.onAddress(flags: flags, index: index, error: error, sa: sa)
                    }, ctx)
                if err != kDNSServiceErr_NoError { return end(.failure(Self.map(err))) }
                DNSServiceSetDispatchQueue(addrRef, queue)
            }

            func onAddress(
                flags: DNSServiceFlags, index: UInt32, error: DNSServiceErrorType, sa: UnsafePointer<sockaddr>?
            ) {
                guard !ended, error == kDNSServiceErr_NoError, flags & DNSServiceFlags(kDNSServiceFlagsAdd) != 0,
                    let sa
                else { return }
                var bytes: [UInt8]?
                switch Int32(sa.pointee.sa_family) {
                case AF_INET:
                    bytes = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin_addr) { Array($0) }
                    }
                case AF_INET6:
                    bytes = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                        withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0) }
                    }
                default: break
                }
                guard let bytes else { return }
                let r = LanResolvedAddress(bytes: bytes, interfaceIndex: Int(index))
                if !found.contains(r) { found.append(r) }
                // Give the other family a moment (RFC 8305's resolution delay), then finish.
                settle?.cancel()
                let item = DispatchWorkItem { [self] in end(.success(BonjourResolution(port: port, addresses: found))) }
                settle = item
                queue.asyncAfter(deadline: .now() + 0.25, execute: item)
            }

            func end(_ r: Result<BonjourResolution, Error>) {
                guard !ended else { return }
                ended = true
                settle?.cancel()
                if let x = resolveRef {
                    DNSServiceRefDeallocate(x)
                    resolveRef = nil
                }
                if let x = addrRef {
                    DNSServiceRefDeallocate(x)
                    addrRef = nil
                }
                done(r)
                Unmanaged.passUnretained(self).release()  // balances `start`
            }

            static func map(_ e: DNSServiceErrorType) -> BonjourPipeError {
                switch BonjourErrors.classify(dnsError: e) {
                case .permissionDenied: return .browse(.permissionDenied)
                case .notConfigured: return .browse(.notConfigured)
                case .unavailable(let t): return .failed(t)
                }
            }
        }
    }
#endif
