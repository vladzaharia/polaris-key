// @pkey-feature sync.e2e
//
// The Kotlin conformance runner for the Cloud Sync E2E primitives in
// conformance/corpus/v2/sync-vectors.json (WIRE-CONTRACT-V5 section 13.10), read in place; it
// mirrors the Swift SyncVectorsTests. A runner reads the sections it implements: hkdfCases,
// envelopeCases, blindCases and canonicalJsonCases. The Gradle `test` task runs it on the JCA
// backend and `testTink` again with Tink forced for the X25519 the later sections use.

package im.plrs.key.conformance

import im.plrs.key.core.JsonText
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.CanonicalJson
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncCryptoException
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncKeys
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncVectorsTest : ConformanceSuite() {
    private val v: JsonObject = Corpus.v2("sync-vectors.json")

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun list(name: String): List<JsonObject> = v[name]!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.sOrNull(name: String): String? = this[name].stringValue

    @Test
    fun versionAndConstants() {
        assertEquals(1L, v["syncVectorsVersion"].longValue)
        val c = v["constants"]!!.obj
        assertEquals(c["envelopeOverheadBytes"].longValue, SyncEnvelope.OVERHEAD_BYTES.toLong())
        assertEquals(c["envelopeFixedBytes"].longValue, SyncEnvelope.FIXED_BYTES.toLong())
        assertEquals(c["paddingBlockBytes"].longValue, SyncEnvelope.PAD_BLOCK.toLong())
    }

    @Test
    fun hkdf() {
        val f = Failures("sync hkdf")
        for (c in list("hkdfCases")) {
            val ikm = bytes(c.s("ikmHex"))
            val salt = bytes(c.s("saltHex"))
            val info = bytes(c.s("infoHex"))
            f.equal(c.s("okmHex"), hex(SyncCrypto.hkdf(ikm, salt, info, c["length"].longValue!!.toInt()))) { c.s("id") }
            // The named derivation, where the table's ikm is the input the function takes.
            fun after(label: String): String = String(info, label.length + 1, info.size - label.length - 1, Charsets.UTF_8)
            val named: ByteArray? = when (c.s("label")) {
                "kid" -> SyncKeys.deriveKid(ikm)
                "coll" -> SyncKeys.deriveCollKey(ikm, after(SyncKeys.Label.COLL))
                "names" -> SyncKeys.deriveNamesKey(ikm)
                "chunk-id" -> SyncKeys.deriveChunkIdKey(ikm, after(SyncKeys.Label.CHUNK_ID))
                "value" -> SyncKeys.deriveValueKey(ikm, salt)
                "file" -> SyncKeys.deriveFileKey(ikm, salt)
                "chunk" -> SyncKeys.deriveChunkKey(ikm, salt)
                "recovery" -> SyncKeys.deriveRecoveryKey(ikm, String(salt, Charsets.UTF_8))
                "adopt" -> SyncKeys.deriveAdoptKey(ikm)
                else -> null
            }
            if (named != null) f.equal(c.s("okmHex"), hex(named)) { "${c.s("id")} named" }
        }
        f.done(list("hkdfCases").size)
    }

    private fun canonical(e: JsonElement): String = CanonicalJson.encode(e)

    @Test
    fun envelopes() {
        val f = Failures("sync envelope")
        for (c in list("envelopeCases")) {
            val root = bytes(c.s("rootHex"))
            val collection = c.s("collection")
            val env = bytes(c.s("envelopeHex"))
            val expect = c["expect"]!!.obj
            val seal = c["seal"]?.takeIf { it is JsonObject }?.obj
            if (seal != null) {
                // An alias case was sealed under the source name the reader accepts (expect.name).
                val again = SyncEnvelope.seal(root, collection, expect.s("name"), seal["value"]!!, bytes(seal.s("saltHex")))
                f.equal(c.s("envelopeHex"), hex(again)) { "${c.s("id")} seal" }
            }
            val aliases = c["aliases"]!!.arrayValue!!.map { it.stringValue!! }
            val got = SyncEnvelope.open(root, collection, c.s("name"), env, aliases)
            if (expect.s("result") == "ok") {
                if (got !is SyncEnvelope.Opened.Ok) {
                    f.check(false) { "${c.s("id")}: expected ok, got $got" }
                    continue
                }
                f.equal(expect.s("name"), got.name) { "${c.s("id")} name" }
                // Compared as canonical text: the corpus reader's number tokens may differ in spelling.
                f.equal(canonical(expect["value"] ?: kotlinx.serialization.json.JsonNull), canonical(got.value)) { "${c.s("id")} value" }
                val any = SyncEnvelope.openAnyName(root, collection, env)
                f.check(any is SyncEnvelope.Opened.Ok && any.name == got.name) { "${c.s("id")} openAnyName" }
            } else {
                f.equal(expect.s("reason"), (got as? SyncEnvelope.Opened.Refused)?.reason?.wire ?: "ok") { "${c.s("id")} reason" }
            }
        }
        f.done(list("envelopeCases").size)
    }

    @Test
    fun openedValueIsNeverPrinted() {
        val o = SyncEnvelope.Opened.Ok("theme", JsonPrimitive("secret-value"))
        assertFalse(o.toString().contains("secret-value"))
    }

    @Test
    fun blind() {
        val f = Failures("sync blind")
        for (c in list("blindCases")) {
            val kind = SyncBlind.Kind.fromWire(c.s("kind"))!!
            f.equal(c.s("blinded"), SyncBlind.blind(bytes(c.s("rootHex")), kind, c.s("ctx"), c.s("n"))) { c.s("id") }
            f.check(SyncBlind.isBlindedName(c.s("blinded"))) { "${c.s("id")} shape" }
        }
        f.done(list("blindCases").size)
        assertFalse(SyncBlind.isBlindedName("x:short"))
        assertFalse(SyncBlind.isBlindedName("y:" + "A".repeat(43)))
        assertFalse(SyncBlind.isBlindedName("x:" + "A".repeat(42) + "="))
    }

    private fun refuses(block: () -> Unit): Boolean = try {
        block()
        false
    } catch (ignored: SyncCryptoException) {
        true
    }

    @Test
    fun canonicalJson() {
        val f = Failures("sync canonical json")
        for (c in list("canonicalJsonCases")) {
            val special = c.sOrNull("special")
            val expect = c["expect"]!!.obj
            if (special != null) {
                val d = when (special) {
                    "NaN" -> Double.NaN
                    "Infinity" -> Double.POSITIVE_INFINITY
                    else -> Double.NEGATIVE_INFINITY
                }
                f.check(refuses { CanonicalJson.numberString(d) }) { "${c.s("id")} refused" }
                continue
            }
            val text = c.s("inputJson")
            if (expect.s("result") == "ok") {
                f.equal(expect.s("canonical"), CanonicalJson.canonicalize(text)) { c.s("id") }
            } else {
                f.check(refuses { CanonicalJson.canonicalize(text) }) { "${c.s("id")} refused" }
            }
        }
        f.done(list("canonicalJsonCases").size)
    }

    @Test
    fun canonicalJsonRefusesIntegersBeyond2Pow53() {
        assertEquals("9007199254740992", canonical(JsonText.parse("9007199254740992")))
        assertEquals("-9007199254740992", canonical(JsonText.parse("-9007199254740992")))
        for (t in listOf("9007199254740993", "4611686018427387904", "-9007199254740993", "-9223372036854775808")) {
            assertTrue(t, refuses { canonical(JsonText.parse(t)) })
        }
    }

    @Test
    fun numberPrinterMatchesEcmaScript() {
        val cases = listOf(
            0.1 to "0.1", -0.0 to "0", 1e21 to "1e+21", 1e-7 to "1e-7", 1.2345678901234568e20 to "123456789012345680000",
            1.5e-7 to "1.5e-7", 100.0 to "100", 0.000001 to "0.000001", 5e-324 to "5e-324",
            1.7976931348623157e308 to "1.7976931348623157e+308", -2.5 to "-2.5",
            1152921504606846976.0 to "1152921504606847000", 12345.678 to "12345.678",
            2.0e-3 to "0.002", 1e23 to "1e+23", 4.35 to "4.35", 123456789.0 to "123456789",
        )
        for ((d, s) in cases) assertEquals(s, CanonicalJson.numberString(d))
    }
}
