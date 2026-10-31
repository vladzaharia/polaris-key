// @pkey-feature sync.e2e
//
// The Kotlin conformance runner for the Cloud Sync E2E primitives in
// conformance/corpus/v2/sync-vectors.json (WIRE-CONTRACT-V5 section 13.10), read in place; it
// mirrors the Swift SyncVectorsTests. A runner reads the sections it implements: hkdfCases,
// envelopeCases, blindCases, canonicalJsonCases, hpkeAnchor, wrapCases, recoveryCodeCases and
// adoptCases. The Gradle `test` task runs it on the JCA backend and `testTink` again with Tink
// forced: the X25519 of the HPKE sections then runs on Tink (DeviceCurves), the AEAD on the JCA.

package im.plrs.key.conformance

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.JcaDeviceCurves
import im.plrs.key.core.JsonText
import im.plrs.key.core.TinkDeviceCurves
import im.plrs.key.core.X25519Points
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.CanonicalJson
import im.plrs.key.core.sync.HpkeBaseMode
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncCryptoException
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncHpke
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncRecovery
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
            c["record"]?.takeIf { it is JsonObject }?.let { checkRecordRow(f, c, openRecord(root, collection, it.obj, env)) }
        }
        f.done(list("envelopeCases").size)
    }

    /** A record row (the reader of section 13.10.4): what [got] must be, from the row's own `expect`. */
    private fun checkRecordRow(f: Failures, c: JsonObject, got: SyncEnvelope.Opened) {
        val expect = c["expect"]!!.obj
        if (expect.s("result") == "ok") {
            val ok = got as? SyncEnvelope.Opened.Ok
            f.check(ok != null && ok.name == expect.s("name")) { "${c.s("id")} record name" }
            val want = canonical(expect["value"] ?: kotlinx.serialization.json.JsonNull)
            f.equal(want, ok?.value?.let(::canonical)) { "${c.s("id")} record value" }
        } else {
            f.equal(expect.s("reason"), (got as? SyncEnvelope.Opened.Refused)?.reason?.wire ?: "ok") { "${c.s("id")} record reason" }
        }
    }

    /**
     * Opens a sealed record value, field or element: the envelope first, then `k` split at its first U+0000, the
     * blinded forms recomputed and compared with the wire names; a difference is `name`. The container fixes the
     * kind, and an element's canonical JSON must be the name part of `k`.
     */
    private fun openRecord(root: ByteArray, collection: String, wire: JsonObject, env: ByteArray): SyncEnvelope.Opened {
        val r = SyncEnvelope.openAnyName(root, collection, env)
        return if (r is SyncEnvelope.Opened.Ok &&
            !recordNamesMatch(root, collection, wire, r)
        ) {
            SyncEnvelope.Opened.Refused(SyncEnvelope.Invalid.Name)
        } else {
            r
        }
    }

    private fun recordNamesMatch(root: ByteArray, collection: String, wire: JsonObject, r: SyncEnvelope.Opened.Ok): Boolean {
        val kind = wire.s("kind")
        val cut = r.name.indexOf('\u0000')
        val id = if (kind == "value") r.name else r.name.substringBefore('\u0000')
        val rest = r.name.substring(cut + 1)
        val blindKind = SyncBlind.Kind.fromWire(kind)
        return when {
            kind != "value" && cut < 0 -> false
            SyncBlind.blind(root, SyncBlind.Kind.Record, collection, id) != wire.s("id") -> false
            kind == "value" -> true
            blindKind == null || SyncBlind.blind(root, blindKind, collection, rest) != wire.s("name") -> false
            else -> kind != "element" || canonical(r.value) == rest
        }
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

    // -- U-39.7: HPKE, the wrap, the recovery code and adopt ---------------------------------------

    private val curves: DeviceCurves = if (Corpus.backend == "tink") TinkDeviceCurves else JcaDeviceCurves

    /** The port's `dh` over [privateKey]: a refused peer key or an all-zero output is null. */
    private fun dhOver(privateKey: ByteArray): suspend (ByteArray) -> ByteArray? = { peer ->
        curves.x25519(privateKey, peer)?.takeIf { out -> out.any { it.toInt() != 0 } }
    }

    @Test
    fun hpkeAnchor() = runBlocking {
        val a = v["hpkeAnchor"]!!.obj["vector"]!!.obj
        val e = a["encryption"]!!.obj
        val info = bytes(a.s("info"))
        val aad = bytes(e.s("aad"))
        val pt = bytes(e.s("pt"))
        val sealed = SyncHpke.seal(bytes(a.s("pkRm")), SyncHpke.Binding(info, aad), pt, SyncHpke.Ephemeral(bytes(a.s("skEm")), curves))
        assertEquals(a.s("enc"), hex(sealed.enc))
        assertEquals(e.s("ct"), hex(sealed.ct))
        assertEquals(a.s("pkRm"), hex(curves.x25519(bytes(a.s("skRm")), X25519Points.BASE)!!))
        val opened = SyncHpke.open(bytes(a.s("pkRm")), dhOver(bytes(a.s("skRm"))), bytes(a.s("enc")), SyncHpke.Binding(info, aad), bytes(e.s("ct")))
        assertEquals(e.s("pt"), hex(opened!!))
        // The key schedule's own outputs.
        val dh = curves.x25519(bytes(a.s("skEm")), bytes(a.s("pkRm")))!!
        val ss = HpkeBaseMode.sharedSecret(dh, bytes(a.s("enc")) + bytes(a.s("pkRm")))
        assertEquals(a.s("shared_secret"), hex(ss))
        val ks = HpkeBaseMode.keySchedule(ss, info)
        assertEquals(a.s("key"), hex(ks.key))
        assertEquals(a.s("base_nonce"), hex(ks.nonce))
    }

    @Test
    fun hpkeRoundTripsWithAFreshEphemeralKey() = runBlocking {
        val sk = SyncCrypto.random(32)
        val pk = curves.x25519(sk, X25519Points.BASE)!!
        val b = SyncHpke.Binding("i".toByteArray(), "a".toByteArray())
        val s = SyncHpke.seal(pk, b, "hello".toByteArray(), SyncHpke.Ephemeral(curves = curves))
        assertEquals(32, s.enc.size)
        assertEquals("hello", String(SyncHpke.open(pk, dhOver(sk), s.enc, b, s.ct)!!))
        assertNull(SyncHpke.open(pk, dhOver(sk), s.enc, SyncHpke.Binding("j".toByteArray(), b.aad), s.ct))
    }

    @Test
    fun wraps() = runBlocking {
        val f = Failures("sync wrap")
        for (c in list("wrapCases")) {
            val ctx = SyncHpke.WrapContext(c.s("product"), c.s("deviceId"), c.s("ringId"), c["epoch"].longValue!!.toInt())
            val kid = bytes(c.s("kidHex"))
            val priv = bytes(c.s("recipientPrivateHex"))
            val pub = curves.x25519(priv, X25519Points.BASE)!!
            val w = c["wrap"]!!.obj
            val wrap = SyncHpke.Wrap(w["kem"].longValue!!.toInt(), bytes(w.s("encHex")), bytes(w.s("ctHex")))
            val got = SyncHpke.unwrapRoot(pub, dhOver(priv), ctx, kid, wrap)
            f.equal(c.sOrNull("expectRootHex"), got?.let(::hex)) { c.s("id") }
            val s = c["seal"]?.takeIf { it is JsonObject }?.obj ?: continue
            f.equal(s.s("infoHex"), hex(SyncHpke.wrapInfo(ctx))) { "${c.s("id")} info" }
            f.equal(s.s("recipientPublicHex"), hex(pub)) { "${c.s("id")} public key" }
            val again = SyncHpke.wrapRoot(
                bytes(s.s("recipientPublicHex")),
                ctx,
                kid,
                bytes(s.s("rootHex")),
                SyncHpke.Ephemeral(bytes(s.s("ephemeralPrivateHex")), curves),
            )
            f.check(again == wrap) { "${c.s("id")} seal" }
        }
        f.done(list("wrapCases").size)
    }

    @Test
    fun wrapToAZeroKeyIsRefused() {
        val ctx = SyncHpke.WrapContext("demo", "d", "rg_AAAAAAAAAAAAAAAAAAAAAA", 1)
        assertTrue(refuses { SyncHpke.wrapRoot(ByteArray(32), ctx, ByteArray(16), ByteArray(32), SyncHpke.Ephemeral(curves = curves)) })
        assertTrue(refuses { SyncHpke.wrapRoot(ByteArray(31), ctx, ByteArray(16), ByteArray(32), SyncHpke.Ephemeral(curves = curves)) })
    }

    @Test
    fun recoveryCodes() {
        val f = Failures("sync recovery")
        for (c in list("recoveryCodeCases")) {
            when (c.s("kind")) {
                "code" -> {
                    f.equal(c.s("text"), SyncRecovery.encode(bytes(c.s("codeHex")))) { "${c.s("id")} encode" }
                    f.equal(c.s("codeHex"), SyncRecovery.parse(c.s("text"))?.let(::hex)) { "${c.s("id")} parse" }
                }

                "parse" -> f.equal(c.sOrNull("expectCodeHex"), SyncRecovery.parse(c.s("input"))?.let(::hex)) { c.s("id") }

                else -> {
                    val code = bytes(c.s("codeHex"))
                    val epoch = c["epoch"].longValue!!.toInt()
                    val kid = bytes(c.s("kidHex"))
                    val got = SyncRecovery.unwrap(code, SyncRecovery.RingRef(c.s("ringId"), epoch, kid), bytes(c.s("blobHex")))
                    f.equal(c.sOrNull("expectRootHex"), got?.let(::hex)) { c.s("id") }
                    val s = c["seal"]?.takeIf { it is JsonObject }?.obj ?: continue
                    val again = SyncRecovery.wrap(
                        code,
                        SyncRecovery.RingRef(c.s("ringId"), epoch, kid),
                        bytes(s.s("rootHex")),
                        bytes(s.s("nonceHex")),
                    )
                    f.equal(c.s("blobHex"), hex(again)) { "${c.s("id")} seal" }
                }
            }
        }
        f.done(list("recoveryCodeCases").size)
        assertNotNull(SyncRecovery.parse(SyncRecovery.encode(SyncRecovery.newCode())))
    }

    @Test
    fun adopts() {
        val f = Failures("sync adopt")
        for (c in list("adoptCases")) {
            val cur = bytes(c.s("currentRootHex"))
            val from = SyncRecovery.RingRef(c.s("fromRingId"), c["epoch"].longValue!!.toInt(), bytes(c.s("kidHex")))
            val got = SyncRecovery.openAdopt(cur, from, bytes(c.s("blobHex")))
            f.equal(c.sOrNull("expectRootHex"), got?.let(::hex)) { c.s("id") }
            val s = c["seal"]?.takeIf { it is JsonObject }?.obj ?: continue
            f.equal(c.s("blobHex"), hex(SyncRecovery.sealAdopt(cur, from, bytes(s.s("oldRootHex")), bytes(s.s("nonceHex"))))) { "${c.s("id")} seal" }
        }
        f.done(list("adoptCases").size)
    }
}
