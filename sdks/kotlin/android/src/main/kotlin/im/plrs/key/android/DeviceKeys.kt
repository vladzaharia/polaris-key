// The device key store on Android (CC-26.5; plans/CC-01.md R-5, decision Q12): the raw Ed25519 and
// X25519 keys are software keys, wrapped by an AndroidKeyStore AES-256-GCM key (hardware-backed where
// the device has it, via :platform's KeystoreSealer) and kept in app-private storage,
// `noBackupFilesDir/pkey/<product>/device-keys.bin`: never backed up, and the wrapping key could not
// follow a copy to another device anyway. The curves are :core's DeviceCurves; Tink (tink-android)
// comes first below API 33, where the JCA has no 25519.
//
// Persistence: durable. A lost or invalidated wrapping key makes the file unreadable; the next
// ensure() then makes a new pair (the server sees a key change, which it rate limits). wipe() removes
// the file AND the wrapping key.

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

/** The Android device key store for [productSlug]: Keystore-wrapped keys in `noBackupFilesDir`. */
public fun androidDeviceKeyStore(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
    file: File = File(context.noBackupFilesDir, "pkey/${SecureStore.checkProductName(productSlug)}/device-keys.bin"),
): DeviceKeyStore = DeviceKeyStore(
    FileDeviceKeyStorage(
        file,
        AndroidDeviceKeySealer(KeystoreSealer(keys, KeystoreSealer.aliasFor(productSlug))),
        "pkey-device-keys/1/$productSlug".toByteArray(Charsets.UTF_8),
    ),
)
