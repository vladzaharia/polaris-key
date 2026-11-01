package im.plrs.key.godot

import im.plrs.key.platform.PlatformCrypto
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** CC-14b.8: the binary crypto entry: status byte, length checks at the boundary, refusals. */
class CryptoCommandsTest {
    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private val c33 = CryptoCommands(PlatformCrypto(33))
    private val c24 = CryptoCommands(PlatformCrypto(24))
    private fun ok(b: ByteArray) = byteArrayOf(CryptoCommands.OK) + b
    private fun st(s: Byte) = byteArrayOf(s)

    @Test
    fun x25519AndPublicKnownAnswers() {
        val a = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val bPub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        assertArrayEquals(ok(hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")), c33.x25519(a.copyOf(), bPub))
        assertArrayEquals(ok(hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")), c33.x25519Public(a))
    }

    @Test
    fun x25519RefusalsAreStatusBytes() {
        val sk = ByteArray(32) { 3 }
        assertArrayEquals(st(CryptoCommands.REFUSED), c33.x25519(sk, ByteArray(32)))
        assertArrayEquals(st(CryptoCommands.UNSUPPORTED), c24.x25519(sk, sk))
        assertArrayEquals(st(CryptoCommands.UNSUPPORTED), c24.x25519Public(sk))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c33.x25519(ByteArray(5), sk))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c33.x25519(null, sk))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c33.x25519Public(null))
    }

    @Test
    fun sealAndOpenKnownAnswersAndRefusals() {
        val key = ByteArray(32)
        val nonce = ByteArray(12)
        val empty = ByteArray(0)
        assertArrayEquals(ok(hex("530f8afbc74536b9a963b4f1c4cb738b")), c24.seal(key, nonce, empty, empty))
        val sealed = hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919")
        assertArrayEquals(ok(sealed), c24.seal(key, nonce, empty, ByteArray(16)))
        assertArrayEquals(ok(ByteArray(16)), c24.open(key, nonce, empty, sealed))
        // A valid empty message opens to the status byte alone plus nothing: OK, then zero bytes.
        assertArrayEquals(ok(empty), c24.open(key, nonce, empty, hex("530f8afbc74536b9a963b4f1c4cb738b")))
        val bad = sealed.copyOf().also { it[20] = (it[20].toInt() xor 1).toByte() }
        assertArrayEquals(st(CryptoCommands.REFUSED), c24.open(key, nonce, empty, bad))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c24.seal(ByteArray(31), nonce, empty, empty))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c24.open(key, ByteArray(13), empty, sealed))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c24.open(key, nonce, empty, ByteArray(3)))
        assertArrayEquals(st(CryptoCommands.BAD_INPUT), c24.seal(key, nonce, null, empty))
        assertEquals(1, c24.open(key, nonce, empty, bad).size)
    }

    @Test
    fun syncAnswersEmptyAadTamperAndOneMebibyte() {
        val key = ByteArray(32) { it.toByte() }
        val nonce = ByteArray(12) { (0xA0 + it).toByte() }
        val aad = "pkey-sync-kat".toByteArray(Charsets.UTF_8)
        val plain = ByteArray(1 shl 20) { (it * 31 + 7).toByte() }
        val sealed = c24.seal(key.copyOf(), nonce, aad, plain)
        assertEquals(1 + plain.size + 16, sealed.size)
        assertEquals(CryptoCommands.OK, sealed[0])
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(sealed.copyOfRange(1, sealed.size))
        assertEquals("20985c5839f5d4ccc63675c2e97146b4e8de8c720a4536b93b8f36b9fa50d672", digest.joinToString("") { "%02x".format(it) })
        assertArrayEquals(ok(plain), c24.open(key.copyOf(), nonce, aad, sealed.copyOfRange(1, sealed.size)))
        val flipped = sealed.copyOfRange(1, sealed.size).also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertArrayEquals(st(CryptoCommands.REFUSED), c24.open(key.copyOf(), nonce, aad, flipped))
        // The largest call the sync facade hands a lane: 1 MiB with 64 KiB of AAD.
        val bigAad = ByteArray(64 * 1024) { 0x5A }
        val big = c24.seal(key.copyOf(), nonce, bigAad, plain)
        assertEquals(1 + plain.size + 16, big.size)
        assertArrayEquals(ok(plain), c24.open(key.copyOf(), nonce, bigAad, big.copyOfRange(1, big.size)))
        assertArrayEquals(st(CryptoCommands.REFUSED), c24.open(key.copyOf(), nonce, bigAad.copyOf().also { it[0] = 0 }, big.copyOfRange(1, big.size)))
    }

    @Test
    fun keyArraysAreWipedOnEveryPath() {
        val zero = ByteArray(32)
        val peer = ByteArray(32).also { it[0] = 9 }
        fun key() = ByteArray(32) { 7 }
        key().let { c33.x25519(it, peer); assertArrayEquals(zero, it) }
        key().let { c33.x25519(it, ByteArray(32)); assertArrayEquals(zero, it) }
        key().let { c24.x25519(it, peer); assertArrayEquals(zero, it) }
        key().let { c33.x25519(it, ByteArray(5)); assertArrayEquals(zero, it) }
        key().let { c33.x25519Public(it); assertArrayEquals(zero, it) }
        val nonce = ByteArray(12)
        key().let { k ->
            val sealed = c24.seal(k, nonce, ByteArray(0), byteArrayOf(1)).copyOfRange(1, 18)
            assertArrayEquals(zero, k)
            key().let { k2 -> c24.open(k2, nonce, ByteArray(0), sealed); assertArrayEquals(zero, k2) }
            val k3 = key().also { it[0] = 1 }
            c24.open(k3, nonce, ByteArray(0), sealed)
            assertArrayEquals(zero, k3)
        }
        key().let { c24.seal(it, ByteArray(3), ByteArray(0), ByteArray(0)); assertArrayEquals(zero, it) }
    }
}
