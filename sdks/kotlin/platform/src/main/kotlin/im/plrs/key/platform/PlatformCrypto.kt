package im.plrs.key.platform

import android.annotation.SuppressLint
import android.os.Build
import java.math.BigInteger
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPrivateKeySpec
import java.security.spec.XECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Why [PlatformCrypto] refused. The reason never carries key or message bytes. */
public class PlatformCryptoException(public val reason: String, cause: Throwable? = null) : Exception(reason, cause) {
    public companion object {
        /** An argument has the wrong length. */
        public const val BAD_INPUT: String = "bad_input"

        /** The peer's key gives an all-zero shared secret (a low-order point). */
        public const val DH_ZERO: String = "dh_zero"

        /** X25519 needs API 33 (JCA `XDH`); the caller uses its own ladder. */
        public const val UNSUPPORTED: String = "unsupported"
    }
}

/**
 * The two primitives the Godot Cloud Connect engine takes natively (CC-14b.8, D-3, D-12): AES-256-GCM
 * (12-byte nonce, 16-byte tag) and X25519, on the JCA. X25519 is the platform's `XDH` provider, which
 * exists from API 33 (D-14); below that [x25519Supported] is false and X25519 throws
 * [PlatformCryptoException.UNSUPPORTED], and there is no Tink here. Standalone, as the rest of
 * :platform. Keys and secrets stay in the caller's arrays: nothing is logged and no exception text
 * holds a byte of them.
 */
public class PlatformCrypto(private val sdkInt: Int = Build.VERSION.SDK_INT) {
    public val x25519Supported: Boolean get() = sdkInt >= X25519_API

    /** Ciphertext then the 16-byte tag. */
    public fun aesGcmSeal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plain: ByteArray): ByteArray {
        if (!fits(key, nonce, aad, plain.size)) refuse(PlatformCryptoException.BAD_INPUT)
        return try {
            gcm(Cipher.ENCRYPT_MODE, key, nonce, aad).doFinal(plain)
        } catch (e: GeneralSecurityException) {
            refuse(PlatformCryptoException.BAD_INPUT, e)
        }
    }

    /** The plaintext, or null when the tag does not verify (the JCA compares it in constant time). */
    @Suppress("SwallowedException")
    public fun aesGcmOpen(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray? {
        val body = sealed.size - TAG_BYTES
        if (body < 0 || !fits(key, nonce, aad, body)) refuse(PlatformCryptoException.BAD_INPUT)
        return try {
            gcm(Cipher.DECRYPT_MODE, key, nonce, aad).doFinal(sealed)
        } catch (e: GeneralSecurityException) {
            // A tag that does not verify (AEADBadTagException) or any other unopenable input: the same answer.
            null
        }
    }

    /** The shared secret; throws [PlatformCryptoException.DH_ZERO] when it would be all zero. */
    // The XDH classes are API 33; the x25519Supported check below is the guard (sdkInt is injectable for the JVM tests).
    @SuppressLint("NewApi")
    public fun x25519(privateKey: ByteArray, peerPublic: ByteArray): ByteArray {
        if (privateKey.size != KEY_BYTES || peerPublic.size != KEY_BYTES) refuse(PlatformCryptoException.BAD_INPUT)
        if (!x25519Supported) refuse(PlatformCryptoException.UNSUPPORTED)
        val scalar = privateKey.copyOf()
        val out = try {
            val kf = KeyFactory.getInstance("XDH")
            val priv = kf.generatePrivate(XECPrivateKeySpec(NamedParameterSpec.X25519, scalar))
            val pub = kf.generatePublic(XECPublicKeySpec(NamedParameterSpec.X25519, uCoordinate(peerPublic)))
            val ka = KeyAgreement.getInstance("XDH")
            ka.init(priv)
            ka.doPhase(pub, true)
            ka.generateSecret()
        } catch (e: GeneralSecurityException) {
            // A provider that rejects a low-order point does so here; that is the same refusal.
            refuse(PlatformCryptoException.DH_ZERO, e)
        } finally {
            // The copy handed to the key spec is ours: wipe it on every path.
            scalar.fill(0)
        }
        var any = 0
        for (b in out) any = any or b.toInt()
        if (out.size != KEY_BYTES || any == 0) {
            out.fill(0)
            refuse(PlatformCryptoException.DH_ZERO)
        }
        return out
    }

    /** The public key of a 32-byte private key: X25519 against the base point (u = 9). */
    public fun x25519Public(privateKey: ByteArray): ByteArray {
        val base = ByteArray(KEY_BYTES)
        base[0] = BASE_POINT_U
        return x25519(privateKey, base)
    }

    private fun fits(key: ByteArray, nonce: ByteArray, aad: ByteArray, bodyBytes: Int): Boolean =
        key.size == KEY_BYTES && nonce.size == NONCE_BYTES && aad.size <= MAX_BYTES && bodyBytes <= MAX_BYTES

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * BITS, nonce))
        c.updateAAD(aad)
        return c
    }

    private fun refuse(reason: String, cause: Throwable? = null): Nothing = throw PlatformCryptoException(reason, cause)

    private fun uCoordinate(u: ByteArray): BigInteger {
        // Little-endian; bit 255 is ignored (RFC 7748 section 5).
        val be = ByteArray(KEY_BYTES) { u[KEY_BYTES - 1 - it] }
        be[0] = (be[0].toInt() and TOP_BIT_CLEAR).toByte()
        return BigInteger(1, be)
    }

    public companion object {
        public const val KEY_BYTES: Int = 32
        public const val NONCE_BYTES: Int = 12
        public const val TAG_BYTES: Int = 16

        /** No 64 KiB cap on this path (D-12); 8 MiB is the sanity bound on one call. */
        public const val MAX_BYTES: Int = 8 * 1024 * 1024
        public const val X25519_API: Int = 33
        private const val BASE_POINT_U: Byte = 9
        private const val TOP_BIT_CLEAR = 0x7f
        private const val BITS = 8
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
