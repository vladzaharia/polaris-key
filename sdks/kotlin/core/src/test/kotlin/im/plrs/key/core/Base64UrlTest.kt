// @pkey-feature core.verify
//
// SP-50: Base64Url is its own codec (java.util.Base64 is Android API 26+, the SDK's minSdk 24). It must
// answer exactly as the JDK's basic codec did, so every verdict the corpus pins stays put: the same
// bytes, the same refusals (bad characters, "=" where a unit starts, a dangling character, anything
// after the padding), the JDK's tolerance of leftover bits.

package im.plrs.key.core

import java.util.Base64
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class Base64UrlTest {
    /** The previous implementation, over the JDK. */
    private fun jdkDecode(s: String): ByteArray? {
        var b64 = s.replace('-', '+').replace('_', '/')
        val remainder = b64.length % 4
        if (remainder != 0) b64 += "=".repeat(4 - remainder)
        return try {
            Base64.getDecoder().decode(b64)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    @Test
    fun encodingMatchesTheJdk() {
        val random = Random(8032)
        for (size in 0..200) {
            val bytes = ByteArray(size).also { random.nextBytes(it) }
            assertEquals(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes), Base64Url.encode(bytes))
        }
    }

    @Test
    fun decodingMatchesTheJdkOnEdgesAndAtRandom() {
        val edges = listOf(
            "", "A", "AA", "AAA", "AAAA", "AB", "AB==", "AB=", "A=", "A==", "A===", "====", "=", "==", "AAAA=",
            "AA==AA", "AA=A", "QQ", "QR", "QR==", "QUJD", "QUJD=", "-_-_", "+/+/", "-_", "a b", "\n", "é", "AA\u0000A",
            "YWJj", "YWJjZA", "YWJjZA=", "YWJjZA==", "YWJjZGU", "YWJjZGU=", "YWJjZGVm",
        )
        for (s in edges) assertSame(s, jdkDecode(s), Base64Url.decode(s))
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_=" + " .ÿ"
        val random = Random(25519)
        repeat(20_000) {
            val s = String(CharArray(random.nextInt(0, 14)) { alphabet[random.nextInt(alphabet.length)] })
            assertSame(s, jdkDecode(s), Base64Url.decode(s))
        }
    }

    @Test
    fun strictDecodingKeepsItsAlphabet() {
        assertArrayEquals("abc".toByteArray(), Base64Url.decodeStrict("YWJj"))
        assertEquals(null, Base64Url.decodeStrict("YWJj="))
        assertEquals(null, Base64Url.decodeStrict("YW+j"))
    }

    private fun assertSame(input: String, expected: ByteArray?, actual: ByteArray?) {
        if (expected == null) assertEquals("\"$input\"", null, actual) else assertArrayEquals("\"$input\"", expected, actual)
    }
}
