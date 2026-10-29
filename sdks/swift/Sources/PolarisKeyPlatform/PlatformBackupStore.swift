// The backed-up Keychain items behind silent restore (I-49) and Cloud Sync's key custody (U-39):
// a second, SYNCHRONIZABLE store beside `SecureStore`, which stays device-only.
//
//   - two named items and nothing else: `restore(product)` (service `pkey-restore:<product>`,
//     account `restore`) and `syncRoot(product, subject, ringId)` (service `pkey-sync:<product>`,
//     account `<subject>:<ringId>`). Every call funnels through one function that refuses a service
//     outside those two prefixes, so no other Keychain item (the device id, the token) is ever
//     read, written or deleted here;
//   - generic-password items in the DATA-PROTECTION keychain with `kSecAttrSynchronizable: true`
//     (iCloud Keychain) and `kSecAttrAccessibleAfterFirstUnlock`: a synchronizable item cannot be
//     `ThisDeviceOnly`, and a background launch must be able to read it after first unlock;
//   - the access group (I-49 D-7): `kSecAttrAccessGroup` is set only when the app passes one. The
//     default is the app's own group, so a developer's apps share an item only when the app passes
//     the team-wide `TEAMID.group`. A group outside the app's entitlements fails with -34018;
//   - the value is at most 4 KB of JSON (`{"v":1,"restoreId","secret"}` for `restore`). The store
//     never logs or describes a value;
//   - -34018 (missing entitlement) and `errSecNotAvailable` map to `.unavailable`, never a crash.
//     A caller treats it as "no backup here" and moves on;
//   - a synchronizable delete reaches every device signed in to the same Apple ID. The ladder
//     (I-49.10) therefore deletes the restore item only on sign-out, never on a failed redeem.
//
// Platforms: iOS, macOS, tvOS and visionOS compile (the Security calls are the same). iCloud
// Keychain sync is documented for iOS, macOS and visionOS; whether a tvOS device syncs a
// synchronizable item is [U] and unverified here: on tvOS the store still reads and writes the
// local item, and only the cross-device part is unconfirmed.

import Foundation

#if canImport(Security)
    import Security

    public struct PlatformBackupStore: Sendable {
        /// The two items this store holds.
        public enum Item: Sendable, Equatable {
            /// The silent-restore item of one product.
            case restore(product: String)
            /// The Cloud Sync root item of one (product, subject, ring).
            case syncRoot(product: String, subject: String, ringId: String)
        }

        public enum Failure: Error, Sendable, Equatable {
            /// A product, subject or ring id the store does not accept.
            case invalidName
            /// A service outside the two prefixes.
            case refusedService
            /// The value is over 4 KB, or not a JSON object.
            case invalidValue
            /// -34018 (no `keychain-access-groups` entitlement or a group outside it) or
            /// `errSecNotAvailable`: there is no backup store on this build.
            case unavailable(status: Int32)
            /// Any other Keychain status.
            case keychain(status: Int32)
        }

        /// The `{"v":1,"restoreId","secret"}` value of the restore item.
        public struct RestoreValue: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
            public let restoreId: String
            public let secret: String

            public init(restoreId: String, secret: String) {
                self.restoreId = restoreId
                self.secret = secret
            }

            public var description: String { "RestoreValue(restoreId: \(restoreId), secret: <redacted>)" }
            public var debugDescription: String { description }

            public func encoded() throws -> Data {
                // The keys are sorted, so the same value is the same bytes.
                let object: [String: Any] = ["v": 1, "restoreId": restoreId, "secret": secret]
                return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            }

            /// nil for anything but a version-1 object with both strings.
            public static func decode(_ data: Data) -> RestoreValue? {
                guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    (object["v"] as? Int) == 1,
                    let restoreId = object["restoreId"] as? String, let secret = object["secret"] as? String
                else { return nil }
                return RestoreValue(restoreId: restoreId, secret: secret)
            }
        }

        public static let restoreServicePrefix = "pkey-restore:"
        public static let syncServicePrefix = "pkey-sync:"
        public static let restoreAccount = "restore"
        /// The most a value may hold.
        public static let maxValueBytes = 4096

        /// `-34018`, `errSecMissingEntitlement`.
        static let missingEntitlement: OSStatus = -34018

        static let componentPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"

        /// The app's keychain access group, or nil for the app's default group (D-7).
        public let accessGroup: String?
        private let backend: any KeychainBackend

        public init(backend: any KeychainBackend = SystemKeychainBackend(), accessGroup: String? = nil) {
            self.backend = backend
            self.accessGroup = (accessGroup?.isEmpty ?? true) ? nil : accessGroup
        }

        // MARK: Calls

        /// The item's bytes, or nil when it is absent.
        public func get(_ item: Item) throws -> Data? {
            let (service, account) = try Self.address(of: item)
            var q = try query(service: service, account: account)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            let (status, data) = backend.copyMatching(q)
            switch status {
            case errSecSuccess:
                guard let data else { throw Failure.keychain(status: Int32(status)) }
                return data
            case errSecItemNotFound:
                return nil
            default:
                throw Self.failure(status)
            }
        }

        /// Update the item, or add it when absent.
        public func set(_ item: Item, value: Data) throws {
            let (service, account) = try Self.address(of: item)
            guard Self.validValue(value) else { throw Failure.invalidValue }
            let attributes: [String: Any] = [
                kSecValueData as String: value,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            ]
            var status = backend.update(try query(service: service, account: account), attributes)
            if status == errSecItemNotFound {
                var add = try query(service: service, account: account)
                add.merge(attributes) { $1 }
                status = backend.add(add)
            }
            if status != errSecSuccess { throw Self.failure(status) }
        }

        /// Delete the item. An absent item is success. On a device with iCloud Keychain this reaches
        /// every device on the Apple ID.
        public func delete(_ item: Item) throws {
            let (service, account) = try Self.address(of: item)
            let status = backend.delete(try query(service: service, account: account))
            if status != errSecSuccess && status != errSecItemNotFound { throw Self.failure(status) }
        }

        // MARK: Restore item

        public func readRestore(product: String) throws -> RestoreValue? {
            guard let data = try get(.restore(product: product)) else { return nil }
            return RestoreValue.decode(data)
        }

        public func writeRestore(product: String, _ value: RestoreValue) throws {
            try set(.restore(product: product), value: try value.encoded())
        }

        public func deleteRestore(product: String) throws { try delete(.restore(product: product)) }

        // MARK: Internals

        static func address(of item: Item) throws -> (service: String, account: String) {
            switch item {
            case .restore(let product):
                guard validProduct(product) else { throw Failure.invalidName }
                return (restoreServicePrefix + product, restoreAccount)
            case .syncRoot(let product, let subject, let ringId):
                guard validProduct(product), validComponent(subject), validComponent(ringId) else {
                    throw Failure.invalidName
                }
                return (syncServicePrefix + product, "\(subject):\(ringId)")
            }
        }

        static func validProduct(_ s: String) -> Bool { SecureStore.validProduct(s) }

        static func validComponent(_ s: String) -> Bool {
            s.range(of: componentPattern, options: .regularExpression) != nil
        }

        /// A JSON object of at most `maxValueBytes`.
        static func validValue(_ data: Data) -> Bool {
            guard data.count <= maxValueBytes,
                (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
            else { return false }
            return true
        }

        static func servicePermitted(_ service: String) -> Bool {
            service.hasPrefix(restoreServicePrefix) || service.hasPrefix(syncServicePrefix)
        }

        /// The one place a query is built: the prefix guard, then the item's identity.
        func query(service: String, account: String) throws -> [String: Any] {
            guard Self.servicePermitted(service) else { throw Failure.refusedService }
            var q: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecAttrSynchronizable as String: true,
                kSecUseDataProtectionKeychain as String: true,
            ]
            if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
            return q
        }

        static func failure(_ status: OSStatus) -> Failure {
            if status == missingEntitlement || status == errSecNotAvailable {
                return .unavailable(status: Int32(status))
            }
            return .keychain(status: Int32(status))
        }
    }
#endif
