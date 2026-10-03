import Foundation
import Security

/// Keychain generic-password items under service `pkey:<product>` (KeychainStore's tag). The
/// probe takes the accessibility class and access group as parameters so the spike can measure
/// each combination.
public enum SecureStore {
    static func accessibility(_ name: String) -> CFString {
        switch name {
        case "afterFirstUnlockThisDeviceOnly": return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        case "whenUnlocked": return kSecAttrAccessibleWhenUnlocked
        case "whenUnlockedThisDeviceOnly": return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        default: return kSecAttrAccessibleAfterFirstUnlock
        }
    }

    static func base(service: String, account: String, group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public static func set(service: String, account: String, value: String, accessible: String, group: String?) -> JSONObject {
        let q = base(service: service, account: account, group: group)
        let attrs: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: accessibility(accessible),
        ]
        var st = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        var op = "update"
        if st == errSecItemNotFound {
            var add = q
            add.merge(attrs) { $1 }
            st = SecItemAdd(add as CFDictionary, nil)
            op = "add"
        }
        return ["ok": .bool(st == errSecSuccess), "status": .int(Int(st)), "op": .string(op)]
    }

    public static func get(service: String, account: String, group: String?) -> JSONObject {
        var q = base(service: service, account: account, group: group)
        q[kSecReturnData as String] = true
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &item)
        var o: JSONObject = ["ok": .bool(st == errSecSuccess), "status": .int(Int(st))]
        if let d = item as? [String: Any] {
            if let data = d[kSecValueData as String] as? Data { o["value"] = .string(String(decoding: data, as: UTF8.self)) }
            o["accessible"] = .string((d[kSecAttrAccessible as String] as? String) ?? "?")
            o["accessGroup"] = .string((d[kSecAttrAccessGroup as String] as? String) ?? "?")
            o["synchronizable"] = .string("\(d[kSecAttrSynchronizable as String] ?? "nil")")
        }
        return o
    }

    public static func delete(service: String, account: String, group: String?) -> JSONObject {
        let st = SecItemDelete(base(service: service, account: account, group: group) as CFDictionary)
        return ["ok": .bool(st == errSecSuccess || st == errSecItemNotFound), "status": .int(Int(st))]
    }
}
