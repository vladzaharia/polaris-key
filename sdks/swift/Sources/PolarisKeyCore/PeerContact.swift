// WIRE-CONTRACT-V5 §15.10: inter-account links. Swift mirror of client-core's `peer/contact.ts`.
// Pure functions and value types, no I/O: the contact secret, the `CONTACT` body, a link's
// categories, the order of the pairing exchange, the contact list rules, the contact advert and the
// contact room. The vectors are `peer-matrix.json` `contact`.
//
// A contact secret and an agreeKey are key material of the device: nothing here logs one, and
// `StoredContact` prints as redacted. Swift `Data` is copy-on-write and CryptoKit copies its inputs,
// so a secret cannot be zeroed once it has been handed to HKDF or HMAC; callers keep the copies
// they hold short-lived and overwrite the ones they own (`PeerContacts.wipe`).

import CryptoKit
import Foundation

public let maxContacts = 64
public let maxContactCats = 8
public let maxPendingContacts = 8
public let pendingContactSeconds = 86_400
public let maxContactSecrets = maxContacts + maxPendingContacts
public let maxLiveContactAdverts = 8
public let contactBodyMax = 4096
public let contactTicketBodyMax = 256
public let contactLeaseBytes = 1_048_576
public let contactRoomIdleSeconds = 2_592_000
public let contactExchangeSeconds = 30

/// A contact the host holds. `pendingSince` (unix seconds) marks a pending one.
public struct StoredContact: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    public var agreeKey: String
    public var secret: Data
    public var label: String?
    public var cats: [String]
    public var pendingSince: Int?

    public init(agreeKey: String, secret: Data, label: String? = nil, cats: [String], pendingSince: Int? = nil) {
        self.agreeKey = agreeKey
        self.secret = secret
        self.label = label
        self.cats = cats
        self.pendingSince = pendingSince
    }

    public var description: String { "StoredContact(redacted)" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A `CONTACT` body, read.
public struct ContactBody: Sendable, Equatable {
    public let agreeKey: String
    public let label: String?
    public let cats: [String]
}

public enum ContactVerdict: Sendable, Equatable {
    case ok(ContactBody)
    case no
}

public enum ContactExchangeEvent: Sendable, Equatable {
    case ownConfirm
    case peerConfirm
    case peerContact(Data)
    case timeout
}

public struct ContactExchangeStep: Sendable, Equatable {
    /// The records this step makes the side send: `CONFIRM`, `CONTACT`.
    public var sends: [String] = []
    public var close: PeerCloseCode?
    public var stored: (body: ContactBody, pending: Bool)?

    public static func == (a: Self, b: Self) -> Bool {
        a.sends == b.sends && a.close == b.close && a.stored?.body == b.stored?.body
            && a.stored?.pending == b.stored?.pending
    }
}

public enum ContactStoreVerdict: Sendable, Equatable {
    case stored([StoredContact], pending: Bool)
    case full
}

public struct ContactAdvertKey: Sendable {
    public let secret: Data
    public let agreeKey: Data
    public init(secret: Data, agreeKey: Data) {
        self.secret = secret
        self.agreeKey = agreeKey
    }
}

public struct ContactHit: Sendable, Equatable {
    /// Index into the contacts as given.
    public let contact: Int
    /// 0 the current epoch, 1 the previous one.
    public let epochBack: Int
}

public enum ContactTxtResult: Sendable, Equatable {
    case ok
    case refused(String)
}

public enum PeerContacts {
    private static func isCat(_ s: String) -> Bool {
        let u = Array(s.unicodeScalars)
        return (1...32).contains(u.count)
            && u.allSatisfy { ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39) || $0 == "-" }
    }

    private static func validCats(_ c: [String]) -> Bool {
        c.count <= maxContactCats && c.allSatisfy(isCat) && Set(c).count == c.count
    }

    /// 43 canonical base64url characters of 32 bytes that are not a low-order point.
    public static func key32(_ s: String) -> Data? {
        guard s.unicodeScalars.count == 43, let d = Base64URL.decodeStrict(s), d.count == 32 else { return nil }
        return d
    }

    private static func usableKey(_ s: String) -> Bool {
        guard let d = key32(s) else { return false }
        return !DeviceProofs.isX25519LowOrder([UInt8](d))
    }

    private static func lessOrEqual(_ a: Data, _ b: Data) -> Bool {
        !Array(b).lexicographicallyPrecedes(Array(a))
    }

    // MARK: Secret

    /// `HKDF-SHA256(salt = h, ikm = nD || nM, info = "pkey-peer/1 contact" 0x00 lo hi)`, 32 bytes.
    public static func secret(h: Data, nD: Data, nM: Data, agreeKeyA: Data, agreeKeyB: Data) throws -> Data {
        guard agreeKeyA.count == 32, agreeKeyB.count == 32 else { throw PeerNoiseError.badKey }
        let (lo, hi) = lessOrEqual(agreeKeyA, agreeKeyB) ? (agreeKeyA, agreeKeyB) : (agreeKeyB, agreeKeyA)
        return PeerNoiseHash.hkdfSHA256(
            salt: h, ikm: nD + nM, info: Data("pkey-peer/1 contact".utf8) + [0] + lo + hi, length: 32)
    }

    // MARK: Body

    private static func clean(_ raw: String) -> String? { normalizeDeviceLabel(raw.precomposedStringWithCanonicalMapping) }

    private static func quoted(_ s: String) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self)
    }

    /// The bytes of a `CONTACT` body. Throws `PeerNoiseError.badKey` for a body the peer would refuse.
    public static func buildContact(agreeKey: String, label: String?, cats: [String]) throws -> Data {
        guard usableKey(agreeKey), validCats(cats) else { throw PeerNoiseError.badKey }
        var s = #"{"v":1,"agreeKey":"\#(agreeKey)""#
        if let label, let l = clean(label) { s += #","label":\#(quoted(l))"# }
        s += #","cats":[\#(cats.map(quoted).joined(separator: ","))]}"#
        let b = Data(s.utf8)
        guard b.count <= contactBodyMax else { throw PeerNoiseError.badKey }
        return b
    }

    /// Judge one `CONTACT` body. `own` is the reader's own agreeKey: a body that carries it is no contact.
    public static func parseContact(_ body: Data, own: String? = nil) -> ContactVerdict {
        guard body.count <= contactBodyMax, let (o, nonWire) = PeerPayload.parseStrictObject(body),
            case .int(let v)? = o["v"], wireInteger(v, pointer: "/v", min: 1, in: nonWire), v == 1,
            case .string(let key)? = o["agreeKey"], usableKey(key), key != own,
            case .array(let items)? = o["cats"]
        else { return .no }
        var cats: [String] = []
        for i in items {
            guard case .string(let c) = i else { return .no }
            cats.append(c)
        }
        guard validCats(cats) else { return .no }
        var label: String?
        if let l = o["label"] {
            guard case .string(let raw) = l else { return .no }
            label = clean(raw)
        }
        return .ok(ContactBody(agreeKey: key, label: label, cats: cats))
    }

    /// A link's categories: the entries both sides list, once each, in byte order.
    public static func categories(_ a: [String], _ b: [String]) -> [String] {
        Array(Set(a.filter { b.contains($0) })).sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
    }

    // MARK: Exchange

    /// One side's order guard over the records of the exchange (§15.10, "Order of checks").
    public struct Exchange: Sendable {
        private let own: String?
        private let held: [String]
        private var ownConfirmed = false
        private var peerConfirmed = false
        private var contactSent = false
        private var peerContact = false
        private var dead = false

        public init(own: String?, held: [String] = []) {
            self.own = own
            self.held = held
        }

        public var waiting: Bool { !dead && ownConfirmed && !peerContact }

        public mutating func step(_ e: ContactExchangeEvent) -> ContactExchangeStep {
            var r = ContactExchangeStep()
            if dead { return r }
            func bad(_ r: inout ContactExchangeStep, _ me: inout Exchange) -> ContactExchangeStep {
                me.dead = true
                r.close = .peerBadFrame
                return r
            }
            switch e {
            case .ownConfirm:
                ownConfirmed = true
                r.sends.append("CONFIRM")
                if peerConfirmed && !contactSent {
                    contactSent = true
                    r.sends.append("CONTACT")
                }
                return r
            case .peerConfirm:
                if peerConfirmed { return bad(&r, &self) }
                peerConfirmed = true
                if ownConfirmed && !contactSent {
                    contactSent = true
                    r.sends.append("CONTACT")
                }
                return r
            case .peerContact(let body):
                if !ownConfirmed || !peerConfirmed || peerContact { return bad(&r, &self) }
                guard case .ok(let b) = PeerContacts.parseContact(body, own: own) else { return bad(&r, &self) }
                let pending = held.contains(b.agreeKey)
                if !pending && held.count >= maxContacts {
                    dead = true
                    r.close = .peerNotAllowed
                    return r
                }
                peerContact = true
                r.stored = (b, pending)
                return r
            case .timeout:
                if ownConfirmed && !peerContact {
                    dead = true
                    r.close = .peerTimeout
                }
                return r
            }
        }
    }

    // MARK: List

    private static func active(_ l: [StoredContact]) -> [StoredContact] { l.filter { $0.pendingSince == nil } }

    /// Store a contact the exchange produced (§15.10): active when the key is new, pending when held.
    public static func store(_ list: [StoredContact], incoming: StoredContact, now: Int) -> ContactStoreVerdict {
        var inc = incoming
        inc.pendingSince = nil
        let held = active(list).contains { $0.agreeKey == inc.agreeKey }
        if !held {
            if active(list).count >= maxContacts { return .full }
            return .stored(list + [inc], pending: false)
        }
        var next = list.filter { !($0.pendingSince != nil && $0.agreeKey == inc.agreeKey) }
        inc.pendingSince = now
        next.append(inc)
        while next.filter({ $0.pendingSince != nil }).count > maxPendingContacts {
            var oldest: Int?
            for (i, c) in next.enumerated() {
                guard let p = c.pendingSince else { continue }
                if oldest == nil || p < next[oldest!].pendingSince! { oldest = i }
            }
            next.remove(at: oldest!)
        }
        return .stored(next, pending: true)
    }

    /// A handshake under a pending contact's secret passed the pin: it replaces the held contact.
    public static func promote(_ list: [StoredContact], agreeKey: String) -> [StoredContact] {
        guard let pi = list.firstIndex(where: { $0.pendingSince != nil && $0.agreeKey == agreeKey }) else { return list }
        var fresh = list[pi]
        fresh.pendingSince = nil
        var out: [StoredContact] = []
        for (i, c) in list.enumerated() {
            if i == pi { continue }
            out.append(c.pendingSince == nil && c.agreeKey == agreeKey ? fresh : c)
        }
        return out
    }

    public static func dropStalePending(_ list: [StoredContact], now: Int) -> [StoredContact] {
        list.filter { $0.pendingSince == nil || now - $0.pendingSince! < pendingContactSeconds }
    }

    /// Active contacts in held order, then pending ones in the order stored, at most 72.
    public static func trialOrder(_ list: [StoredContact]) -> [StoredContact] {
        Array((list.filter { $0.pendingSince == nil } + list.filter { $0.pendingSince != nil }).prefix(maxContactSecrets))
    }

    /// Mode c: the remote static key must be the agreeKey of the contact whose secret opened the session.
    public static func pin(held: String, remoteStatic: Data) -> Bool { Base64URL.encode(remoteStatic) == held }

    // MARK: Advert

    private static func u64be(_ n: Int) -> Data {
        let u = UInt64(max(0, n))
        return Data((0..<8).map { UInt8((u >> UInt64(56 - 8 * $0)) & 0xff) })
    }

    public static func instance(secret: Data, advertiserAgreeKey: Data, epoch: Int) -> String {
        let mac = PeerNoiseHash.hmacSHA256(
            key: secret, Data("pkey-peer/1 cdisc".utf8) + [0] + u64be(epoch) + advertiserAgreeKey)
        return "p1-" + String(PeerAdvert.base32Lower(mac).prefix(16))
    }

    /// `v=1` and `m=c`; an entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated key refuses.
    public static func parseTxt(_ entries: [String]) -> ContactTxtResult {
        var kv: [String: String] = [:]
        for e in entries {
            guard let at = e.firstIndex(of: "="), at != e.startIndex else { continue }
            let k = String(e[e.startIndex..<at])
            if kv[k] != nil { return .refused("duplicate") }
            kv[k] = String(e[e.index(after: at)...])
        }
        guard kv["v"] == "1" else { return .refused("version") }
        guard kv["m"] == "c" else { return .refused("mode") }
        return .ok
    }

    /// Which contact an instance belongs to: the first of the first 72 that matches in this or the last epoch.
    public static func browse(instance name: String, contacts: [ContactAdvertKey], now: Int) -> ContactHit? {
        guard PeerAdvert.isInstanceName(name) else { return nil }
        let epoch = peerAdvertEpoch(now)
        for (i, c) in contacts.prefix(maxContactSecrets).enumerated() {
            for back in 0...1
            where instance(secret: c.secret, advertiserAgreeKey: c.agreeKey, epoch: epoch - back) == name {
                return ContactHit(contact: i, epochBack: back)
            }
        }
        return nil
    }

    // MARK: Room

    public static func rid(secret: Data) -> String {
        Base64URL.encode(
            PeerNoiseHash.hkdfSHA256(salt: Data(), ikm: secret, info: Data("pkey-peer/1 room".utf8), length: 32).prefix(16))
    }

    private static func ridBytes(_ rid: String) -> Data? {
        guard rid.unicodeScalars.count == 22, let d = Base64URL.decodeStrict(rid), d.count == 16 else { return nil }
        return d
    }

    /// `SHA-256(rid || deviceId)[0..24]` over the 16 decoded rid bytes and the 24 decoded device-id bytes.
    public static func alias(rid: String, deviceId: String) throws -> Data {
        guard let r = ridBytes(rid) else { throw PeerAdvertError.deviceId }
        return PeerNoiseHash.sha256(r, try PeerAdvert.deviceIdBytes(deviceId)).prefix(24)
    }

    public static func ticketBody(rid: String) throws -> Data {
        guard ridBytes(rid) != nil else { throw PeerAdvertError.deviceId }
        return Data(#"{"room":"c","rid":"\#(rid)"}"#.utf8)
    }

    /// A ticket-request body: strict JSON of at most 256 bytes with exactly `room` = "c" and a canonical `rid`.
    public static func parseTicketBody(_ bytes: Data) -> String? {
        guard bytes.count <= contactTicketBodyMax, let (o, _) = PeerPayload.parseStrictObject(bytes), o.count == 2,
            case .string("c")? = o["room"], case .string(let rid)? = o["rid"], ridBytes(rid) != nil
        else { return nil }
        return rid
    }
}
