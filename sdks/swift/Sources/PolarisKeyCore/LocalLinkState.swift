// The local-link store, `pkey.connect.local.v1` (CC-29.11; WIRE-CONTRACT-V5 §15.12, "What each side stores"): the
// links this device holds for one product, each with its own link private key and the link secret, in one
// Keychain item (`connect-local`, service `pkey:<product>`, `AfterFirstUnlockThisDeviceOnly`, never synchronizable),
// beside the device keys and the Connect record and not in either. It is not account data: a sign-out, a licence
// deactivation and an account deletion leave it alone, and `ConnectClient.leave()` does not touch it.
//
// Rules this file keeps:
//  - the record is parsed strictly; one that exists but does not decode, is another schema's or product's, or
//    holds a row that breaks a rule is `.unreadable`, never silently replaced (replacing it would forget the
//    held links);
//  - a private key and a secret are fields of the record and of nothing else here: they print as redacted, and
//    `LocalLinkRow` is `package`, so no host sees one;
//  - the cap (`maxLocalLinks`, 32) is a rule of the record: more rows are unreadable.

import Foundation

/// One link as it rests in the record. Keys and the secret are canonical base64url of 32 bytes.
package struct LocalLinkRow: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// Names the link on this device: `PeerLocal.linkId(peerKey:)`, 16 characters.
    package var id: String
    /// This device's private key for the link: the static key of every session under it.
    package var ownKey: String
    package var ownPublic: String
    package var peerKey: String
    package var secret: String
    /// The peer's label, cleaned; a rename replaces it on this device only.
    package var label: String?
    package var cats: [String]
    package var createdAt: Int
    package var lastSeen: Int?
    /// The host's local "advertise this link on the LAN" choice.
    package var reachable: Bool

    package init(
        id: String, ownKey: String, ownPublic: String, peerKey: String, secret: String, label: String?, cats: [String],
        createdAt: Int, lastSeen: Int? = nil, reachable: Bool
    ) {
        self.id = id
        self.ownKey = ownKey
        self.ownPublic = ownPublic
        self.peerKey = peerKey
        self.secret = secret
        self.label = label
        self.cats = cats
        self.createdAt = createdAt
        self.lastSeen = lastSeen
        self.reachable = reachable
    }

    package var description: String { "LocalLinkRow(redacted)" }
    package var debugDescription: String { description }
    package var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }

    private static func idOK(_ s: String) -> Bool {
        let u = Array(s.unicodeScalars)
        return u.count == 16
            && u.allSatisfy {
                ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5a)
                    || ($0.value >= 0x61 && $0.value <= 0x7a) || $0 == "-" || $0 == "_"
            }
    }

    /// A row that breaks a rule makes the whole record unusable (a hand-edited item is not trusted).
    package var valid: Bool {
        LocalLinkRow.idOK(id) && PeerContacts.key32(ownKey) != nil && PeerContacts.key32(ownPublic) != nil
            && PeerContacts.key32(peerKey) != nil && PeerContacts.key32(secret) != nil && PeerLocal.validCats(cats)
            && createdAt >= 0 && (lastSeen ?? 0) >= 0
    }
}

/// What the store keeps. Internal: hosts read `LocalLinkInfo`.
struct LocalLinkRecord: Codable {
    static let schema = "pkey.connect.local.v1"
    var schema: String = LocalLinkRecord.schema
    var product: String
    var links: [LocalLinkRow]
}

public enum LocalLinkStateError: Error, Sendable, Equatable {
    case keychain(OSStatus)
    case write
    /// A record exists but does not decode, is another schema's or product's, or breaks a rule.
    case unreadable
}

/// Custody of the local-link record for one product.
public final class LocalLinkStateStore: @unchecked Sendable {
    private let vault: any DeviceKeyVault
    private let product: String

    /// The Keychain item for `productSlug`. `accessGroup` shares it with the app's extensions, as for the device
    /// keys.
    public init(productSlug: String, accessGroup: String? = nil) throws {
        guard DeviceProofs.slugOK(productSlug) else { throw DeviceKeyError.unsupported("product") }
        product = productSlug
        vault = KeychainDeviceKeyVault(
            keychain: SystemKeychain(), service: "pkey:\(productSlug)", accessGroup: accessGroup,
            account: "connect-local")
    }

    /// State that dies with the process.
    public static func inMemory(productSlug: String) -> LocalLinkStateStore {
        LocalLinkStateStore(vault: MemoryDeviceKeyVault(), product: productSlug)
    }

    init(vault: any DeviceKeyVault, product: String) {
        self.vault = vault
        self.product = product
    }

    /// The rows; empty when no item exists. Throws `.unreadable` for an item that does not parse.
    package func load() throws -> [LocalLinkRow] {
        let blob: Data?
        do { blob = try vault.read() } catch DeviceKeyError.keychain(let s) { throw LocalLinkStateError.keychain(s) }
        guard let blob else { return [] }
        guard let r = try? JSONDecoder().decode(LocalLinkRecord.self, from: blob), r.schema == LocalLinkRecord.schema,
            r.product == product, r.links.count <= maxLocalLinks, r.links.allSatisfy(\.valid),
            Set(r.links.map(\.id)).count == r.links.count
        else { throw LocalLinkStateError.unreadable }
        return r.links
    }

    package func save(_ rows: [LocalLinkRow]) throws {
        guard rows.count <= maxLocalLinks,
            let blob = try? JSONEncoder().encode(LocalLinkRecord(product: product, links: rows))
        else { throw LocalLinkStateError.write }
        do { try vault.upsert(blob) } catch DeviceKeyError.keychain(let s) { throw LocalLinkStateError.keychain(s) }
    }

    /// Removes the record: every key and secret of every link.
    package func clear() throws {
        do { try vault.delete() } catch DeviceKeyError.keychain(let s) { throw LocalLinkStateError.keychain(s) }
    }
}
