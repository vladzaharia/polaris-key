// The device key port and its Apple store (CC-26.4; plans/CC-01.md R-5, R-6, Q12). Swift mirror
// of client-core's `DeviceKeyPort` (deviceKeys.ts).
//
// A device holds two software Curve25519 keys: Ed25519 to sign and X25519 to agree. The Secure
// Enclave does not do Curve25519, so the store never claims the SE holds them. What it does:
//
//   - Where a Secure Enclave is present and usable, the raw private keys are WRAPPED to a
//     P-256 Secure Enclave key (ECDH with an ephemeral key, HKDF-SHA256, AES-256-GCM, the
//     generation and the product bound in as authenticated data). The SE key is created with
//     `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and `.privateKeyUsage`; CryptoKit gives
//     its opaque `dataRepresentation`, which is the only thing kept. The wrapped record sits in
//     the Keychain. The raw keys are unwrapped for one operation and dropped. Protection:
//     `.secureEnclaveWrapped`.
//   - Where it is not (a Mac without a T2 or Apple silicon, a simulator, an unsigned binary
//     the SE refuses), the raw keys are the Keychain item's data, which the Keychain encrypts at
//     rest. Protection: `.keychain`.
//
// Either way the item is a generic password (service `pkey:<product>`, account `device-keys`)
// with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: never synced, never in a backup that
// restores to another device. The data-protection keychain comes first; on macOS a process
// without the entitlement (-34018) uses the legacy file keychain and migrates on a later read,
// as `KeychainStore` does. A host with no Keychain at all asks for `DeviceKeyStore.inMemory()`,
// whose `persistence()` is `.memory`; the proof helpers then refuse to register its keys.
//
// The private halves are never part of the API: the port returns public keys, signatures and
// shared secrets. Swift gives no control over copies of key bytes in memory; the store holds
// them only inside one operation. A record it cannot open is never replaced behind the
// host's back: a malformed one throws `.unreadable`, a failed unwrap throws `.wrap`, a Keychain
// error (locked, denied) is thrown, and none is taken for "no keys". `wipe()` is the way out.

import CryptoKit
import Foundation
import Security

/// A device's two public keys: raw 32 bytes, canonical base64url (43 characters).
public struct DevicePublicKeys: Sendable, Equatable {
    public var signKey: String
    public var agreeKey: String
    /// The local generation: 1 for the first pair, plus one on every `rotate()`.
    public var generation: Int
}

public enum DeviceKeyPersistence: String, Sendable {
    case durable
    case memory
}

/// How the private halves are protected at rest.
public enum DeviceKeyProtection: String, Sendable {
    case secureEnclaveWrapped = "secure-enclave-wrapped"
    case keychain
    case memory
}

/// Whether to wrap the keys with the Secure Enclave.
public enum SecureEnclaveUse: Sendable {
    /// Wrap where an SE is present and works; otherwise keep the raw keys in the Keychain.
    /// `DeviceKeyStore.protection()` says which one a pair got.
    case ifAvailable
    /// Never fall back: a missing or refusing SE is `DeviceKeyError.unsupported`.
    case required
    /// Raw keys in the Keychain only.
    case never
}

public enum DeviceKeyError: Error, Sendable, Equatable {
    /// The store cannot hold or use the keys here, or must not register them ("memory-only").
    case unsupported(String)
    /// No keys yet: `sign` and `dh` do not make them.
    case noKeys
    /// A Keychain call failed with this status.
    case keychain(OSStatus)
    /// The wrap or unwrap failed for a reason that may pass (the device is locked).
    case wrap
    /// The stored record is malformed or fails to open. Nothing replaces it behind the host's
    /// back: `wipe()` is the way out, and a new identity registers again.
    case unreadable
    /// A wipe left the item behind.
    case wipeIncomplete
}

/// Custody of one device's signing (Ed25519) and agreement (X25519) keys. Keys are made on first
/// need and never leave the port.
public protocol DeviceKeyPort: Sendable {
    /// The public keys, making the key pair first if the store holds none.
    func ensure() async throws -> DevicePublicKeys
    /// The public keys, or nil when the store holds none. Never makes keys.
    func publicKeys() async throws -> DevicePublicKeys?
    /// The 64-byte Ed25519 signature by the signing key over `message`.
    func sign(_ message: Data) async throws -> Data
    /// X25519 with the agreement key and a peer's raw public key; nil when the peer key is
    /// refused (wrong length, low order) or the secret would be all zero.
    func dh(_ peerPublic: Data) async throws -> Data?
    /// Replaces both keys with a new pair and returns it (`generation` + 1).
    func rotate() async throws -> DevicePublicKeys
    /// Where the keys live. A `.memory` port must not register keys.
    func persistence() async throws -> DeviceKeyPersistence
    /// Deletes both keys. The next `ensure()` makes a new pair, with `generation` starting again.
    func wipe() async throws
}

// ── Storage seams (internal; tests inject fakes) ─────────────────────────────────────

/// One opaque blob for one product.
protocol DeviceKeyVault: Sendable {
    func read() throws -> Data?
    /// Stores `blob` only if nothing is there; false when something is.
    func insert(_ blob: Data) throws -> Bool
    /// Stores `blob`, replacing any item. Last writer wins: there is no compare-and-swap, so two
    /// processes rotating at once keep whichever wrote last (Keychain updates cannot match the
    /// old value). Hosts that share keys across processes should rotate from one.
    func upsert(_ blob: Data) throws
    func delete() throws
}

/// What `wrap` produces; the store serialises it.
struct WrappedKey: Codable, Sendable, Equatable {
    var handle: Data
    var ephemeral: Data
    var sealed: Data
}

protocol DeviceKeyWrapping: Sendable {
    func wrap(_ plain: Data, aad: Data) throws -> WrappedKey
    func unwrap(_ w: WrappedKey, aad: Data) throws -> Data
}

// ── The Secure Enclave wrapper ───────────────────────────────────────────────────────

struct SecureEnclaveWrapper: DeviceKeyWrapping {
    private static let info = Data("pkey-device-keys/1 wrap".utf8)

    static var isAvailable: Bool { SecureEnclave.isAvailable }

    private func symmetricKey(_ shared: SharedSecret, ephemeral: Data) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: Data(), sharedInfo: Self.info + ephemeral, outputByteCount: 32)
    }

    func wrap(_ plain: Data, aad: Data) throws -> WrappedKey {
        var err: Unmanaged<CFError>?
        guard
            let access = SecAccessControlCreateWithFlags(
                nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &err)
        else { throw DeviceKeyError.wrap }
        // Only a permanently absent SE is "unsupported" (the store may fall back); any other
        // failure may pass and is `.wrap`.
        guard Self.isAvailable else { throw DeviceKeyError.unsupported("secure-enclave") }
        do {
            let se = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
            let eph = P256.KeyAgreement.PrivateKey()
            let epk = eph.publicKey.x963Representation
            let shared = try eph.sharedSecretFromKeyAgreement(with: se.publicKey)
            let box = try AES.GCM.seal(plain, using: symmetricKey(shared, ephemeral: epk), authenticating: aad)
            guard let combined = box.combined else { throw DeviceKeyError.wrap }
            return WrappedKey(handle: se.dataRepresentation, ephemeral: epk, sealed: combined)
        } catch let e as DeviceKeyError {
            throw e
        } catch { throw DeviceKeyError.wrap }
    }

    func unwrap(_ w: WrappedKey, aad: Data) throws -> Data {
        // Only a malformed ephemeral point is a format error. A handle the SE will not open, a
        // failed agreement and a failed GCM open all rethrow as `.wrap`: they can be transient
        // (locked, busy) or an attack, and none may cost the device its identity.
        let epub: P256.KeyAgreement.PublicKey
        do { epub = try P256.KeyAgreement.PublicKey(x963Representation: w.ephemeral) } catch {
            throw DeviceKeyError.unreadable
        }
        do {
            let se = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: w.handle)
            let shared = try se.sharedSecretFromKeyAgreement(with: epub)
            return try AES.GCM.open(
                AES.GCM.SealedBox(combined: w.sealed), using: symmetricKey(shared, ephemeral: w.ephemeral),
                authenticating: aad)
        } catch { throw DeviceKeyError.wrap }
    }
}

// ── Vaults ───────────────────────────────────────────────────────────────────────────

final class MemoryDeviceKeyVault: DeviceKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var blob: Data?
    func read() throws -> Data? { lock.withLock { blob } }
    func insert(_ b: Data) throws -> Bool {
        lock.withLock {
            if blob != nil { return false }
            blob = b
            return true
        }
    }
    func upsert(_ b: Data) throws { lock.withLock { blob = b } }
    func delete() throws { lock.withLock { blob = nil } }
}

/// The Keychain item: data-protection keychain first, the legacy file keychain on macOS when the
/// process lacks the entitlement.
struct KeychainDeviceKeyVault: DeviceKeyVault {
    let keychain: any KeychainAPI
    let service: String
    let accessGroup: String?
    static let account = "device-keys"

    private func query(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if dataProtection {
            q[kSecUseDataProtectionKeychain as String] = true
            if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        }
        return q
    }

    private func attributes(_ blob: Data) -> [String: Any] {
        [
            kSecValueData as String: blob,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func readOne(dataProtection: Bool) throws -> Data? {
        var q = query(dataProtection: dataProtection)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = keychain.copyMatching(q)
        switch status {
        case errSecSuccess: return data
        case errSecItemNotFound: return nil
        case errSecMissingEntitlement where dataProtection: return nil
        default: throw DeviceKeyError.keychain(status)
        }
    }

    private func add(_ blob: Data, dataProtection: Bool) -> OSStatus {
        var a = query(dataProtection: dataProtection)
        a.merge(attributes(blob)) { $1 }
        return keychain.add(a)
    }

    /// Best effort: no older legacy copy may outlive a write to the data-protection keychain.
    private func dropLegacy() {
        #if os(macOS)
            _ = keychain.delete(query(dataProtection: false))
        #endif
    }

    func read() throws -> Data? {
        if let dp = try readOne(dataProtection: true) { return dp }
        #if os(macOS)
            guard let legacy = try readOne(dataProtection: false) else { return nil }
            // Migrate when the data-protection keychain is open to this process.
            // Migration counts only if the legacy copy is gone; else drop the new copy, so one
            // item stays the truth.
            if add(legacy, dataProtection: true) == errSecSuccess {
                let d = keychain.delete(query(dataProtection: false))
                if d != errSecSuccess && d != errSecItemNotFound { _ = keychain.delete(query(dataProtection: true)) }
            }
            return legacy
        #else
            return nil
        #endif
    }

    func insert(_ blob: Data) throws -> Bool {
        let s = add(blob, dataProtection: true)
        if s == errSecSuccess {
            dropLegacy()
            return true
        }
        if s == errSecDuplicateItem { return false }
        #if os(macOS)
            guard s == errSecMissingEntitlement else { throw DeviceKeyError.keychain(s) }
            let l = add(blob, dataProtection: false)
            if l == errSecSuccess { return true }
            if l == errSecDuplicateItem { return false }
            throw DeviceKeyError.keychain(l)
        #else
            throw DeviceKeyError.keychain(s)
        #endif
    }

    func upsert(_ blob: Data) throws {
        let s = keychain.update(query(dataProtection: true), attributes(blob))
        if s == errSecSuccess {
            dropLegacy()
            return
        }
        #if os(macOS)
            // The item may live in the legacy keychain (no entitlement, or not yet migrated).
            if s == errSecItemNotFound || s == errSecMissingEntitlement {
                let l = keychain.update(query(dataProtection: false), attributes(blob))
                if l == errSecSuccess { return }
                guard l == errSecItemNotFound else { throw DeviceKeyError.keychain(l) }
                if s == errSecItemNotFound, add(blob, dataProtection: true) == errSecSuccess {
                    dropLegacy()
                    return
                }
                let a = add(blob, dataProtection: false)
                guard a == errSecSuccess else { throw DeviceKeyError.keychain(a) }
                return
            }
            throw DeviceKeyError.keychain(s)
        #else
            guard s == errSecItemNotFound else { throw DeviceKeyError.keychain(s) }
            let a = add(blob, dataProtection: true)
            guard a == errSecSuccess else { throw DeviceKeyError.keychain(a) }
        #endif
    }

    func delete() throws {
        let s = keychain.delete(query(dataProtection: true))
        guard s == errSecSuccess || s == errSecItemNotFound || s == errSecMissingEntitlement else {
            throw DeviceKeyError.keychain(s)
        }
        #if os(macOS)
            let l = keychain.delete(query(dataProtection: false))
            guard l == errSecSuccess || l == errSecItemNotFound else { throw DeviceKeyError.keychain(l) }
        #endif
    }
}

// ── The store ────────────────────────────────────────────────────────────────────────

public actor DeviceKeyStore: DeviceKeyPort {
    private struct Envelope: Codable {
        var v: Int
        var protection: String
        var generation: Int
        /// `.keychain`: the raw keys.
        var keys: RawKeys?
        /// `.secureEnclaveWrapped`: the keys, sealed.
        var wrapped: WrappedKey?
    }
    private struct RawKeys: Codable {
        var sign: Data
        var agree: Data
    }

    private let vault: any DeviceKeyVault
    private let wrapper: (any DeviceKeyWrapping)?
    private let kind: DeviceKeyPersistence
    private let productSlug: String
    private let requireWrapper: Bool

    /// The Keychain store for `productSlug`. `accessGroup` (`<TeamID>.<group>`) shares the keys
    /// with the app's extensions. `secureEnclave` says whether to wrap the keys with the SE.
    public init(productSlug: String, accessGroup: String? = nil, secureEnclave: SecureEnclaveUse = .ifAvailable)
        throws
    {
        try self.init(
            productSlug: productSlug,
            vault: KeychainDeviceKeyVault(
                keychain: SystemKeychain(), service: "pkey:\(productSlug)", accessGroup: accessGroup),
            wrapper: secureEnclave != .never && SecureEnclaveWrapper.isAvailable ? SecureEnclaveWrapper() : nil,
            kind: .durable, requireWrapper: secureEnclave == .required)
    }

    /// Keys that die with the process. `persistence()` is `.memory`.
    public static func inMemory(productSlug: String = "memory") throws -> DeviceKeyStore {
        try DeviceKeyStore(productSlug: productSlug, vault: MemoryDeviceKeyVault(), wrapper: nil, kind: .memory)
    }

    init(
        productSlug: String, vault: any DeviceKeyVault, wrapper: (any DeviceKeyWrapping)?,
        kind: DeviceKeyPersistence, requireWrapper: Bool = false
    ) throws {
        // The slug goes into the authenticated data and the Keychain service: no `|`, no surprises.
        guard DeviceProofs.slugOK(productSlug) else { throw DeviceKeyError.unsupported("product") }
        self.requireWrapper = requireWrapper
        self.productSlug = productSlug
        self.vault = vault
        self.wrapper = wrapper
        self.kind = kind
    }

    /// How the keys are protected at rest: of the stored pair, else of the next pair. A record
    /// that does not decode reports as the next pair would; `ensure()` and `publicKeys()` throw
    /// `.unreadable` for it.
    public func protection() throws -> DeviceKeyProtection {
        if kind == .memory { return .memory }
        if let blob = try vault.read(), let env = try? JSONDecoder().decode(Envelope.self, from: blob) {
            return env.wrapped != nil ? .secureEnclaveWrapped : .keychain
        }
        return wrapper != nil ? .secureEnclaveWrapped : .keychain
    }

    public func persistence() -> DeviceKeyPersistence { kind }

    // Records

    private struct Open {
        var generation: Int
        var sign: Curve25519.Signing.PrivateKey
        var agree: Curve25519.KeyAgreement.PrivateKey
        var publicKeys: DevicePublicKeys {
            DevicePublicKeys(
                signKey: Base64URL.encode(sign.publicKey.rawRepresentation),
                agreeKey: Base64URL.encode(agree.publicKey.rawRepresentation), generation: generation)
        }
    }

    private func aad(_ generation: Int) -> Data {
        Data("pkey-device-keys/1|\(productSlug)|\(generation)".utf8)
    }

    private enum Loaded {
        case none
        case keys(Open)
    }

    private func load() throws -> Loaded {
        guard let blob = try vault.read() else { return .none }
        do {
            let env = try JSONDecoder().decode(Envelope.self, from: blob)
            guard env.v == 1, env.generation >= 1 else { throw DeviceKeyError.unreadable }
            let raw: RawKeys
            if let w = env.wrapped, env.keys == nil {
                // A pair wrapped to a Secure Enclave this store was told not to use is not
                // replaced behind the host's back: wipe() it, or allow the SE again.
                guard let wrapper else { throw DeviceKeyError.unsupported("secure-enclave-record") }
                raw = try JSONDecoder().decode(RawKeys.self, from: try wrapper.unwrap(w, aad: aad(env.generation)))
            } else if let k = env.keys, env.wrapped == nil {
                raw = k
            } else {
                throw DeviceKeyError.unreadable
            }
            return .keys(
                Open(
                    generation: env.generation,
                    sign: try Curve25519.Signing.PrivateKey(rawRepresentation: raw.sign),
                    agree: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw.agree)))
        } catch let e as DeviceKeyError {
            throw e
        } catch {
            // Bad JSON, bad lengths: unreadable, never replaced automatically.
            throw DeviceKeyError.unreadable
        }
    }

    private func encode(_ o: Open) throws -> Data {
        let raw = RawKeys(sign: o.sign.rawRepresentation, agree: o.agree.rawRepresentation)
        var env = Envelope(v: 1, protection: "keychain", generation: o.generation)
        if requireWrapper && wrapper == nil { throw DeviceKeyError.unsupported("secure-enclave") }
        if let wrapper {
            do {
                env.wrapped = try wrapper.wrap(JSONEncoder().encode(raw), aad: aad(o.generation))
                env.protection = "secure-enclave"
            } catch DeviceKeyError.unsupported(let why) {
                // The SE is permanently absent. Any other failure may pass and is thrown.
                if requireWrapper { throw DeviceKeyError.unsupported(why) }
                env.keys = raw  // `.ifAvailable`: protection() reports `.keychain`
            }
        } else {
            env.keys = raw
        }
        return try JSONEncoder().encode(env)
    }

    private func fresh(_ generation: Int) -> Open {
        Open(generation: generation, sign: Curve25519.Signing.PrivateKey(), agree: Curve25519.KeyAgreement.PrivateKey())
    }

    // Port

    public func ensure() throws -> DevicePublicKeys {
        switch try load() {
        case .keys(let o): return o.publicKeys
        case .none:
            let o = fresh(1)
            if try vault.insert(try encode(o)) { return o.publicKeys }
            // Another process won the race: use its pair.
            if case .keys(let w) = try load() { return w.publicKeys }
            throw DeviceKeyError.unreadable
        }
    }

    private func replace(generation: Int) throws -> DevicePublicKeys {
        let o = fresh(generation)
        try vault.upsert(try encode(o))
        return o.publicKeys
    }

    public func publicKeys() throws -> DevicePublicKeys? {
        if case .keys(let o) = try load() { return o.publicKeys }
        return nil
    }

    public func sign(_ message: Data) throws -> Data {
        guard case .keys(let o) = try load() else { throw DeviceKeyError.noKeys }
        return try o.sign.signature(for: message)
    }

    public func dh(_ peerPublic: Data) throws -> Data? {
        guard case .keys(let o) = try load() else { return nil }
        guard peerPublic.count == 32, !DeviceProofs.isX25519LowOrder([UInt8](peerPublic)),
            let peer = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublic),
            let shared = try? o.agree.sharedSecretFromKeyAgreement(with: peer)
        else { return nil }
        let out = shared.withUnsafeBytes { Data($0) }
        return out.contains(where: { $0 != 0 }) ? out : nil
    }

    public func rotate() throws -> DevicePublicKeys {
        var previous = 0
        if case .keys(let o) = try load() { previous = o.generation }  // unreadable throws
        return try replace(generation: previous + 1)
    }

    public func wipe() throws {
        try vault.delete()
        if try vault.read() != nil { throw DeviceKeyError.wipeIncomplete }
    }
}
