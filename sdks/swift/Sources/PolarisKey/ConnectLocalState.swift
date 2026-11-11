// Local links as the Swift SDK holds them (CC-29.11; WIRE-CONTRACT-V5 §15.12): the rows of the local-link record
// (`LocalLinkState.swift` in the core) and the pure steps that change them, the types the host sees, the typed
// errors and the name index a browser reads. Mirrors sdk-node's `connect/localState.ts` and `localCommon.ts`.
//
// Rules this file keeps:
//  - a link secret and a link private key are key material: `LocalLinkInfo` carries neither, `ConnectLiveLocal`
//    prints as redacted, and no error names one. `Data` is copy-on-write and CryptoKit copies what it is given, so
//    a copy inside HKDF or HMAC cannot be zeroed; the copies this SDK owns are released, not overwritten;
//  - an `id` is derived from the peer's link key (a public key) and names a link on this device only;
//  - the cap (`maxLocalLinks`) is judged where the row is added, under the store's one actor, so two pairings that
//    finish together cannot both pass it.

import Foundation
import PolarisKeyCore

/// What the host sees of one local link. No key and no secret.
public struct LocalLinkInfo: Sendable, Equatable {
    /// Names the link on this device (16 characters). Not the peer's key and not shared.
    public let id: String
    /// The peer's label, or the one the person gave it with `rename`.
    public let label: String?
    /// The data categories both people approved, in byte order.
    public let categories: [String]
    /// Unix seconds.
    public let createdAt: Int
    /// Unix seconds, coarsened to the hour; nil when no session has been seen.
    public let lastSeen: Int?
    /// Advertised on the LAN (at most 8 at once).
    public let reachable: Bool
    /// The other device's platform as it reported it when you paired, one of the `Platform` values; nil when it
    /// reported none we know, and for a link made before this was stored. Display only: it is not authenticated.
    public let platform: String?
}

/// The local link a session was made over (mode `l`). No key, no secret.
public struct ConnectLocalRef: Sendable, Equatable {
    public let id: String
    /// The stored label, or the one the person gave it with `rename`.
    public let label: String?
    public let categories: [String]
    /// The peer's link public key, 43 base64url characters.
    public let peerKey: String
    /// A one-way tag of the secret the session opened under (not the secret).
    public let tag: String
}

/// A link in use: the row with its keys and secret decoded.
public struct ConnectLiveLocal: Sendable, CustomStringConvertible, CustomReflectable {
    public let id: String
    public let ownKey: Data
    public let ownPublic: Data
    public let peerKey: Data
    public let secret: Data
    public let label: String?
    public let cats: [String]
    public let reachable: Bool
    public let tag: String

    public var ref: ConnectLocalRef {
        ConnectLocalRef(
            id: id, label: label, categories: cats, peerKey: Base64URL.encode(peerKey), tag: tag)
    }

    public var channel: PeerLocalLink { PeerLocalLink(secret: secret, ownKey: ownKey, peerKey: peerKey) }

    public var description: String { "ConnectLiveLocal(redacted)" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

enum ConnectLocals {
    static func live(_ r: LocalLinkRow) -> ConnectLiveLocal {
        let secret = Base64URL.decode(r.secret) ?? Data()
        return ConnectLiveLocal(
            id: r.id, ownKey: Base64URL.decode(r.ownKey) ?? Data(), ownPublic: Base64URL.decode(r.ownPublic) ?? Data(),
            peerKey: Base64URL.decode(r.peerKey) ?? Data(), secret: secret, label: r.label, cats: r.cats,
            reachable: r.reachable, tag: PeerLocal.linkTag(secret: secret))
    }

    static func info(_ rows: [LocalLinkRow]) -> [LocalLinkInfo] {
        rows.map {
            LocalLinkInfo(
                id: $0.id, label: $0.label, categories: $0.cats, createdAt: $0.createdAt, lastSeen: $0.lastSeen,
                reachable: $0.reachable, platform: $0.platform)
        }
    }

    /// `lastSeen` is written at most hourly, coarsened to the hour (§15.12).
    static func hour(_ t: Int) -> Int { t - t % 3600 }
}

/// Why a local-pairing call refused, with its registered code (`ErrorCode`): `pairing-code-failed`,
/// `pairing-not-found`, `local-links-full`, `peer-closed`, `store-failed`. `reason` and `cap` are for display and
/// hold no digit: `pairing-code-failed` carries `invalid`, `otherApp`, `spent` or `wrong`; `peer-closed` one of
/// `declined`, `timeout`, `closed` or `cooldown`; `local-links-full` a `cap`.
public struct LocalPairingError: Error, Sendable, Equatable, CustomStringConvertible {
    public enum Reason: String, Sendable, Equatable {
        case invalid
        case otherApp = "other-app"
        case spent, wrong
        case declined, timeout, closed, cancelled, cooldown
    }
    /// Which limit `local-links-full` hit.
    public enum Cap: String, Sendable, Equatable {
        /// The device holds `maxLocalLinks`.
        case stored
        /// Eight links are already advertised.
        case reachable
    }
    public let code: String
    public let message: String
    public let reason: Reason?
    public let cap: Cap?
    public init(_ code: String, _ message: String, reason: Reason? = nil, cap: Cap? = nil) {
        self.code = code
        self.message = message
        self.reason = reason
        self.cap = cap
    }
    public var description: String { "LocalPairingError(\(code))" }
}

/// Pairing with a code is off for this product (the typed N/A, code `local-pairing-off`): the cached discovery
/// answer `services.connect.localPairing` is not true (§15.12, "Gates").
public struct LocalPairingOff: Error, Sendable, Equatable, CustomStringConvertible {
    public let code = ErrorCode.localPairingOff
    public let unsupported: Unsupported
    init(_ what: String) {
        unsupported = Unsupported(
            feature: Feature.connectLocal, reason: "product",
            detail: "Pairing with a code is off for this product (\(what)).")
    }
    public var description: String { unsupported.description }
}

/// The links this device holds for one product, one actor so every change is atomic.
actor LocalLinkStore {
    private let state: LocalLinkStateStore

    init(_ state: LocalLinkStateStore) { self.state = state }

    private func fail(_ e: Error) -> LocalPairingError {
        LocalPairingError(ErrorCode.storeFailed, "The local links could not be used.")
    }

    /// The rows, with their keys and secrets: they stay inside the SDK.
    func rows() throws -> [LocalLinkRow] {
        do { return try state.load() } catch { throw fail(error) }
    }

    func count() throws -> Int { try rows().count }

    /// Change the rows: `fn` returns the new rows (or nil for no change) and a result. Resolves with the result.
    @discardableResult
    func update<T: Sendable>(_ fn: @Sendable ([LocalLinkRow]) -> (next: [LocalLinkRow]?, result: T)) throws -> T {
        let base = try rows()
        let out = fn(base)
        if let next = out.next {
            do { try state.save(next) } catch { throw fail(error) }
        }
        return out.result
    }

    enum Added: Equatable {
        case stored(id: String)
        case full
        /// `allowed` said no inside the store call: the gate cleared, so nothing was written.
        case off
    }

    /// Add a link, unless the device already holds `maxLocalLinks`. Reachable by default; with the live-advert
    /// limit already reached the new link is stored off and the list says so (§15.12, "Reachable by default").
    ///
    /// `allowed` is read inside the store's update, under its one actor: a pairing that was already storing when the
    /// gate cleared writes nothing (`.off`).
    func add(
        ownKey: Data, ownPublic: Data, peerKey: Data, secret: Data, label: String?, cats: [String], now: Int,
        platform: String? = nil, allowed: (@Sendable () -> Bool)? = nil
    ) throws -> Added {
        let id = PeerLocal.linkId(peerKey: peerKey)
        let (ownB, pubB, peerB, secB) = (
            Base64URL.encode(ownKey), Base64URL.encode(ownPublic), Base64URL.encode(peerKey), Base64URL.encode(secret)
        )
        return try update { rows -> (next: [LocalLinkRow]?, result: Added) in
            if let allowed, !allowed() { return (nil, .off) }
            if rows.count >= maxLocalLinks { return (nil, .full) }
            let others = rows.filter { $0.id != id }
            let reachable = others.filter(\.reachable).count < maxLiveLocalAdverts
            let row = LocalLinkRow(
                id: id, ownKey: ownB, ownPublic: pubB, peerKey: peerB, secret: secB, label: label, cats: cats,
                createdAt: now, reachable: reachable, platform: platform)
            return (others + [row], .stored(id: id))
        }
    }

    /// Write `lastSeen` for a link when the hour is newer than the stored one.
    @discardableResult
    func touch(id: String, now: Int) -> Bool {
        let hour = ConnectLocals.hour(now)
        return
            (try? update { rows -> (next: [LocalLinkRow]?, result: Bool) in
                guard let i = rows.firstIndex(where: { $0.id == id }), (rows[i].lastSeen ?? -1) < hour else {
                    return (nil, false)
                }
                var next = rows
                next[i].lastSeen = hour
                return (next, true)
            }) ?? false
    }
}

/// Browse names to local links (§15.12): one dictionary per (15-minute epoch, link list), built from the links'
/// secrets and the peers' link keys for the current and the previous epoch, so a forged `p1-` name costs one lookup
/// and no HMAC. At most 32 links x 2 epochs = 64 HMACs a rebuild. The first match wins in held order. It holds
/// names and ids only, never a secret.
final class ConnectLocalIndex: Sendable {
    private struct State {
        var epoch = Int.min
        var table: [String: String] = [:]
    }
    private let state = LockedValue(State())

    /// Rebuild for `now`'s epoch from `locals` (in held order).
    func update(_ locals: [ConnectLiveLocal], now: Int) {
        let epoch = peerAdvertEpoch(now)
        var table: [String: String] = [:]
        for l in locals.prefix(maxLocalLinks) {
            for back in 0...1 where epoch - back >= 0 {
                let n = PeerLocal.localInstance(secret: l.secret, advertiserLinkKey: l.peerKey, epoch: epoch - back)
                if table[n] == nil { table[n] = l.id }
            }
        }
        state.with {
            $0.epoch = epoch
            $0.table = table
        }
    }

    func lookup(_ instance: String, now: Int) -> String? {
        guard PeerAdvert.isInstanceName(instance) else { return nil }
        return state.with { $0.epoch == peerAdvertEpoch(now) ? $0.table[instance] : nil }
    }

    func stale(now: Int) -> Bool { state.with { $0.epoch != peerAdvertEpoch(now) } }

    func clear() {
        state.with {
            $0.epoch = .min
            $0.table = [:]
        }
    }
}
