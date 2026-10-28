// The device keys' curve operations (CC-26.5; plans/CC-01.md R-5): Ed25519 signing and X25519
// agreement over raw 32-byte keys, behind one port with two backends, as Ed25519.kt does for
// verifying.
//
//   JcaDeviceCurves   `Signature("Ed25519")` and `KeyAgreement("X25519")`: JDK 15+ and Android API 33+.
//   TinkDeviceCurves  Tink's pure-Java `Ed25519Sign` and `X25519` (compileOnly, as for the verifier).
//
// A backend is chosen by KNOWN ANSWERS (RFC 8032 section 7.1 TEST 1 for signing, RFC 7748 section
// 6.1 for agreement), never by whether its classes load (SP-50: a provider can load and answer
// wrongly). None passing is the fail-closed `UnavailableDeviceCurves`: it makes no keys.

package im.plrs.key.core

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

/** A fresh Ed25519 key pair as raw bytes: the 32-byte seed (private half) and the 32-byte public key. */
public class RawEd25519Pair(public val seed: ByteArray, public val publicKey: ByteArray)

/** Ed25519 and X25519 over raw keys. Private halves are only ever passed in, never returned except by generation. */
public interface DeviceCurves {
    /** A short name for diagnostics: `jca`, `tink` or `unavailable`. */
    public val name: String

    /** A new Ed25519 pair. Throws [DeviceKeyUnsupportedException] when the backend cannot. */
    public fun ed25519Generate(): RawEd25519Pair

    /** The 64-byte signature by `seed` over `message`. */
    public fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray

    /** X25519 of `privateKey` and `peer` (32 bytes each); null when the backend refuses (all-zero output). */
    public fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray?
}

/** The store cannot hold or use the keys here (no Ed25519 or X25519, no storage it may use). */
public class DeviceKeyUnsupportedException(message: String) : Exception(message)

/** The JCA backend. */
public object JcaDeviceCurves : DeviceCurves {
    override val name: String = "jca"

    private val ED_PKCS8 = byteArrayOf(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)
    private val X_PKCS8 = byteArrayOf(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20)
    private val X_SPKI = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00)

    /** True when this runtime's JCA provides both curves. */
    public val isAvailable: Boolean by lazy {
        try {
            Signature.getInstance("Ed25519")
            KeyPairGenerator.getInstance("Ed25519")
            KeyAgreement.getInstance("X25519")
            KeyFactory.getInstance("X25519")
            true
        } catch (e: Exception) {
            false
        }
    }

    override fun ed25519Generate(): RawEd25519Pair {
        try {
            val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
            val priv = pair.private.encoded
            val pub = pair.public.encoded
            if (priv.size != ED_PKCS8.size + 32 || pub.size < 32) throw DeviceKeyUnsupportedException("unexpected Ed25519 key encoding")
            val out = RawEd25519Pair(priv.copyOfRange(priv.size - 32, priv.size), pub.copyOfRange(pub.size - 32, pub.size))
            priv.fill(0)
            return out
        } catch (e: DeviceKeyUnsupportedException) {
            throw e
        } catch (e: Exception) {
            throw DeviceKeyUnsupportedException("no Ed25519 key generation here")
        }
    }

    override fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray {
        if (seed.size != 32) throw IllegalArgumentException("bad seed")
        val pkcs8 = ED_PKCS8 + seed
        try {
            val key = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(pkcs8))
            val s = Signature.getInstance("Ed25519")
            s.initSign(key)
            s.update(message)
            return s.sign()
        } catch (e: Exception) {
            throw DeviceKeyUnsupportedException("no Ed25519 signing here")
        } finally {
            pkcs8.fill(0)
        }
    }

    override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray? {
        if (privateKey.size != 32 || peer.size != 32) return null
        val pkcs8 = X_PKCS8 + privateKey
        return try {
            val kf = KeyFactory.getInstance("X25519")
            val ka = KeyAgreement.getInstance("X25519")
            ka.init(kf.generatePrivate(PKCS8EncodedKeySpec(pkcs8)))
            ka.doPhase(kf.generatePublic(X509EncodedKeySpec(X_SPKI + peer)), true)
            ka.generateSecret()
        } catch (e: Exception) {
            null
        } finally {
            pkcs8.fill(0)
        }
    }
}

/** The Tink backend (preferred on Android below API 33). Present only when Tink is on the classpath. */
public object TinkDeviceCurves : DeviceCurves {
    override val name: String = "tink"

    /** True when Tink's `Ed25519Sign` and `X25519` can be loaded (named directly, so a minifier keeps them). */
    public val isAvailable: Boolean by lazy {
        try {
            com.google.crypto.tink.subtle.Ed25519Sign::class.java.name.isNotEmpty() &&
                com.google.crypto.tink.subtle.X25519::class.java.name.isNotEmpty()
        } catch (e: Throwable) {
            false
        }
    }

    override fun ed25519Generate(): RawEd25519Pair {
        if (!isAvailable) throw DeviceKeyUnsupportedException("Tink is not available")
        try {
            val pair = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair()
            return RawEd25519Pair(pair.privateKey, pair.publicKey)
        } catch (e: Throwable) {
            throw DeviceKeyUnsupportedException("no Ed25519 key generation here")
        }
    }

    override fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray {
        if (seed.size != 32) throw IllegalArgumentException("bad seed")
        if (!isAvailable) throw DeviceKeyUnsupportedException("Tink is not available")
        try {
            return com.google.crypto.tink.subtle.Ed25519Sign(seed).sign(message)
        } catch (e: Throwable) {
            throw DeviceKeyUnsupportedException("no Ed25519 signing here")
        }
    }

    override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray? {
        if (privateKey.size != 32 || peer.size != 32 || !isAvailable) return null
        return try {
            com.google.crypto.tink.subtle.X25519.computeSharedSecret(privateKey, peer)
        } catch (e: Throwable) {
            null
        }
    }
}

/** No backend: no keys are made and every agreement is refused (fail closed). */
public object UnavailableDeviceCurves : DeviceCurves {
    override val name: String = "unavailable"

    override fun ed25519Generate(): RawEd25519Pair = throw DeviceKeyUnsupportedException("no Ed25519 or X25519 here")

    override fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray = throw DeviceKeyUnsupportedException("no Ed25519 or X25519 here")

    override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray? = null
}

/** X25519 point checks shared by every caller. */
public object X25519Points {
    private val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val LOW_ORDER: List<BigInteger> = listOf(
        BigInteger.ZERO,
        BigInteger.ONE,
        BigInteger("325606250916557431795983626356110631294008115727848805560023387167927233504"),
        BigInteger("39382357235489614581723060781553021112529911719440698176882885853963445705823"),
        P.subtract(BigInteger.ONE),
    )

    /** The little-endian u coordinate with bit 255 masked, reduced mod p (RFC 7748 section 5). */
    private fun u(enc: ByteArray): BigInteger {
        val be = ByteArray(32) { enc[31 - it] }
        be[0] = (be[0].toInt() and 0x7f).toByte()
        return BigInteger(1, be).mod(P)
    }

    /** True for the encodings of the points of order 1, 2, 4 and 8 (any spelling, high bit ignored). */
    public fun isLowOrder(enc: ByteArray): Boolean = enc.size == 32 && u(enc) in LOW_ORDER

    /** The one spelling an issuer accepts: bit 255 clear, u < p, and not low order. */
    public fun isAcceptableAgreeKey(enc: ByteArray): Boolean {
        if (enc.size != 32 || (enc[31].toInt() and 0x80) != 0) return false
        val be = ByteArray(32) { enc[31 - it] }
        return BigInteger(1, be) < P && !isLowOrder(enc)
    }

    /** The base point u = 9. */
    public val BASE: ByteArray = ByteArray(32).also { it[0] = 9 }
}

/** The process-wide curve backend. */
public object DeviceCurvesSelection {
    private val random = SecureRandom()

    /** The candidates in this runtime's order of preference: Tink first on Android, the JCA first elsewhere. */
    public fun candidates(android: Boolean = RuntimeFamily.isAndroid): List<DeviceCurves> =
        if (android) listOf(TinkDeviceCurves, JcaDeviceCurves) else listOf(JcaDeviceCurves, TinkDeviceCurves)

    /** The first of [candidates] that passes [knownAnswer], else [UnavailableDeviceCurves]. */
    public fun select(candidates: List<DeviceCurves> = candidates()): DeviceCurves =
        candidates.firstOrNull { knownAnswer(it) } ?: UnavailableDeviceCurves

    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /**
     * RFC 8032 TEST 1 (the seed signs the empty message to the published signature), a fresh pair
     * signs and verifies on the strict verifier, and RFC 7748 section 6.1's agreement (both ways,
     * and the base point gives the published public key). Never throws.
     */
    public fun knownAnswer(c: DeviceCurves): Boolean = try {
        val seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        val sig = hex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        )
        val alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val alicePub = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        val bob = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        val bobPub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        val shared = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        val fresh = c.ed25519Generate()
        val msg = byteArrayOf(1, 2, 3)
        c.ed25519Sign(seed, ByteArray(0)).contentEquals(sig) &&
            fresh.seed.size == 32 && fresh.publicKey.size == 32 &&
            Ed25519Strict.prechecks(fresh.publicKey, c.ed25519Sign(fresh.seed, msg)) &&
            verifiesWithAnyBackend(fresh.publicKey, msg, c.ed25519Sign(fresh.seed, msg)) &&
            c.x25519(alice, X25519Points.BASE)?.contentEquals(alicePub) == true &&
            c.x25519(alice, bobPub)?.contentEquals(shared) == true &&
            c.x25519(bob, alicePub)?.contentEquals(shared) == true
    } catch (e: Throwable) {
        false
    }

    // The signature must verify on a backend that itself passes its known answers (Ed25519.verifier).
    private fun verifiesWithAnyBackend(pub: ByteArray, msg: ByteArray, sig: ByteArray): Boolean =
        Ed25519.verifier.verify(pub, msg, sig)

    internal fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    /** The backend every device key uses; a host may set it, for example to force Tink in a test. */
    @Volatile
    public var curves: DeviceCurves = select()
}
