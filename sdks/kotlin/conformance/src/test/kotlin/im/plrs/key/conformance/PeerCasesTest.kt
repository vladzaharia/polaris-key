// @pkey-feature connect.identity
//
// Cloud Connect's device certificate and roster (WIRE-CONTRACT-V5 section 15.2, 15.3), driven off
// conformance/corpus/v2's "cases.json" families `peerCertCases`, `ringCases` (verify and replace,
// the `ring-lifetime-*` and `ring-valid-span-*` rows included) and `peerAdmissionCases`, read in
// place, through :core's `Peer` verifiers. The Gradle `test` task runs them on the JCA Ed25519
// backend and `testTink` on Tink; a verdict that differs fails one of them.

package im.plrs.key.conformance

import im.plrs.key.core.Peer
import im.plrs.key.core.PeerAdmission
import im.plrs.key.core.PeerCertResult
import im.plrs.key.core.PeerSession
import im.plrs.key.core.RingReplacement
import im.plrs.key.core.RingResult
import im.plrs.key.core.TrustSet
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerCasesTest : ConformanceSuite() {
    private val corpus: JsonObject = Corpus.v2("cases.json")

    private fun cases(name: String): List<JsonObject> = corpus[name]!!.arrayValue!!.map { it.obj }

    private fun trust(c: JsonObject): TrustSet = c["trust"].objectValue!!.mapValues { it.value.stringValue!! }

    private fun session(e: JsonElement?): PeerSession? = e.objectValue?.let {
        PeerSession(it["mode"].stringValue!!, it["remoteStatic"].stringValue!!, it["ownSub"].stringValue, it["ownDeviceId"].stringValue)
    }

    @Test
    fun everyPeerCertCase() {
        val all = cases("peerCertCases")
        assertEquals(113, all.size)
        val f = Failures("peerCertCases")
        for (c in all) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val r = Peer.verifyCert(c["jws"].stringValue!!, trust(c), c["expectedAud"].stringValue!!, c["now"].longValue!!, session(c["session"]))
            if (expect["valid"].boolValue == true) {
                val cert = (r as? PeerCertResult.Ok)?.cert
                f.check(cert != null) { "$id → valid, got ${(r as? PeerCertResult.Refused)?.reason?.wire}: ${c["description"].stringValue}" }
                if (cert == null) continue
                val want = expect["cert"]!!.obj
                f.equal(want["sub"].stringValue, cert.sub) { "$id sub" }
                f.equal(want["deviceId"].stringValue, cert.deviceId) { "$id deviceId" }
                f.equal(want["signKey"].stringValue, cert.signKey) { "$id signKey" }
                f.equal(want["agreeKey"].stringValue, cert.agreeKey) { "$id agreeKey" }
                f.equal(want["ringEpoch"].longValue, cert.ringEpoch) { "$id ringEpoch" }
                f.equal(want["issuedAt"].longValue, cert.issuedAt) { "$id issuedAt" }
                f.equal(want["expiresAt"].longValue, cert.expiresAt) { "$id expiresAt" }
            } else {
                f.equal(expect["reason"].stringValue, (r as? PeerCertResult.Refused)?.reason?.wire) { "$id reason: ${c["description"].stringValue}" }
            }
        }
        f.done(113)
    }

    @Test
    fun everyRingCase() {
        val all = cases("ringCases")
        assertEquals(76, all.size)
        val f = Failures("ringCases")
        for (c in all) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val aud = c["expectedAud"].stringValue!!
            val now = c["now"].longValue!!
            if (c["kind"].stringValue == "verify") {
                val r = Peer.verifyRing(c["jws"].stringValue!!, trust(c), aud)
                if (expect["valid"].boolValue == true) {
                    val ring = (r as? RingResult.Ok)?.ring
                    f.check(ring != null) { "$id → valid, got ${(r as? RingResult.Refused)?.reason?.wire}: ${c["description"].stringValue}" }
                    if (ring == null) continue
                    f.equal(expect["epoch"].longValue, ring.epoch) { "$id epoch" }
                    f.equal(expect["devices"].longValue, ring.devices.size.toLong()) { "$id devices" }
                    f.equal(expect["expired"].boolValue, Peer.ringExpired(ring, now)) { "$id expired" }
                } else {
                    f.equal(expect["reason"].stringValue, (r as? RingResult.Refused)?.reason?.wire) { "$id reason: ${c["description"].stringValue}" }
                }
            } else {
                val r = Peer.replaceRing(c["heldJws"].stringValue, c["jws"].stringValue!!, trust(c), aud, now)
                f.equal(expect["replace"].boolValue, r is RingReplacement.Replace) { "$id replace: ${c["description"].stringValue}" }
                if (r is RingReplacement.Keep) f.equal(expect["reason"].stringValue, r.reason.wire) { "$id reason" }
            }
        }
        f.done(76)
    }

    @Test
    fun ringLifetimeRowsArePresent() {
        val ids = cases("ringCases").map { it["id"].stringValue!! }
        assertTrue(ids.any { it.startsWith("ring-lifetime-") })
        assertTrue(ids.any { it.startsWith("ring-valid-span-") })
    }

    @Test
    fun everyPeerAdmissionCase() {
        val all = cases("peerAdmissionCases")
        assertEquals(17, all.size)
        val f = Failures("peerAdmissionCases")
        for (c in all) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val r = Peer.admitPeer(c["certJws"].stringValue!!, c["ringJws"].stringValue, trust(c), c["expectedAud"].stringValue!!, c["now"].longValue!!)
            f.equal(expect["admit"].boolValue, r is PeerAdmission.Admit) { "$id admit: ${c["description"].stringValue}" }
            when (r) {
                is PeerAdmission.Admit -> f.equal(expect["ringSync"].stringValue, r.ringSync.wire) { "$id ringSync" }
                is PeerAdmission.Refuse -> f.equal(expect["reason"].stringValue, r.reason) { "$id reason" }
            }
        }
        f.done(17)
    }
}
