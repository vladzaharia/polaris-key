// The held Cloud Connect identity (CC-11.1; plans/CC-01-cloud-connect.md §2.3, §3; R-6): the
// signed roster and certificate, the discovery keys (K_disc) and the keys last registered, in
// one Keychain item (`connect-state`, service `pkey:<product>`, `AfterFirstUnlockThisDeviceOnly`,
// never synchronizable), beside the device keys and not in the licence cache (`CACHE_VERSION`
// stays 3).
//
// The roster and the certificate are signed documents and are re-verified on every load, so a
// stored copy that no longer verifies is never used. K_disc is a secret: it is held as
// `DiscoveryKey`, which prints as redacted, and it is written only to this item. A Keychain
// error (locked, denied) is thrown and never taken for "no state". A record that does not
// decode, or carries a version this build does not know, is `.unreadable`: it is never
// overwritten behind the host's back, and only `clear()` (a leave) removes it.

import Foundation

/// One discovery key (K_disc): 32 bytes that never appear in a log, a description or a dump.
public struct DiscoveryKey: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    public let bytes: Data

    public init?(base64url: String) {
        guard let raw = DeviceProofs.raw32(base64url) else { return nil }
        bytes = Data(raw)
    }

    public var base64url: String { Base64URL.encode(bytes) }
    public var description: String { "DiscoveryKey(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// The keys the Worker last accepted for this device (`PUT /<p>/devices/keys`).
public struct RegisteredDeviceKeys: Sendable, Equatable, Codable {
    public let signKey: String
    public let agreeKey: String
    public let keySeq: Int

    public init(signKey: String, agreeKey: String, keySeq: Int) {
        self.signKey = signKey
        self.agreeKey = agreeKey
        self.keySeq = keySeq
    }
}

/// What the store keeps. Internal: hosts read `ConnectIdentity`.
package struct ConnectRecord: Codable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    package static let version = 1
    package var v: Int = ConnectRecord.version
    package var ring: String
    package var certificate: String
    /// Newest first, one or two entries; replaced wholesale by every fetch.
    package var discKeys: [String]
    package var registered: RegisteredDeviceKeys?
    package var storedAt: Int
    /// When the second K_disc (the previous key) was first seen; nil with no previous key.
    package var prevFirstSeen: Int?
    /// A pushed roster removed a device, so the Worker replaced K_disc and this copy is stale until
    /// the next identity fetch (CC-11.4; `keysStale` in Node's record). Nil when false, and then
    /// absent from the stored item.
    package var keysStale: Bool?

    package init(
        ring: String, certificate: String, discKeys: [String], registered: RegisteredDeviceKeys?, storedAt: Int,
        prevFirstSeen: Int? = nil, keysStale: Bool? = nil
    ) {
        self.keysStale = keysStale == true ? true : nil
        self.prevFirstSeen = prevFirstSeen
        self.ring = ring
        self.certificate = certificate
        self.discKeys = discKeys
        self.registered = registered
        self.storedAt = storedAt
    }

    package var description: String { "ConnectRecord(redacted)" }
    package var debugDescription: String { description }
    package var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// The previous K_disc survives a roster change only while no device left or changed its keys
/// (§15.4); otherwise only the newest key is kept.
package func connectKeysAfterRing(_ keys: [String], prior: DeviceRing, next: DeviceRing) -> [String] {
    guard keys.count == 2 else { return keys }
    return prior.devices.allSatisfy { next.devices.contains($0) } ? keys : [keys[0]]
}

public enum ConnectStateError: Error, Sendable, Equatable {
    case keychain(OSStatus)
    case write
    /// A record exists but does not decode, or has an unknown version.
    case unreadable
}

/// Custody of the Connect record for one product.
public final class ConnectStateStore: @unchecked Sendable {
    private let vault: any DeviceKeyVault

    /// The Keychain item for `productSlug`. `accessGroup` shares it with the app's extensions, as
    /// for the device keys.
    public init(productSlug: String, accessGroup: String? = nil) throws {
        guard DeviceProofs.slugOK(productSlug) else { throw DeviceKeyError.unsupported("product") }
        vault = KeychainDeviceKeyVault(
            keychain: SystemKeychain(), service: "pkey:\(productSlug)", accessGroup: accessGroup,
            account: "connect-state")
    }

    /// State that dies with the process.
    public static func inMemory() -> ConnectStateStore { ConnectStateStore(vault: MemoryDeviceKeyVault()) }

    init(vault: any DeviceKeyVault) { self.vault = vault }

    package func load() throws -> ConnectRecord? {
        let blob: Data?
        do { blob = try vault.read() } catch DeviceKeyError.keychain(let s) {
            throw ConnectStateError.keychain(s)
        }
        guard let blob else { return nil }
        guard let r = try? JSONDecoder().decode(ConnectRecord.self, from: blob),
            r.v == ConnectRecord.version
        else { throw ConnectStateError.unreadable }
        return r
    }

    /// Whether an item exists, readable or not. Touches nothing.
    package func exists() throws -> Bool {
        do { return try vault.read() != nil } catch DeviceKeyError.keychain(let s) {
            throw ConnectStateError.keychain(s)
        }
    }

    package func save(_ record: ConnectRecord) throws {
        guard let blob = try? JSONEncoder().encode(record) else { throw ConnectStateError.write }
        do { try vault.upsert(blob) } catch DeviceKeyError.keychain(let s) {
            throw ConnectStateError.keychain(s)
        }
    }

    /// Removes the record: the roster, the certificate and every discovery key, the previous one
    /// included (a device that leaves keeps none).
    package func clear() throws {
        do { try vault.delete() } catch DeviceKeyError.keychain(let s) {
            throw ConnectStateError.keychain(s)
        }
    }
}
