package im.plrs.key.platform

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.security.GeneralSecurityException
import java.security.ProviderException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals a small secret (the device keys' record, CC-26.5; decision Q12: software 25519 keys in
 * hardware-wrapped storage) under one AndroidKeyStore AES-256-GCM key, [alias]. The AES key is
 * non-exportable and hardware-backed where the device has it ([AndroidKeyStoreProvider]: StrongBox,
 * else the TEE, else software on an emulator). The wrapped bytes are the caller's to store:
 *
 *     0x01 ‖ iv (12 bytes) ‖ ciphertext ‖ tag (16 bytes)      AAD = the caller's context
 *
 * The context binds a blob to its use, so one copied elsewhere fails its tag. Standalone, as the
 * rest of :platform: it knows nothing of :core.
 *
 * [open] answers null only for a blob that can never be opened: no key under the alias (lost or
 * destroyed), a permanently invalidated key (the key is removed), a bad tag, or a blob in another
 * format. A failure that may pass (the Keystore provider errored) throws [SecureStoreException], so
 * a glitch is never read as "the keys are gone": absence is confirmed with `containsAlias` on a fresh
 * load, and a key is never created over an alias that is present. Nothing is ever returned or written in the clear.
 */
public class KeystoreSealer(private val keys: KeyProvider, public val alias: String) {
    /** Makes the AES/GCM cipher (tests substitute one that raises Keystore-only exceptions). */
    internal var newCipher: () -> Cipher = { Cipher.getInstance(TRANSFORMATION) }

    public fun seal(plain: ByteArray, context: ByteArray): ByteArray = try {
        encrypt(plain, context, retry = true)
    } catch (e: ProviderException) {
        throw SecureStoreException("keystore-provider", "AndroidKeyStore could not encrypt: ${e.message}", e)
    } catch (e: GeneralSecurityException) {
        throw SecureStoreException("keystore", "cannot encrypt under $alias: ${e.message}", e)
    }

    public fun open(blob: ByteArray, context: ByteArray): ByteArray? {
        if (blob.size < 1 + IV_BYTES + TAG_BYTES || blob[0] != VERSION) return null
        val key = try {
            keyOrRetry()
        } catch (e: ProviderException) {
            throw SecureStoreException("keystore-provider", "AndroidKeyStore could not load $alias: ${e.message}", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot load $alias: ${e.message}", e)
        } ?: return null
        return try {
            val cipher = newCipher()
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, blob, 1, IV_BYTES))
            cipher.updateAAD(context)
            cipher.doFinal(blob, 1 + IV_BYTES, blob.size - 1 - IV_BYTES)
        } catch (e: KeyPermanentlyInvalidatedException) {
            destroy()
            null
        } catch (e: AEADBadTagException) {
            null
        } catch (e: ProviderException) {
            throw SecureStoreException("keystore-provider", "AndroidKeyStore could not decrypt: ${e.message}", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot decrypt under $alias: ${e.message}", e)
        }
    }

    /** Deletes the AES key, so every blob sealed under it is unreadable for good. */
    public fun destroy() {
        try {
            keys.delete(alias)
        } catch (e: ProviderException) {
            throw SecureStoreException("keystore-provider", "AndroidKeyStore could not delete $alias: ${e.message}", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot delete $alias: ${e.message}", e)
        }
    }

    private fun encrypt(plain: ByteArray, context: ByteArray, retry: Boolean): ByteArray {
        // Create only when the alias is confirmed absent; never over a key that is there.
        val key = keyOrRetry() ?: keys.create(alias)
        val cipher = newCipher()
        try {
            cipher.init(Cipher.ENCRYPT_MODE, key)
        } catch (e: KeyPermanentlyInvalidatedException) {
            if (!retry) throw e
            destroy()
            return encrypt(plain, context, retry = false)
        }
        cipher.updateAAD(context)
        val ct = cipher.doFinal(plain)
        val iv = cipher.iv
        if (iv == null || iv.size != IV_BYTES) throw GeneralSecurityException("unexpected IV length ${iv?.size}")
        return byteArrayOf(VERSION) + iv + ct
    }

    /**
     * The key, or null only when the alias is CONFIRMED absent (a fresh `KeyStore.load` and
     * `containsAlias`). A null from `get` for an alias that is present is ambiguous and throws
     * [SecureStoreException], so a glitch can never read as "key gone" nor lead to a new key.
     */
    private fun keyOrRetry(): SecretKey? {
        keys.get(alias)?.let { return it }
        keys.get(alias)?.let { return it }
        if (keys.exists(alias)) throw SecureStoreException("keystore", "$alias is present but could not be loaded")
        return null
    }

    public companion object {
        private const val VERSION: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        /** The alias for [product]'s device keys. */
        public fun aliasFor(product: String): String = "pkey:${SecureStore.checkProductName(product)}:devicekeys"
    }
}
