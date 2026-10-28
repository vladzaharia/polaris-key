// The sealer behind the Godot device key store (CC-26.7; plans/CC-01.md R-5, decision Q12: software
// 25519 keys in hardware-wrapped storage). The Godot SDK keeps making keys, signing and agreeing in
// GDScript; this only wraps and unwraps the record's bytes under a per-product AES-256-GCM key that
// lives in the Keychain, so the key file on disk is useless without the Keychain item.
//
//   - the key is a random 32 bytes held as the generic-password item `pkey:<product>` / account
//     `device-key-seal` through SecureStore: `AfterFirstUnlockThisDeviceOnly` on iOS, never
//     synchronizable, no access group (the login keychain on a macOS desktop build, as SP-27's
//     token). It is not a Secure Enclave key: the Secure Enclave holds only P-256 keys, and a
//     symmetric key cannot be created inside it from this lane;
//   - blob = 0x01 || AES.GCM combined (nonce 12 || ciphertext || tag 16), AAD = the caller's context;
//   - the same rules as KeychainVault (CC-26.4) and KeystoreSealer (CC-26.5): a Keychain error that
//     may pass is an ERROR (`keychain`), never "no key"; only a blob that can never open (no key,
//     a key of the wrong shape, a bad tag, another format) is `unopenable`; a key is created only
//     by `seal`, and only when the item is confirmed absent;
//   - nothing secret is returned in an error or written to a log.

import Foundation

#if canImport(Security) && canImport(CryptoKit)
    import CryptoKit

    public struct DeviceKeySealer: Sendable {
        /// The Keychain account of the sealing key.
        public static let account = "device-key-seal"
        static let version: UInt8 = 1
        static let nonceBytes = 12
        static let tagBytes = 16
        /// One sealer call at a time per process: seal creates the key, destroy removes it.
        private static let lock = NSLock()

        private let store: SecureStore

        public init(product: String, backend: any KeychainBackend, keychain: SecureStore.Keychain = .dataProtection) {
            store = SecureStore(product: product, backend: backend, keychain: keychain)
        }

        /// `{ok, blob}` (base64) or `{ok:false, error}`: `keychain` (+ `status`) for a fault that may pass,
        /// `invalid_name` / `bad_input` for a request that is wrong.
        public func seal(plain: Data, context: Data) -> PlatformObject {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            let key: SymmetricKey
            switch loadKey() {
            case .fault(let r): return r
            case .present(let k): key = k
            case .unusable:
                // An item is there but is not a key of ours: never written over.
                return ["ok": false, "error": "keychain", "detail": "the sealing key item is unusable"]
            case .absent:
                let fresh = SymmetricKey(size: .bits256)
                let b64 = fresh.withUnsafeBytes { Data($0).base64EncodedString() }
                let set = store.set(account: Self.account, value: b64)
                guard set["ok"]?.boolValue == true else { return Self.fault(set) }
                key = fresh
            }
            do {
                let box = try AES.GCM.seal(plain, using: key, authenticating: context)
                guard let combined = box.combined else { return ["ok": false, "error": "seal_failed"] }
                return ["ok": true, "blob": .string((Data([Self.version]) + combined).base64EncodedString())]
            } catch {
                return ["ok": false, "error": "seal_failed"]
            }
        }

        /// `{ok, plain}` (base64); `{ok:false, error:"unopenable"}` for a blob that can never open;
        /// `{ok:false, error:"keychain", status}` for a fault that may pass.
        public func open(blob: Data, context: Data) -> PlatformObject {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            let key: SymmetricKey
            switch loadKey() {
            case .fault(let r): return r
            case .absent, .unusable: return Self.unopenable
            case .present(let k): key = k
            }
            guard blob.count >= 1 + Self.nonceBytes + Self.tagBytes, blob[blob.startIndex] == Self.version else {
                return Self.unopenable
            }
            do {
                let box = try AES.GCM.SealedBox(combined: blob.dropFirst())
                let plain = try AES.GCM.open(box, using: key, authenticating: context)
                return ["ok": true, "plain": .string(plain.base64EncodedString())]
            } catch {
                return Self.unopenable
            }
        }

        /// Deletes the sealing key, so every blob sealed under it is unopenable for good. An absent key is
        /// success.
        public func destroy() -> PlatformObject {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            let r = store.delete(account: Self.account)
            return r["ok"]?.boolValue == true ? ["ok": true] : Self.fault(r)
        }

        static let unopenable: PlatformObject = ["ok": false, "error": "unopenable"]

        private enum Loaded {
            case present(SymmetricKey)
            case absent
            case unusable
            case fault(PlatformObject)
        }

        private func loadKey() -> Loaded {
            let r = store.get(account: Self.account)
            guard r["ok"]?.boolValue == true else {
                // `not_utf8` is an item that is not ours; every other failure may pass.
                if r["error"]?.stringValue == "not_utf8" { return .unusable }
                return .fault(Self.fault(r))
            }
            guard let value = r["value"], value != .null else { return .absent }
            guard let b64 = value.stringValue, let raw = Data(base64Encoded: b64), raw.count == 32 else {
                return .unusable
            }
            return .present(SymmetricKey(data: raw))
        }

        /// A SecureStore failure as a sealer fault: the code and status only.
        private static func fault(_ r: PlatformObject) -> PlatformObject {
            var out: PlatformObject = ["ok": false, "error": "keychain"]
            if let status = r["status"] { out["status"] = status }
            if r["error"]?.stringValue == "invalid_name" { out["error"] = "invalid_name" }
            return out
        }
    }
#endif
