// The crypto of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10) and its key hierarchy
// (§13.10.2), on the JCA (`Mac`, `Cipher`, `MessageDigest`), which Android has from API 1 (GCM
// with a 128-bit tag from API 19).
//
// Every derivation is HKDF-SHA256 (RFC 5869). Labels are ASCII; a label that scopes by name is
// followed by a NUL and then the UTF-8 name. Every symmetric key seals one plaintext, so the
// AES-GCM nonce is a constant of 12 zero bytes. The derivations are in `SyncKeys`.

package im.plrs.key.core.sync

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A value or key the sync crypto refuses: a wrong length, or JSON that cannot be spelled identically in every SDK. */
public class SyncCryptoException(message: String) : Exception(message)

public object SyncCrypto {
    public const val ROOT_BYTES: Int = 32
    public const val KID_BYTES: Int = 16
    public const val TAG_BYTES: Int = 16
    public const val NONCE_BYTES: Int = 12

    /** The salt of a value key (`K_msg`). */
    public const val VALUE_SALT_BYTES: Int = 16

    /** The salt of a file key (`K_file`). */
    public const val FILE_SALT_BYTES: Int = 32

    public const val KEY_BYTES: Int = 32
    private const val HASH_BYTES = 32
    private const val MAX_HKDF_BLOCKS = 255
    private const val BITS_PER_BYTE = 8
    private val random = SecureRandom()
    private val zeroNonce = ByteArray(NONCE_BYTES)

    // -- Primitives ------------------------------------------------------------------------------

    public fun cat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var off = 0
        for (p in parts) {
            p.copyInto(out, off)
            off += p.size
        }
        return out
    }

    public fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    public fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    /** HMAC-SHA256. An empty key is HashLen zeros, which a JCA key spec cannot hold. */
    public fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** HKDF-SHA256 (RFC 5869). An empty salt is the hash length of zeros. */
    public fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 0..(MAX_HKDF_BLOCKS * HASH_BYTES)) { "bad HKDF length" }
        val prk = hmac(if (salt.isEmpty()) ByteArray(HASH_BYTES) else salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var off = 0
        var i = 1
        while (off < length) {
            t = hmac(prk, cat(t, info, byteArrayOf(i.toByte())))
            val n = minOf(t.size, length - off)
            t.copyInto(out, off, 0, n)
            off += n
            i++
        }
        prk.fill(0)
        return out
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray, data: ByteArray): ByteArray {
        // A new Cipher each time: a GCM Cipher refuses to reuse a (key, nonce) pair.
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * BITS_PER_BYTE, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(data)
    }

    /**
     * AES-256-GCM with a 128-bit tag; the result is ciphertext followed by the tag. The nonce is
     * the all-zero one unless a derivation names its own. A key that is not 32 bytes is refused.
     */
    public fun aesGcmSeal(key: ByteArray, aad: ByteArray, plaintext: ByteArray, nonce: ByteArray = zeroNonce): ByteArray {
        if (key.size != KEY_BYTES) throw SyncCryptoException("bad key length")
        if (nonce.size != NONCE_BYTES) throw SyncCryptoException("bad nonce length")
        return gcm(Cipher.ENCRYPT_MODE, key, nonce, aad, plaintext)
    }

    /** The plaintext, or null when authentication fails. */
    public fun aesGcmOpen(key: ByteArray, aad: ByteArray, ciphertext: ByteArray, nonce: ByteArray = zeroNonce): ByteArray? {
        if (key.size != KEY_BYTES || nonce.size != NONCE_BYTES || ciphertext.size < TAG_BYTES) return null
        return try {
            gcm(Cipher.DECRYPT_MODE, key, nonce, aad, ciphertext)
        } catch (ignored: java.security.GeneralSecurityException) {
            null
        }
    }

    /** Random bytes from the system generator. */
    public fun random(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    /** Constant-time equality. */
    public fun equalBytes(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)
}
