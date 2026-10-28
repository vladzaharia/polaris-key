// The device key store on Android (CC-26.5; plans/CC-01.md R-5, decision Q12): the raw Ed25519 and
// X25519 keys are software keys, wrapped by an AndroidKeyStore AES-256-GCM key (hardware-backed where
// the device has it, via :platform's KeystoreSealer) and kept in app-private storage,
// `noBackupFilesDir/pkey/<product>/device-keys.bin`: never backed up, and the wrapping key could not
// follow a copy to another device anyway. The curves are :core's DeviceCurves; Tink (tink-android)
// comes first below API 33, where the JCA has no 25519.
//
// Persistence: durable. A lost or invalidated wrapping key makes the file unreadable: every call but
// wipe() then throws DeviceKeysUnreadableException and the file is kept, never replaced. wipe() removes
// the file AND the wrapping key; the next ensure() makes a new pair (the server sees a key change,
// which it rate limits).

package im.plrs.key.android

import android.content.Context
import im.plrs.key.core.DeviceKeySealer
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.StoreException
import im.plrs.key.platform.AndroidKeyStoreProvider
import im.plrs.key.platform.KeyProvider
import im.plrs.key.platform.KeystoreSealer
import im.plrs.key.platform.SecureStore
import im.plrs.key.platform.SecureStoreException
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.io.File

/** Adapts :platform's core-free [KeystoreSealer] to :core's [DeviceKeySealer]. A transient Keystore failure surfaces as a [StoreException]. */
public class AndroidDeviceKeySealer(private val sealer: KeystoreSealer) : DeviceKeySealer {
    override fun seal(plain: ByteArray, context: ByteArray): ByteArray = wrap { sealer.seal(plain, context) }

    override fun open(blob: ByteArray, context: ByteArray): ByteArray? = wrap { sealer.open(blob, context) }

    override fun destroy(): Unit = wrap { sealer.destroy() }

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: SecureStoreException) {
        throw StoreException("device keys: the Keystore failed (${e.reason})", e)
    }
}

/**
 * [file], or `noBackupFilesDir/pkey/<product>/<name>` looked up on first use. The lookup touches the disk,
 * so it is deferred to the storage's first (IO-dispatched) operation: building a client on the main thread
 * trips no StrictMode disk-read violation. The product name is still checked now.
 */
private fun fileOrNoBackup(context: Context, productSlug: String, file: File?, name: String): () -> File {
    val slug = SecureStore.checkProductName(productSlug)
    return { file ?: File(context.noBackupFilesDir, "pkey/$slug/$name") }
}

/** The Android device key store for [productSlug]: Keystore-wrapped keys in `noBackupFilesDir`. */
public fun androidDeviceKeyStore(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
    file: File? = null,
): DeviceKeyStore = DeviceKeyStore(
    FileDeviceKeyStorage(
        fileOrNoBackup(context, productSlug, file, "device-keys.bin"),
        AndroidDeviceKeySealer(KeystoreSealer(keys, KeystoreSealer.aliasFor(productSlug))),
        "pkey-device-keys/1/$productSlug".toByteArray(Charsets.UTF_8),
    ),
)

/**
 * Where the Cloud Sync root lives on Android: the same Keystore-wrapped file as the device keys, with its
 * own wrapping alias ([KeystoreSealer.rootAliasFor]) and file (`noBackupFilesDir/pkey/<product>/sync-root.bin`).
 * Never backed up. `forget()` deletes the file and destroys that alias, and no other.
 */
public fun androidSyncRootStorage(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
    file: File? = null,
): FileDeviceKeyStorage = FileDeviceKeyStorage(
    fileOrNoBackup(context, productSlug, file, "sync-root.bin"),
    AndroidDeviceKeySealer(KeystoreSealer(keys, KeystoreSealer.rootAliasFor(productSlug))),
    "pkey-sync-root/1/$productSlug".toByteArray(Charsets.UTF_8),
)

/** These client options with the Cloud Sync root in [androidSyncRootStorage], unless the host chose a storage. */
internal fun PolarisKeyClientOptions.withAndroidKeyring(context: Context, productSlug: String): PolarisKeyClientOptions =
    copy(keyring = keyring.copy(rootStorage = keyring.rootStorage ?: androidSyncRootStorage(context, productSlug)))
