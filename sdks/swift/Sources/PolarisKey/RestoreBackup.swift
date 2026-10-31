// The umbrella's silent-restore adapter (I-49.9): `RestoreItemStore` over PolarisKeyPlatform's
// `PlatformBackupStore`, the synchronizable (iCloud Keychain) item `pkey-restore:<product>`.
//
// Every Keychain failure reads as `RestoreStoreError.unavailable` ("no backup here"): a missing
// entitlement (-34018), no iCloud Keychain, or a value the store does not accept. The ladder then goes on
// to rung 3 and nothing is enrolled. The secret is never logged or put in an error.

import Foundation
import PolarisKeyIdentity
import PolarisKeyPlatform

#if canImport(Security)
    struct KeychainRestoreItemStore: RestoreItemStore {
        let product: String
        let store: PlatformBackupStore

        init(product: String, accessGroup: String?) {
            self.product = product
            self.store = PlatformBackupStore(accessGroup: accessGroup)
        }

        func read() async throws -> RestoreItem? {
            do {
                guard let value = try store.readRestore(product: product) else { return nil }
                return RestoreItem(restoreId: value.restoreId, secret: value.secret)
            } catch {
                throw RestoreStoreError.unavailable
            }
        }

        func write(_ item: RestoreItem) async throws {
            do {
                try store.writeRestore(
                    product: product,
                    PlatformBackupStore.RestoreValue(restoreId: item.restoreId, secret: item.secret))
            } catch {
                throw RestoreStoreError.unavailable
            }
        }

        func delete() async throws {
            do { try store.deleteRestore(product: product) } catch { throw RestoreStoreError.unavailable }
        }
    }
#endif

extension IdentityClient {
    /// The platform backup store of this build: the synchronizable Keychain on Apple platforms.
    func installPlatformRestoreStore(product: String) {
        #if canImport(Security)
            installRestoreStoreFactory { group in KeychainRestoreItemStore(product: product, accessGroup: group) }
        #endif
    }
}
