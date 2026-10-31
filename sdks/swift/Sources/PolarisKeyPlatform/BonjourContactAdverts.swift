// The contact adverts of Cloud Connect's inter-account links (CC-19.7; WIRE-CONTRACT-V5 §15.4, §15.10).
// Standalone, like the rest of this target: it moves a name and a TXT record and knows no protocol.
//
// `NWListener` registers one Bonjour service, and the listener's one service is the account advert. A
// device with links also advertises up to 8 contact instances (`m=c`) that all name the same listener
// port, so they are registered here with DNS-SD directly (`DNSServiceRegister`, the daemon `NWListener`
// itself uses). Rules this file keeps:
//  - a name is registered exactly as asked: `kDNSServiceFlagsNoAutoRename` makes a conflict an error, and
//    the registration is then withdrawn, never kept under another name (as `BonjourListener` does);
//  - the set is replaced as a whole: names no longer wanted are deregistered, new ones registered, the
//    ones kept are left alone (no flapping inside an epoch);
//  - nothing is registered off Apple platforms or without Network.framework.

import Foundation

/// The TXT record bytes of `key=value` entries: each entry preceded by its length (RFC 6763 section 6).
/// An entry over 255 bytes is dropped.
public func bonjourTxtBytes(_ entries: [String]) -> Data {
    var out = Data()
    for e in entries {
        let b = Array(e.utf8)
        guard b.count <= 255 else { continue }
        out.append(UInt8(b.count))
        out.append(contentsOf: b)
    }
    return out
}

#if canImport(Network)
    import dnssd

    public final class BonjourContactAdverts: @unchecked Sendable {
        private final class Slot {
            var ref: DNSServiceRef?
            let name: String
            let onWithdrawn: @Sendable (String) -> Void
            init(name: String, onWithdrawn: @escaping @Sendable (String) -> Void) {
                self.name = name
                self.onWithdrawn = onWithdrawn
            }
        }

        private let lock = NSLock()
        private let queue = DispatchQueue(label: "im.plrs.key.bonjour-contact-adverts")
        private var slots: [String: Slot] = [:]
        private let onWithdrawn: @Sendable (String) -> Void

        /// `onWithdrawn` is told the name of a registration the daemon refused or removed.
        public init(onWithdrawn: @escaping @Sendable (String) -> Void = { _ in }) { self.onWithdrawn = onWithdrawn }

        /// Make the live set exactly `adverts` on `port`.
        public func update(_ adverts: [BonjourAdvert], port: UInt16) {
            lock.withLock {
                let want = Set(adverts.map(\.instance))
                for (name, slot) in slots where !want.contains(name) {
                    release(slot)
                    slots[name] = nil
                }
                for a in adverts where slots[a.instance] == nil {
                    let slot = Slot(name: a.instance, onWithdrawn: onWithdrawn)
                    let txt = bonjourTxtBytes(a.txt)
                    let ctx = Unmanaged.passRetained(slot).toOpaque()
                    var ref: DNSServiceRef?
                    let err = txt.withUnsafeBytes { raw -> DNSServiceErrorType in
                        DNSServiceRegister(
                            &ref, DNSServiceFlags(kDNSServiceFlagsNoAutoRename), 0, a.instance, bonjourPeerServiceType,
                            nil, nil, port.bigEndian, UInt16(txt.count), raw.baseAddress,
                            { _, _, error, name, _, _, ctx in
                                guard let ctx else { return }
                                let s = Unmanaged<Slot>.fromOpaque(ctx).takeUnretainedValue()
                                if error != kDNSServiceErr_NoError { s.onWithdrawn(s.name) }
                                _ = name
                            }, ctx)
                    }
                    if err != kDNSServiceErr_NoError || ref == nil {
                        Unmanaged<Slot>.fromOpaque(ctx).release()
                        onWithdrawn(a.instance)
                        continue
                    }
                    slot.ref = ref
                    DNSServiceSetDispatchQueue(ref, queue)
                    slots[a.instance] = slot
                }
            }
        }

        public func stop() {
            lock.withLock {
                for slot in slots.values { release(slot) }
                slots = [:]
            }
        }

        public var names: [String] { lock.withLock { slots.keys.sorted() } }

        private func release(_ slot: Slot) {
            if let r = slot.ref {
                DNSServiceRefDeallocate(r)
                slot.ref = nil
            }
            Unmanaged.passUnretained(slot).release()  // balances `passRetained` in `update`
        }
    }
#endif
