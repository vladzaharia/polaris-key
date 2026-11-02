// Linux has no Security framework and no Keychain. The Keychain-backed stores still compile
// there, against the names below, and answer with the typed "unimplemented" status on first
// use; a host without a Keychain asks for the in-memory stores or the file-backed ones. The
// platform matrix lists the Keychain and the Secure Enclave as unsupported off Apple platforms.

#if !canImport(Security)
    import Foundation

    public typealias OSStatus = Int32

    let errSecSuccess: OSStatus = 0
    let errSecUnimplemented: OSStatus = -4
    let errSecItemNotFound: OSStatus = -25300
    let errSecDuplicateItem: OSStatus = -25299
    let errSecMissingEntitlement: OSStatus = -34018

    let kSecClass = "class"
    let kSecClassGenericPassword = "genp"
    let kSecAttrService = "svce"
    let kSecAttrAccount = "acct"
    let kSecAttrAccessGroup = "agrp"
    let kSecAttrAccessible = "pdmn"
    let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "cku"
    let kSecAttrSynchronizable = "sync"
    let kSecReturnAttributes = "r_Attributes"
    let kSecValueData = "v_Data"
    let kSecReturnData = "r_Data"
    let kSecMatchLimit = "m_Limit"
    let kSecMatchLimitOne = "m_LimitOne"
    let kSecUseDataProtectionKeychain = "nleg"

    /// The Keychain seam's Linux implementation: every call fails with `errSecUnimplemented`.
    struct SystemKeychain: KeychainAPI {
        func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) { (errSecUnimplemented, nil) }
        func add(_ attributes: [String: Any]) -> OSStatus { errSecUnimplemented }
        func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus { errSecUnimplemented }
        func delete(_ query: [String: Any]) -> OSStatus { errSecUnimplemented }
    }

    /// There is no Secure Enclave: the store keeps its raw keys, or reports `.unsupported`.
    struct SecureEnclaveWrapper: DeviceKeyWrapping {
        static var isAvailable: Bool { false }
        func wrap(_ plain: Data, aad: Data) throws -> WrappedKey {
            throw DeviceKeyError.unsupported("secure-enclave")
        }
        func unwrap(_ w: WrappedKey, aad: Data) throws -> Data {
            throw DeviceKeyError.unsupported("secure-enclave")
        }
    }
#endif
