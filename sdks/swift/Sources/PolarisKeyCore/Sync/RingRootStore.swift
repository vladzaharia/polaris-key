// Where a device keeps the Cloud Sync root between launches (D-8): one Keychain item (service
// `pkey:<product>`, account `sync-root`, `AfterFirstUnlockThisDeviceOnly`, never synchronizable),
// beside the Connect record. The ring pin (`{ringId, epoch, rootKid}`, no secret) is not here: it
// lives in the Core store (`SyncRingPin`). The iCloud Keychain backup of the root is its own item
// in `PlatformBackupStore` (U-39.5), written by `SyncKeyring`.

import Foundation

/// The root and the ring it belongs to. It prints as redacted.
package struct StoredRingRoot: Codable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    package static let version = 1
    package var v: Int = StoredRingRoot.version
    package var ringId: String
    package var epoch: Int
    /// Lowercase hex of `kid(root)`.
    package var kid: String
    /// base64url of the 32-byte root.
    package var root: String

    package init(ringId: String, epoch: Int, kid: String, root: String) {
        self.ringId = ringId
        self.epoch = epoch
        self.kid = kid
        self.root = root
    }

    package var description: String { "StoredRingRoot(redacted)" }
    package var debugDescription: String { description }
    package var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// The pin: the first ring this device acquired a root for. It holds no secret.
public struct SyncRingPin: Codable, Sendable, Equatable {
    public var ringId: String
    public var epoch: Int
    public var rootKid: String

    public init(ringId: String, epoch: Int, rootKid: String) {
        self.ringId = ringId
        self.epoch = epoch
        self.rootKid = rootKid
    }
}

public enum RingRootStoreError: Error, Sendable, Equatable {
    case keychain(OSStatus)
    case write
    case unreadable
}

/// Custody of the root for one product.
public final class RingRootStore: @unchecked Sendable {
    private let vault: any DeviceKeyVault

    public init(productSlug: String, accessGroup: String? = nil) throws {
        guard DeviceProofs.slugOK(productSlug) else { throw DeviceKeyError.unsupported("product") }
        vault = KeychainDeviceKeyVault(
            keychain: SystemKeychain(), service: "pkey:\(productSlug)", accessGroup: accessGroup,
            account: "sync-root")
    }

    /// A root that dies with the process.
    public static func inMemory() -> RingRootStore { RingRootStore(vault: MemoryDeviceKeyVault()) }

    init(vault: any DeviceKeyVault) { self.vault = vault }

    package func load() throws -> StoredRingRoot? {
        let blob: Data?
        do { blob = try vault.read() } catch DeviceKeyError.keychain(let s) {
            throw RingRootStoreError.keychain(s)
        }
        guard let blob else { return nil }
        guard let r = try? JSONDecoder().decode(StoredRingRoot.self, from: blob),
            r.v == StoredRingRoot.version
        else { throw RingRootStoreError.unreadable }
        return r
    }

    package func save(_ record: StoredRingRoot) throws {
        guard let blob = try? JSONEncoder().encode(record) else { throw RingRootStoreError.write }
        do { try vault.upsert(blob) } catch DeviceKeyError.keychain(let s) {
            throw RingRootStoreError.keychain(s)
        }
    }

    /// Removes the root. A failure throws, so a sign-out stops rather than leave it behind.
    public func clear() throws {
        do { try vault.delete() } catch DeviceKeyError.keychain(let s) {
            throw RingRootStoreError.keychain(s)
        }
    }
}
