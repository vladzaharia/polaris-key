// Ed25519 — the signature primitive of every Polaris Key document (WIRE-CONTRACT-V4 §1.1).
//
// One port, two backends:
//
//   JcaEd25519Verifier   `Signature.getInstance("Ed25519")`: JDK 15+ and Android API 33+.
//   TinkEd25519Verifier  Tink's pure-Java `Ed25519Verify`, for Android API 24–32. Tink is a
//                        compileOnly dependency of :core: the Android glue (P6-12) brings
//                        tink-android, and a test classpath brings tink.
//
// The verdict must not depend on the backend, so the strictness the contract asks for is not left
// to either: `Ed25519Strict.prechecks` refuses a non-canonical S (S ≥ L), a non-canonical A or R
// (y ≥ p, or the negative-zero encodings) and the eight small-order encodings of A or R BEFORE
// the backend runs. The conformance runner reaches every verdict on both backends.

package im.plrs.key.core

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Verifies one Ed25519 signature over raw 32-byte public keys. Never throws. */
public interface Ed25519Verifier {
    /** A short name for diagnostics: `jca`, `tink` or `unavailable`. */
    public val name: String

    /** True when [signature] (64 bytes) is valid for [message] under [publicKey] (32 bytes). */
    public fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
}

/** The JCA backend (JDK 15+, Android API 33+). */
public object JcaEd25519Verifier : Ed25519Verifier {
    override val name: String = "jca"

    /** The DER SubjectPublicKeyInfo prefix for an Ed25519 key (RFC 8410). */
    private val SPKI_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    )

    /** True when this runtime's JCA provides Ed25519. */
    public val isAvailable: Boolean by lazy {
        try {
            Signature.getInstance("Ed25519")
            KeyFactory.getInstance("Ed25519")
            true
        } catch (e: Exception) {
            false
        }
    }

    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        return try {
            val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + publicKey))
            val sig = Signature.getInstance("Ed25519")
            sig.initVerify(key)
            sig.update(message)
            sig.verify(signature)
        } catch (e: Exception) {
            false
        }
    }
}

/** The Tink backend (Android API 24–32). Present only when Tink is on the classpath. */
public object TinkEd25519Verifier : Ed25519Verifier {
    override val name: String = "tink"

    /** True when Tink's `Ed25519Verify` can be loaded. */
    public val isAvailable: Boolean by lazy {
        try {
            Class.forName("com.google.crypto.tink.subtle.Ed25519Verify")
            true
        } catch (e: Throwable) {
            false
        }
    }

    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64 || !isAvailable) return false
        return try {
            com.google.crypto.tink.subtle.Ed25519Verify(publicKey).verify(signature, message)
            true
        } catch (e: Throwable) {
            false
        }
    }
}

/** No backend: every signature is refused (fail closed). */
public object UnavailableEd25519Verifier : Ed25519Verifier {
    override val name: String = "unavailable"

    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = false
}

/** The process-wide backend selection. */
public object Ed25519 {
    /**
     * The backend every verification uses: the JCA where it has Ed25519, else Tink, else
     * [UnavailableEd25519Verifier] (every document is then refused, never accepted unverified).
     * A host may set it, for example to force Tink in a test.
     */
    @Volatile
    public var verifier: Ed25519Verifier = when {
        JcaEd25519Verifier.isAvailable -> JcaEd25519Verifier
        TinkEd25519Verifier.isAvailable -> TinkEd25519Verifier
        else -> UnavailableEd25519Verifier
    }
}

/** V4 §1.1's byte comparisons on the trusted key A and the signature R ‖ S. */
public object Ed25519Strict {
    /** The group order L, little-endian. */
    private val L = intArrayOf(
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
    )

    /** The field prime p = 2^255 − 19, little-endian. */
    private val P = IntArray(32) { if (it == 0) 0xed else if (it == 31) 0x7f else 0xff }

    /** The eight small-order encodings, lowercase hex (V4 §1.1 check 3). */
    public val SMALL_ORDER_ENCODINGS: Set<String> = setOf(
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    )
    private val NEGATIVE_ZERO = setOf(
        "0100000000000000000000000000000000000000000000000000000000000080",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    )

    private fun lessThan(a: IntArray, b: IntArray): Boolean {
        for (k in 31 downTo 0) if (a[k] != b[k]) return a[k] < b[k]
        return false
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun acceptablePoint(enc: ByteArray): Boolean {
        if (enc.size != 32) return false
        val y = IntArray(32) { enc[it].toInt() and 0xff }
        y[31] = y[31] and 0x7f
        if (!lessThan(y, P)) return false
        val h = hex(enc)
        return h !in NEGATIVE_ZERO && h !in SMALL_ORDER_ENCODINGS
    }

    /** V4 §1.1 checks 1–3. */
    public fun prechecks(key: ByteArray, sig: ByteArray): Boolean {
        if (key.size != 32 || sig.size != 64) return false
        val s = IntArray(32) { sig[32 + it].toInt() and 0xff }
        if (!lessThan(s, L)) return false
        return acceptablePoint(key) && acceptablePoint(sig.copyOfRange(0, 32))
    }
}
