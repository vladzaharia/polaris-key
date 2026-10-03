// Keychain storage for the device id and the licence token (notes/S-09 §Results 3):
//
//   - generic-password items under service `pkey:<product>` (KeychainStore's tag), one account
//     per value (`device`, `token`);
//   - the DATA-PROTECTION keychain (`kSecUseDataProtectionKeychain`), never synchronizable;
//   - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for both values: readable after first
//     unlock (so a background launch can read them) and never restored onto another device from a
//     backup. The token is bound to the device id, so moving it to a new device is worse than
//     re-activating;
//   - NO explicit access group and no `keychain-access-groups` entitlement: the default group is
//     app-private, and the Background Assets extension must never read either value (notes/E9
//     §7.1). An explicit group outside the entitlements fails with -34018.
//
// This differs from PolarisKeyCore's `KeychainStore`, which writes the token with
// `kSecAttrAccessibleAfterFirstUnlock` (restorable from an encrypted backup) and keeps the device
// id in a 0600 file. That store is unchanged here; the difference is raised for the Swift SDK's
// owner (P5-05 report). On the iOS simulator items survive uninstall and reinstall while a
// `user://` file does not; on a device that is undocumented (S-09 checklist row 6).

import Foundation

#if canImport(Security)
import Security

/// The four `SecItem*` calls, behind a seam: a test bundle without a host app gets -34018 for
/// everything, so `swift test` drives a fake.
public protocol KeychainBackend: Sendable {
    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?)
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

/// Security.framework.
public struct SystemKeychainBackend: KeychainBackend {
    public init() {}

    public func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        var item: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &item) { SecItemCopyMatching(query as CFDictionary, $0) }
        return (status, item as? Data)
    }

    public func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }

    public func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    public func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
}

/// Keychain get / set / delete for one product.
public struct SecureStore: Sendable {
    /// Product slugs and account names: what a `pkey:<product>` service may carry.
    static let namePattern = "^[a-z0-9][a-z0-9._-]{0,63}$"

    public let product: String
    private let backend: any KeychainBackend

    public init(product: String, backend: any KeychainBackend = SystemKeychainBackend()) {
        self.product = product
        self.backend = backend
    }

    public var service: String { "pkey:\(product)" }

    static func validName(_ s: String) -> Bool { s.range(of: namePattern, options: .regularExpression) != nil }

    /// The item's identity: class, service, account, the data-protection keychain, never
    /// synchronizable, and no access group.
    func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false,
        ]
    }

    /// `{ok, value}` (`value` null when absent) or `{ok:false, error, status}`.
    public func get(account: String) -> PlatformObject {
        guard Self.validName(product), Self.validName(account) else { return Self.invalid }
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = backend.copyMatching(q)
        switch status {
        case errSecSuccess:
            guard let data, let value = String(data: data, encoding: .utf8) else {
                return ["ok": false, "error": "not_utf8", "status": .int(Int(status))]
            }
            return ["ok": true, "value": .string(value)]
        case errSecItemNotFound:
            return ["ok": true, "value": .null]
        default:
            return ["ok": false, "error": "keychain", "status": .int(Int(status))]
        }
    }

    /// Update the item, or add it when absent. `{ok, op}` or `{ok:false, error, status}`.
    public func set(account: String, value: String) -> PlatformObject {
        guard Self.validName(product), Self.validName(account) else { return Self.invalid }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = backend.update(query(account), attributes)
        var op = "update"
        if status == errSecItemNotFound {
            var add = query(account)
            add.merge(attributes) { $1 }
            status = backend.add(add)
            op = "add"
        }
        if status == errSecSuccess { return ["ok": true, "op": .string(op)] }
        return ["ok": false, "error": "keychain", "status": .int(Int(status)), "op": .string(op)]
    }

    /// `{ok}`; an absent item is success.
    public func delete(account: String) -> PlatformObject {
        guard Self.validName(product), Self.validName(account) else { return Self.invalid }
        let status = backend.delete(query(account))
        if status == errSecSuccess || status == errSecItemNotFound { return ["ok": true] }
        return ["ok": false, "error": "keychain", "status": .int(Int(status))]
    }

    static let invalid: PlatformObject = ["ok": false, "error": "invalid_name"]
}
#endif
