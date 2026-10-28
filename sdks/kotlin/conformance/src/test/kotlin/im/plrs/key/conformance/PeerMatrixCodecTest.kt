// @pkey-feature connect.protocol
//
// The `adverts`, `sas` and `handshakePayloads` rows of conformance/corpus/v2/peer-matrix.json
// (WIRE-CONTRACT-V5 sections 15.4 and 15.5), read in place and driven through :core's codecs. It
// mirrors conformance/runners/node/peerMatrix.test.ts. The Gradle `test` task runs it on the JCA
// backend and `testTink` on Tink.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.AccountPayload
import im.plrs.key.core.peer.MAX_HANDSHAKE_PAYLOAD
import im.plrs.key.core.peer.PayloadVerdict
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.SasMember
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.accountInstance
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.base32Lower
import im.plrs.key.core.peer.browseAccountInstance
import im.plrs.key.core.peer.capsIntersection
import im.plrs.key.core.peer.decodeSasValue
import im.plrs.key.core.peer.deviceIdBytes
import im.plrs.key.core.peer.encodeSasValue
import im.plrs.key.core.peer.isInstanceName
import im.plrs.key.core.peer.parseHandshakePayload
import im.plrs.key.core.peer.parseSasBody
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.payload1
import im.plrs.key.core.peer.payload23
import im.plrs.key.core.peer.productTag
import im.plrs.key.core.peer.sasBody
import im.plrs.key.core.peer.sasCommit
import im.plrs.key.core.peer.sasDisplay
import im.plrs.key.core.peer.sasRevealOk
import im.plrs.key.core.peer.sasValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PeerMatrixCodecTest : ConformanceSuite() {
    private val m: JsonObject = Corpus.v2("peer-matrix.json")

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.o(name: String): JsonObject = this[name]!!.obj

    private fun JsonObject.strings(name: String): List<String> = this[name]!!.arrayValue!!.map { it.stringValue!! }

    @Test
    fun rowCounts() {
        val a = m.o("adverts")
        val adverts = listOf("epochs", "names", "tags", "txt", "instances", "browse").sumOf { rows(a[it]).size }
        assertEquals(70, adverts)
        val s = m.o("sas")
        assertEquals(31, listOf("commits", "codes", "reveals", "nonces").sumOf { rows(s[it]).size })
        val h = m.o("handshakePayloads")
        assertEquals(65, rows(h["payloads"]).size + rows(h["intersection"]).size)
    }

    @Test
    fun epochsNamesAndTags() {
        val a = m.o("adverts")
        val f = Failures("peer-matrix adverts names")
        f.equal(900L, a["epochSeconds"].longValue) { "epochSeconds" }
        for (r in rows(a["epochs"])) f.equal(r["epoch"].longValue, advertEpoch(r["now"].longValue!!)) { "epoch ${r["now"]}" }
        for (r in rows(a["names"])) {
            f.equal(r.s("instance"), accountInstance(unhex(r.s("kDisc")), r["epoch"].longValue!!, r.s("deviceId"))) { r.s("id") }
        }
        for (r in rows(a["tags"])) f.equal(r.s("h"), productTag(r.s("slug"), r["epoch"].longValue!!)) { "tag ${r.s("slug")} ${r["epoch"]}" }
        f.done(20)
    }

    @Test
    fun txtAndInstanceShapes() {
        val a = m.o("adverts")
        val f = Failures("peer-matrix adverts txt")
        for (r in rows(a["txt"])) {
            val want = r.o("want")
            val got = parseTxt(r.strings("entries"))
            if (want["ok"].boolValue == true) {
                val ok = got as? TxtResult.Ok
                f.check(ok != null) { "${r.s("id")}: expected ok, got $got" }
                if (ok != null) {
                    f.equal(want.s("mode"), ok.mode.wire) { "${r.s("id")} mode" }
                    f.equal(want["h"].stringValue, ok.h) { "${r.s("id")} h" }
                }
            } else {
                val refused = got as? TxtResult.Refused
                f.check(refused != null) { "${r.s("id")}: expected a refusal, got $got" }
                if (refused != null) f.equal(want.s("reason"), refused.reason.name) { "${r.s("id")} reason" }
            }
        }
        for (r in rows(a["instances"])) f.equal(r["want"].boolValue, isInstanceName(r.s("name"))) { "instance ${r.s("name")}" }
        f.done(20)
    }

    @Test
    fun browse() {
        val f = Failures("peer-matrix adverts browse")
        for (r in rows(m.o("adverts")["browse"])) {
            val hit = browseAccountInstance(r.s("instance"), r.strings("kDiscs").map(::unhex), r["now"].longValue!!, r.strings("roster"))
            val want = r["want"] as? JsonObject
            if (want == null) {
                f.check(hit == null) { "${r.s("id")}: expected no hit, got $hit" }
            } else {
                f.check(hit != null) { "${r.s("id")}: expected a hit" }
                if (hit != null) {
                    f.equal(want.s("deviceId"), hit.deviceId) { "${r.s("id")} device" }
                    f.equal(want["epochBack"].longValue, hit.epochBack.toLong()) { "${r.s("id")} epochBack" }
                    f.equal(want["keyIndex"].longValue, hit.keyIndex.toLong()) { "${r.s("id")} keyIndex" }
                }
            }
        }
        f.done(5)
    }

    @Test
    fun base32DeviceIdsAndBrowseBounds() {
        assertEquals("", base32Lower(ByteArray(0)))
        assertEquals("my", base32Lower("f".toByteArray()))
        assertEquals("mzxw6ytboi", base32Lower("foobar".toByteArray()))
        assertEquals(24, deviceIdBytes("leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp").size)
        for (bad in listOf("short", "x".repeat(33), "x".repeat(31) + "+", "")) {
            try {
                deviceIdBytes(bad)
                fail("device id $bad must be refused")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
        val k = ByteArray(32) { 7 }
        val roster = (0 until 130).map { "%032d".format(it) }
        val inst = accountInstance(k, 5, roster[129])
        assertNull(browseAccountInstance(inst, listOf(k), 5 * 900L, roster)) // the 130th is never tried
        val k9 = ByteArray(32) { 9 }
        assertNull(browseAccountInstance(accountInstance(k9, 5, roster[0]), listOf(k, k, k9), 5 * 900L, roster))
    }

    @Test
    fun sasCommitsBodiesCodesRevealsAndNonces() {
        val s = m.o("sas")
        val f = Failures("peer-matrix sas")
        for (r in rows(s["commits"])) {
            val nd = unhex(r.s("nD"))
            val c = unhex(r.s("c"))
            f.equal(r.s("c"), hex(sasCommit(nd))) { "commit ${r.s("nD")}" }
            f.equal(r.s("commitBody"), String(sasBody(SasMember.c, c))) { "commit body" }
            f.equal(r.s("revealBody"), String(sasBody(SasMember.nD, nd))) { "reveal body" }
            f.equal(r.s("c"), parseSasBody(SasMember.c, r.s("commitBody").toByteArray())?.let(::hex)) { "parse commit body" }
            f.equal(r.s("nD"), parseSasBody(SasMember.nD, r.s("revealBody").toByteArray())?.let(::hex)) { "parse reveal body" }
        }
        for (r in rows(s["codes"])) {
            val code = sasValue(unhex(r.s("h")), unhex(r.s("nD")), unhex(r.s("nM")), PeerMode.valueOf(r.s("mode")))
            f.equal(r["code"].longValue, code.toLong()) { "${r.s("id")} code" }
            f.equal(r.s("display"), sasDisplay(code)) { "${r.s("id")} display" }
        }
        for (r in rows(s["reveals"])) f.equal(r["want"].boolValue, sasRevealOk(r.s("c"), r.s("nD"))) { "reveal ${r.s("id")}" }
        for (r in rows(s["nonces"])) f.equal(r["want"].stringValue, decodeSasValue(r.s("text"))?.let(::hex)) { "nonce ${r.s("id")}" }
        f.done(25)
    }

    @Test
    fun sasBodiesRefuseAnythingButTheCanonicalObject() {
        val v = encodeSasValue(ByteArray(32) { it.toByte() })
        assertEquals(32, parseSasBody(SasMember.nM, "{\"nM\":\"$v\"}".toByteArray())?.size)
        val bad = listOf(
            "{\"nD\":\"$v\"}".toByteArray(),
            " {\"nM\":\"$v\"}".toByteArray(),
            "{\"nM\":\"$v\",\"x\":1}".toByteArray(),
            byteArrayOf(0xff.toByte(), 0xfe.toByte()),
            ByteArray(0),
        )
        for (b in bad) assertNull(parseSasBody(SasMember.nM, b))
        try {
            encodeSasValue(ByteArray(5))
            fail("a short value must be refused")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    private fun payloadBytes(r: JsonObject): ByteArray {
        r["payloadHex"]?.let { return unhex(it.stringValue!!) }
        r["payloadPad"]?.let {
            val p = it.obj
            return (p.s("prefix") + p.s("fill").repeat(p["count"].longValue!!.toInt()) + p.s("suffix")).toByteArray(Charsets.UTF_8)
        }
        return r.s("payload").toByteArray(Charsets.UTF_8)
    }

    @Test
    fun handshakePayloads() {
        val f = Failures("peer-matrix handshake payloads")
        for (r in rows(m.o("handshakePayloads")["payloads"])) {
            val id = r.s("id")
            val b = payloadBytes(r)
            f.equal(r["length"].longValue, b.size.toLong()) { "$id length" }
            val v = parseHandshakePayload(PeerMode.valueOf(r.s("mode")), r["message"].longValue!!.toInt(), b)
            val want = r.o("want")
            val wantOk = want["ok"].boolValue == true
            f.equal(wantOk, v is PayloadVerdict.Accepted) { "$id verdict" }
            if (wantOk && v is PayloadVerdict.Accepted) {
                want["caps"]?.let { f.equal(it.arrayValue!!.map { c -> c.stringValue }, v.caps) { "$id caps" } }
                want["cert"]?.let {
                    f.equal(it.stringValue, v.cert) { "$id cert" }
                    f.equal(want["ring"].longValue, v.ring) { "$id ring" }
                }
            }
        }
        f.done(60)
    }

    @Test
    fun capsIntersections() {
        val f = Failures("peer-matrix caps intersection")
        for (r in rows(
            m.o("handshakePayloads")["intersection"],
        )) {
            f.equal(r.strings("want"), capsIntersection(r.strings("local"), r.strings("remote"))) {
                r.s("id")
            }
        }
        f.done(3)
    }

    @Test
    fun theBuildersRoundTrip() {
        assertEquals("{\"v\":1}", String(payload1()))
        assertTrue(parseHandshakePayload(PeerMode.a, 1, payload1()) is PayloadVerdict.Accepted)
        val caps = listOf("app/1", "ring/1")
        val b = payload23(PeerMode.a, caps, AccountPayload("e30.e30.c2ln", 3))
        assertEquals("{\"v\":1,\"cert\":\"e30.e30.c2ln\",\"ring\":3,\"caps\":[\"app/1\",\"ring/1\"]}", String(b))
        val v = parseHandshakePayload(PeerMode.a, 2, b) as PayloadVerdict.Accepted
        assertEquals(caps, v.caps)
        assertEquals(3L, v.ring)
        assertEquals("e30.e30.c2ln", v.cert)
        assertEquals("{\"v\":1,\"caps\":[\"app/1\",\"ring/1\"]}", String(payload23(PeerMode.v, caps)))
        for (bad in listOf({ payload23(PeerMode.a, caps) }, { payload23(PeerMode.v, List(2000) { "a/1" }) })) {
            try {
                bad()
                fail("must be refused")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
        assertEquals(8192, MAX_HANDSHAKE_PAYLOAD)
    }
}
