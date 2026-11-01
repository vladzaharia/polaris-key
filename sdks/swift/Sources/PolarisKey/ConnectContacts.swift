// Inter-account links as the Swift SDK holds them (CC-19.7; WIRE-CONTRACT-V5 §15.10): the contact rows of
// the Connect record and the pure steps that change them. The rules (the cap of 64, the pending contacts,
// the trial order, the 24 h lapse) are `PeerContacts`'; this file carries the SDK's own columns
// (`createdAt`, `reachable`) across those calls. Mirrors sdk-node's `connect/contacts.ts`.
//
// Rules this file keeps:
//  - a contact secret is key material: it is decoded for a call and overwritten after where the type
//    allows (`wipe`), it is in no `ContactInfo`, no error and no print, and `ContactInfo` carries no key.
//    `Data` is copy-on-write and CryptoKit copies what it is given, so a copy inside HKDF or HMAC cannot be
//    zeroed; the copies this SDK owns are;
//  - an `id` is derived from the peer's agreeKey (a public key) and names a link on this device only:
//    SHA-256("pkey-contact/1" 0x00 agreeKey)[0..12] in base64url, 16 characters.

import Foundation
import PolarisKeyCore

/// How long a discovery answer of `interAccount: true` counts without a fresh read (24 h).
let interAccountTTLSeconds = 24 * 60 * 60

/// What the host sees of one link. No key of any kind.
public struct ContactInfo: Sendable, Equatable {
    /// Names the link on this device (16 characters). Not the peer's key and not shared.
    public let id: String
    /// The label stored when the link was made: display data the other person chose.
    public let label: String?
    /// The data categories both people approved, in byte order.
    public let categories: [String]
    /// Unix seconds.
    public let createdAt: Int
    /// Advertised on the LAN and kept in a relay room (at most 8 at once).
    public let reachable: Bool
    /// A newer pairing with the same peer waits for its first handshake (§15.10).
    public let rePairPending: Bool
}

/// The link a session was made over.
public struct ConnectContactRef: Sendable, Equatable {
    public let id: String
    public let label: String?
    public let categories: [String]
    /// The peer's agreeKey, 43 base64url characters (a public key).
    public let agreeKey: String
    /// The session was opened under a pending contact: it is the first handshake of a re-pair.
    public let pending: Bool
    /// A one-way tag of the secret the session opened under (not the secret).
    public internal(set) var tag: String = ""
}

/// A contact in use: the row with its secret decoded. `wipe()` overwrites the secret this value owns.
public struct ConnectLiveContact: Sendable, CustomStringConvertible, CustomReflectable {
    public let id: String
    public let agreeKey: String
    public let agreeKeyBytes: Data
    public let secret: Data
    public let label: String?
    public let cats: [String]
    public let reachable: Bool
    public let pending: Bool

    /// A one-way tag of this contact's secret: tells two secrets apart without holding either.
    public var tag: String { ConnectContacts.tag(secret) }

    public var ref: ConnectContactRef {
        ConnectContactRef(id: id, label: label, categories: cats, agreeKey: agreeKey, pending: pending, tag: tag)
    }

    public var description: String { "ConnectLiveContact(redacted)" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A listener list that a host callback cannot break.
final class ConnectSignal: Sendable {
    private struct S {
        var next = 0
        var fns: [(Int, @Sendable () -> Void)] = []
    }
    private let state = LockedValue(S())
    func add(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.next += 1
            s.fns.append((s.next, fn))
            return s.next
        }
        return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
    }
    func fire() { for f in state.with({ $0.fns.map(\.1) }) { f() } }
}

enum ConnectContacts {
    static func id(_ agreeKey: String) -> String {
        let raw = Base64URL.decode(agreeKey) ?? Data()
        return Base64URL.encode(PeerNoiseHash.sha256(Data("pkey-contact/1".utf8), Data([0]), raw).prefix(12))
    }

    static func tag(_ secret: Data) -> String {
        Base64URL.encode(PeerNoiseHash.sha256(Data("pkey-contact-tag/1".utf8), Data([0]), secret).prefix(12))
    }

    static func live(_ r: ConnectContactRow) -> ConnectLiveContact {
        ConnectLiveContact(
            id: id(r.agreeKey), agreeKey: r.agreeKey, agreeKeyBytes: Base64URL.decode(r.agreeKey) ?? Data(),
            secret: Base64URL.decode(r.secret) ?? Data(), label: r.label, cats: r.cats, reachable: r.reachable,
            pending: r.pendingSince != nil)
    }

    private static func key(_ r: ConnectContactRow) -> String { "\(r.agreeKey)|\(r.pendingSince == nil ? "h" : "p")" }

    private static func stored(_ r: ConnectContactRow) -> StoredContact {
        StoredContact(
            agreeKey: r.agreeKey, secret: Base64URL.decode(r.secret) ?? Data(), label: r.label, cats: r.cats,
            pendingSince: r.pendingSince)
    }

    private static func storedKey(_ c: StoredContact) -> String { "\(c.agreeKey)|\(c.pendingSince == nil ? "h" : "p")" }

    /// The contacts in trial order (held first, then pending), decoded.
    static func trialOrder(_ rows: [ConnectContactRow]) -> [ConnectLiveContact] {
        let by = Dictionary(rows.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        return PeerContacts.trialOrder(rows.map(stored)).compactMap { by[storedKey($0)].map(live) }
    }

    static func info(_ rows: [ConnectContactRow]) -> [ContactInfo] {
        let pending = Set(rows.filter { $0.pendingSince != nil }.map(\.agreeKey))
        return rows.filter { $0.pendingSince == nil }.map {
            ContactInfo(
                id: id($0.agreeKey), label: $0.label, categories: $0.cats, createdAt: $0.createdAt,
                reachable: $0.reachable, rePairPending: pending.contains($0.agreeKey))
        }
    }

    /// Store a contact the pairing produced (`PeerContacts.store`); the new one is reachable.
    static func store(
        _ rows: [ConnectContactRow], agreeKey: String, secret: Data, label: String?, cats: [String], now: Int
    ) -> (rows: [ConnectContactRow], pending: Bool)? {
        let incoming = StoredContact(agreeKey: agreeKey, secret: secret, label: label, cats: cats)
        guard case .stored(let list, let pending) = PeerContacts.store(rows.map(stored), incoming: incoming, now: now)
        else { return nil }
        let keep = Dictionary(rows.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        // The new contact is the last in the list when active; when pending it is the one stored at `now`.
        var out: [ConnectContactRow] = []
        for (i, c) in list.enumerated() {
            let isNew = pending ? (c.pendingSince == now && c.agreeKey == agreeKey) : i == list.count - 1
            if !isNew, let was = keep[storedKey(c)] {
                out.append(was)
            } else {
                out.append(
                    ConnectContactRow(
                        agreeKey: c.agreeKey, secret: Base64URL.encode(c.secret), label: c.label, cats: c.cats,
                        createdAt: now, reachable: true, pendingSince: c.pendingSince))
            }
        }
        return (out, pending)
    }

    /// A handshake under the pending contact of `agreeKey` passed the pin: it takes the held one's place.
    static func promote(_ rows: [ConnectContactRow], agreeKey: String, tag: String? = nil) -> [ConnectContactRow] {
        guard
            let pend = rows.first(where: {
                $0.pendingSince != nil && $0.agreeKey == agreeKey
                    && (tag == nil || Self.tag(Base64URL.decode($0.secret) ?? Data()) == tag)
            })
        else { return rows }
        let held = rows.first { $0.pendingSince == nil && $0.agreeKey == agreeKey }
        return PeerContacts.promote(rows.map(stored), agreeKey: agreeKey).compactMap { c in
            if c.pendingSince == nil && c.agreeKey == agreeKey {
                // The new link: its secret, label and categories; the held one's reachability stays.
                return ConnectContactRow(
                    agreeKey: agreeKey, secret: pend.secret, label: pend.label, cats: pend.cats,
                    createdAt: pend.createdAt, reachable: held?.reachable ?? pend.reachable)
            }
            return rows.first { key($0) == storedKey(c) }
        }
    }

    static func dropStale(_ rows: [ConnectContactRow], now: Int) -> [ConnectContactRow] {
        let keep = Set(PeerContacts.dropStalePending(rows.map(stored), now: now).map(storedKey))
        return rows.filter { keep.contains(key($0)) }
    }
}

extension ConnectClient {
    /// The cached discovery answer `services.connect.interAccount` (§15.9, §15.10 "Gates"): true only while
    /// the product's setting, `launch.connectLinks` and the service are on. It never fetches: false while no
    /// document is held.
    public func interAccount() async -> Bool {
        // A cached answer lapses (`interAccountTTLSeconds`); a failed or empty re-read clears it.
        if let until = linksUntil.current, await core.now() >= until { return false }
        guard let f = await core.discoveryDocument?.services[.connect] else { return false }
        return f.enabled && f.extras["interAccount"] == .bool(true)
    }

    /// A discovery read finished: stamp the cached answer, or clear it when the read was not a document.
    func noteDiscovery(ok: Bool) async {
        linksUntil.set(ok ? await core.now() + interAccountTTLSeconds : 0)
    }

    /// Whether the contact a session opened under is still held (same peer key, same secret) and links are
    /// still on.
    func holdsContact(agreeKey: String, tag: String) async -> Bool {
        if !(await interAccount()) { return false }
        return (await contactRows()).contains {
            $0.agreeKey == agreeKey && ConnectContacts.tag(Base64URL.decode($0.secret) ?? Data()) == tag
        }
    }

    /// The contact rows held for this device, pending ones that lapsed (24 h) dropped. Empty without a held
    /// identity. The rows carry secrets: they stay inside the SDK.
    func contactRows() async -> [ConnectContactRow] {
        await acquire()
        defer { release() }
        guard let store = try? store(), let rec = try? store.load(), let rows = rec.contacts else { return [] }
        let kept = ConnectContacts.dropStale(rows, now: await core.now())
        if kept.count != rows.count { try? writeContacts(rec, kept, store) }
        return kept
    }

    /// Change the contact rows under the state lock: `fn` gets the current rows and the time and returns the
    /// new rows, or nil for no change. Throws `ConnectLanError` `noIdentity` without a held identity.
    @discardableResult
    func updateContacts(_ fn: ([ConnectContactRow], Int) -> [ConnectContactRow]?) async throws -> [ConnectContactRow] {
        await acquire()
        defer { release() }
        let store: ConnectStateStore
        let rec: ConnectRecord?
        do {
            store = try self.store()
            rec = try store.load()
        } catch { throw ConnectLanError(.noIdentity, "The Connect record could not be read.") }
        guard let rec else {
            throw ConnectLanError(.noIdentity, "No Cloud Connect identity is held; call identity() first.")
        }
        let now = await core.now()
        let base = ConnectContacts.dropStale(rec.contacts ?? [], now: now)
        guard let next = fn(base, now) else { return base }
        do { try writeContacts(rec, next, store) } catch {
            throw ConnectLanError(.noIdentity, "The links could not be stored.")
        }
        contactChanges.fire()
        return next
    }

    private func writeContacts(_ rec: ConnectRecord, _ rows: [ConnectContactRow], _ store: ConnectStateStore) throws {
        var r = rec
        r.contacts = rows.isEmpty ? nil : rows
        try store.save(r)
    }

    /// The live contacts in trial order, decoded; empty while the gate is off.
    func liveContacts() async -> [ConnectLiveContact] {
        guard await interAccount() else { return [] }
        return ConnectContacts.trialOrder(await contactRows())
    }

    /// Called when the contacts changed or the `interAccount` answer may have.
    nonisolated func onContactsChanged(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        contactChanges.add(fn)
    }

    /// Tell the listeners the contacts or the gate moved.
    public nonisolated func notifyContacts() { contactChanges.fire() }

    /// This device's agreeKey, 43 base64url characters (a public key).
    func ownAgreeKey() async throws -> String {
        guard let port = try? keyPort(), let pub = try? await port.publicKeys() else {
            throw ConnectLanError(.noKeys, "The device keys are not held.")
        }
        return pub.agreeKey
    }
}
