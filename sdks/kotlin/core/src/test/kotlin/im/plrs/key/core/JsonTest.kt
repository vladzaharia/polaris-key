// @pkey-feature core.verify
//
// The strict JSON scanner's edges that the corpus pins through signed payloads, checked directly:
// duplicate names (by scalar value, never canonical equivalence), U+0000 in a name, the nesting cap,
// lone surrogates, number ranges, and the non-wire-integer pointers (escaped per RFC 6901). Plus
// the backend selection: both Ed25519 backends agree on a valid and a tampered signature.

package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
    private fun strict(s: String) = StrictJson.validate(s.toByteArray(Charsets.UTF_8))

    @Test
    fun duplicateNamesAreRefusedByScalarValue() {
        assertNull(strict("""{"a":1,"a":2}"""))
        assertNull(strict("""{"a":1,"a":2}"""))
        // "é" precomposed and decomposed are two names (never normalized).
        assertNotNull(strict("{\"\u00e9\":1,\"e\u0301\":2}"))
        assertNull(strict("{\"\u00e9\":1,\"\\u00e9\":2}"))
        assertNull(strict("""{"a\u0000":1}"""))
    }

    @Test
    fun theGrammarIsRfc8259() {
        assertNull(strict("""[1]"""))
        assertNull(strict("""{"a":1,}"""))
        assertNull(strict("""{"a":NaN}"""))
        assertNull(strict("""{"a":"\ud800"}"""))
        assertNull(strict("\uFEFF{}"))
        assertNull(strict("""{"a":01}"""))
        assertNull(strict("""{"a":1e400}"""))
        assertNotNull(strict("""{"a":1e307}"""))
        assertNull(strict("{".repeat(MAX_JSON_DEPTH + 1) + "}".repeat(MAX_JSON_DEPTH + 1)))
    }

    @Test
    fun nonWireIntegersArePointersToTheirTokens() {
        val p = strict("""{"issuedAt":1700000000.0,"n":{"a/b":[1,9007199254740992]},"ok":9007199254740991}""")!!
        assertEquals(setOf("/issuedAt", "/n/a~1b/1"), p.nonWireIntegers.pointers)
        assertTrue("/issuedAt" in p.nonWireIntegers)
        assertFalse("/ok" in p.nonWireIntegers)
        assertFalse(wireInteger(1700000000, "/issuedAt", 0, p.nonWireIntegers))
        assertTrue(wireInteger(9007199254740991, "/ok", 0, p.nonWireIntegers))
        assertEquals(NonWireIntegers.of("/issuedAt", "/n/a~1b/1"), p.nonWireIntegers)
    }

    @Test
    fun theLenientParserKeepsTheLastDuplicate() {
        assertEquals("2", JsonText.parse("""{"a":1,"a":2}""").objectValue!!["a"].longValue.toString())
        assertNull(JsonText.parseOrNull("{"))
        assertTrue(jsonEquals(JsonText.parse("[1.0]"), JsonText.parse("[1e0]")))
    }

    @Test
    fun bothEd25519BackendsAgree() {
        val gen = java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val raw = gen.public.encoded.takeLast(32).toByteArray()
        val message = "hello".toByteArray()
        val sig = java.security.Signature.getInstance("Ed25519").run {
            initSign(gen.private)
            update(message)
            sign()
        }
        for (v in listOf(JcaEd25519Verifier, TinkEd25519Verifier)) {
            assertTrue(v.name, v.verify(raw, message, sig))
            assertFalse(v.name, v.verify(raw, "hellp".toByteArray(), sig))
        }
        assertFalse(UnavailableEd25519Verifier.verify(raw, message, sig))
        assertTrue(Ed25519Strict.prechecks(raw, sig))
    }
}
