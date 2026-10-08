// Ed25519 — the signature primitive of every Polaris Key document (WIRE-CONTRACT-V4 §1.1).
//
// One port, two backends:
//
//   JcaEd25519Verifier   `Signature.getInstance("Ed25519")`: JDK 15+ and Android API 33+.
//   TinkEd25519Verifier  Tink's pure-Java `Ed25519Verify`. Tink is a compileOnly dependency of
//                        :core: the Android glue (P6-12) brings tink-android, and a test classpath
//                        brings tink.
//
// SP-50: a backend is chosen by a KNOWN-ANSWER TEST, never by whether its classes load. On Android
// 16 (API 36) `KeyFactory.getInstance("Ed25519")` resolves to the AndroidKeyStore provider, which
// loads fine and then rejects every valid signature, the RFC 8032 vectors included. So `Ed25519.select`
// runs RFC 8032 §7.1 TEST 1 and TEST 2 (each must verify) and a one-bit change of each (each must
// fail) through every candidate, in the runtime's order of preference (Tink first on Android, the
// JCA first elsewhere), and takes the first that answers all four correctly; none is the
// fail-closed `UnavailableEd25519Verifier`.
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

/** The JCA backend (JDK 15+, Android API 33+, where its known-answer test passes). */
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

/** The Tink backend (preferred on Android). Present only when Tink is on the classpath. */
public object TinkEd25519Verifier : Ed25519Verifier {
    override val name: String = "tink"

    /** True when Tink's `Ed25519Verify` can be loaded (named directly, so a minifier keeps it). */
    public val isAvailable: Boolean by lazy {
        try {
            com.google.crypto.tink.subtle.Ed25519Verify::class.java.name.isNotEmpty()
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
    /** The candidates in this runtime's order of preference: Tink first on Android, the JCA first elsewhere. */
    public fun candidates(android: Boolean = RuntimeFamily.isAndroid): List<Ed25519Verifier> =
        if (android) listOf(TinkEd25519Verifier, JcaEd25519Verifier) else listOf(JcaEd25519Verifier, TinkEd25519Verifier)

    /** The first of [candidates] that passes [knownAnswer], else [UnavailableEd25519Verifier]. */
    public fun select(candidates: List<Ed25519Verifier> = candidates()): Ed25519Verifier =
        candidates.firstOrNull { knownAnswer(it) } ?: UnavailableEd25519Verifier

    /**
     * RFC 8032 §7.1 TEST 1 (the empty message) and TEST 2 (one byte) must verify, and the same
     * signatures with one bit flipped must not. Never throws: a backend that throws fails.
     */
    public fun knownAnswer(verifier: Ed25519Verifier): Boolean = try {
        KNOWN_ANSWERS.all { (key, message, signature) ->
            val tampered = signature.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
            verifier.verify(key, message, signature) && !verifier.verify(key, message, tampered)
        }
    } catch (e: Throwable) {
        false
    }

    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** RFC 8032 §7.1 TEST 1 and TEST 2: (public key, message, signature). */
    private val KNOWN_ANSWERS: List<Triple<ByteArray, ByteArray, ByteArray>> by lazy {
        listOf(
            Triple(
                hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
                ByteArray(0),
                hex(
                    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
                ),
            ),
            Triple(
                hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
                hex("72"),
                hex(
                    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
                ),
            ),
        )
    }

    /**
     * The backend every verification uses: [select] over this runtime's candidates (see the file
     * comment), so a backend that loads but answers wrongly is never used and an unusable runtime
     * refuses every document instead of accepting one unverified. A host may set it, for example to
     * force Tink in a test.
     */
    // Last: its initializer runs the known-answer test over KNOWN_ANSWERS, declared above.
    @Volatile
    public var verifier: Ed25519Verifier = select()
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
