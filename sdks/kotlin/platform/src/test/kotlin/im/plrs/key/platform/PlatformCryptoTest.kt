package im.plrs.key.platform

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * CC-14b.8: [PlatformCrypto] against the corpus's known answers (RFC 7748 sections 5.2 and 6.1, the
 * GCM specification's AES-256 cases, as conformance/corpus/v2/noise-vectors.json carries them). The
 * API level is injected: 33 has JCA `XDH`, 24 does not (D-14). Robolectric runs the default (API 34).
 */
@RunWith(RobolectricTestRunner::class)
class PlatformCryptoTest {
    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { i ->
        s.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    }
    private val api33 = PlatformCrypto(33)

    private fun reason(block: () -> Unit): String {
        try {
            block()
        } catch (e: PlatformCryptoException) {
            return e.reason
        }
        fail("expected a refusal")
        return ""
    }

    @Test
    fun x25519Rfc7748Section52() {
        assertArrayEquals(
            hex("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"),
            api33.x25519(
                hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
                hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
            ),
        )
        // The second vector's u has bit 255 set: it is ignored.
        assertArrayEquals(
            hex("95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957"),
            api33.x25519(
                hex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"),
                hex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"),
            ),
        )
    }

    @Test
    fun x25519Rfc7748Section61() {
        val a = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val b = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        val aPub = api33.x25519Public(a)
        val bPub = api33.x25519Public(b)
        assertArrayEquals(hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"), aPub)
        assertArrayEquals(hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"), bPub)
        val shared = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        assertArrayEquals(shared, api33.x25519(a, bPub))
        assertArrayEquals(shared, api33.x25519(b, aPub))
    }

    @Test
    fun anAllZeroOutputIsRefusedAsDhZero() {
        val sk = hex("29845ed60a63b1edbe504c9fe191b97738a61c0661b8bb75e30c8ca827d02944")
        val zero = ByteArray(32)
        val zeroTop = ByteArray(32).also { it[31] = 0x80.toByte() }
        val one = ByteArray(32).also { it[0] = 1 }
        for (u in listOf(zero, zeroTop, one)) {
            assertEquals(PlatformCryptoException.DH_ZERO, reason { api33.x25519(sk, u) })
        }
    }

    @Test
    fun x25519IsUnsupportedBelowApi33AndLengthChecked() {
        val sk = ByteArray(32) { 7 }
        val api24 = PlatformCrypto(24)
        assertFalse(api24.x25519Supported)
        assertTrue(api33.x25519Supported)
        assertEquals(PlatformCryptoException.UNSUPPORTED, reason { api24.x25519(sk, sk) })
        assertEquals(PlatformCryptoException.UNSUPPORTED, reason { api24.x25519Public(sk) })
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.x25519(ByteArray(31), sk) })
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.x25519(sk, ByteArray(33)) })
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.x25519Public(ByteArray(0)) })
        // The default constructor reads the running API (Robolectric: 34).
        assertTrue(PlatformCrypto().x25519Supported)
    }

    @Test
    fun aesGcmSpecificationCases() {
        val key = ByteArray(32)
        val nonce = ByteArray(12)
        // Cases 13 and 14, on every API level.
        for (c in listOf(PlatformCrypto(24), api33)) {
            val tag = hex("530f8afbc74536b9a963b4f1c4cb738b")
            assertArrayEquals(tag, c.aesGcmSeal(key, nonce, ByteArray(0), ByteArray(0)))
            val sealed = hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919")
            assertArrayEquals(sealed, c.aesGcmSeal(key, nonce, ByteArray(0), ByteArray(16)))
            assertArrayEquals(ByteArray(16), c.aesGcmOpen(key, nonce, ByteArray(0), sealed))
            assertArrayEquals(ByteArray(0), c.aesGcmOpen(key, nonce, ByteArray(0), tag))
        }
    }

    @Test
    fun aesGcmRefusesATamperedTagAadOrKeyAndBadLengths() {
        val key = ByteArray(32) { it.toByte() }
        val nonce = ByteArray(12) { 5 }
        val aad = "ctx".toByteArray()
        val sealed = api33.aesGcmSeal(key, nonce, aad, "hello".toByteArray())
        assertArrayEquals("hello".toByteArray(), api33.aesGcmOpen(key, nonce, aad, sealed))
        for (i in sealed.indices) {
            val bad = sealed.copyOf()
            bad[i] = (bad[i].toInt() xor 1).toByte()
            assertNull(api33.aesGcmOpen(key, nonce, aad, bad))
        }
        assertNull(api33.aesGcmOpen(key, nonce, "other".toByteArray(), sealed))
        assertNull(api33.aesGcmOpen(ByteArray(32), nonce, aad, sealed))
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.aesGcmSeal(ByteArray(16), nonce, aad, sealed) })
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.aesGcmSeal(key, ByteArray(8), aad, sealed) })
        assertEquals(PlatformCryptoException.BAD_INPUT, reason { api33.aesGcmOpen(key, nonce, aad, ByteArray(15)) })
        // Larger than a Noise message (no 64 KiB cap on this path).
        val big = ByteArray(1 shl 20) { it.toByte() }
        assertArrayEquals(big, api33.aesGcmOpen(key, nonce, aad, api33.aesGcmSeal(key, nonce, aad, big)))
    }
}
