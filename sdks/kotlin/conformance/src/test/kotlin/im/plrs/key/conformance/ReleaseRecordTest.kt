// @pkey-feature release.record
//
// The release record (WIRE-CONTRACT-V4 §2.4, client steps 12–15), driven off conformance/corpus/v2's
// "cases.json" family `releaseRecordCases`, read in place, through :core's `verifyReleaseRecord`
// (what `ReleaseClient.verifyRecord` calls) and `releaseRecordClaims`, with the Swift and Node
// runners' assertions: the refusing step, the verified kind, the decoded document, and V4 §4.1's
// pointer set for every case whose JWS verifies.

package im.plrs.key.conformance

import im.plrs.key.core.Base64Url
import im.plrs.key.core.JsonText
import im.plrs.key.core.JwsTyp
import im.plrs.key.core.JwsVerifier
import im.plrs.key.core.MAX_RECORD_JWS_BYTES
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.ReleaseRecordStep
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.record
import im.plrs.key.core.recordHash
import im.plrs.key.core.releaseRecordClaims
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyReleaseRecord
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseRecordTest : ConformanceSuite() {
    private val cases: List<JsonObject> = Corpus.v2("cases.json")["releaseRecordCases"]!!.arrayValue!!.map { it.obj }

    private fun trust(e: JsonElement?): TrustSet = e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    private fun options(c: JsonObject) = VerifyReleaseRecordOptions(
        releaseKeys = trust(c["releaseKeys"]),
        productTrust = trust(c["productTrust"]),
        expectedAud = c["expectedAud"].stringValue!!,
        expectedHash = c["expectedHash"].stringValue!!,
        pin = c["pin"].objectValue?.let {
            ReleaseRecordPin(deliverable = it["deliverable"].stringValue!!, version = it["version"].stringValue!!, seq = it["seq"].longValue!!)
        },
    )

    /** Steps 12–15 through `verifyReleaseRecord`, every case. */
    @Test
    fun everyReleaseRecordCase() {
        assertEquals(49, cases.size)
        val f = Failures("releaseRecordCases")
        for (c in cases) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val r = verifyReleaseRecord(c["jws"].stringValue!!, options(c))
            if (expect["verify"].stringValue == "ok") {
                val record = r.record
                f.check(record != null) { "$id → ok, got $r" }
                if (record == null) continue
                f.equal(expect["kind"].stringValue, record.kind) { "$id kind" }
                expect["doc"].objectValue?.let { doc ->
                    f.check(jsonEquals(doc, record.json)) { "$id doc" }
                    f.equal(ReleaseRecordDoc.from(doc), record) { "$id typed doc" }
                }
            } else {
                f.equal(expect["step"].stringValue, (r as? VerifyReleaseRecordResult.Refused)?.step?.wire) { "$id step" }
            }
        }
        f.done(49)
    }

    /** Step 14 alone, over every case that reaches it: refused exactly where the case says `claims`. */
    @Test
    fun recordClaimsOverEveryCaseThatReachesThem() {
        val f = Failures("releaseRecordCases claims")
        for (c in cases) {
            val expect = c["expect"]!!.obj
            val step = if (expect["verify"].stringValue == "ok") null else expect["step"].stringValue
            if (step != null && step != "claims" && step != "cross-check") continue
            val jws = c["jws"].stringValue!!
            val header = JsonText.parse(Base64Url.decode(jws.split('.')[0])!!.toString(Charsets.UTF_8)).objectValue!!
            val kid = header["kid"].stringValue!!
            val v = JwsVerifier.verify(jws, mapOf(kid to trust(c["releaseKeys"])[kid]!!), JwsTyp.release)
            f.check(v != null) { "${c["id"].stringValue} reaches the claims step" }
            if (v == null) continue
            f.equal(step != "claims", releaseRecordClaims(v.payload, c["expectedAud"].stringValue!!, v.nonWireIntegers)) {
                "${c["id"].stringValue} claims"
            }
        }
        f.done(30)
    }

    /** V4 §4.1: whenever a case's JWS verifies against its release keys, its pointer set matches. */
    @Test
    fun nonWireIntegerPointerSets() {
        val f = Failures("releaseRecordCases nonWireIntegers")
        for (c in cases) {
            val result = JwsVerifier.verify(c["jws"].stringValue!!, trust(c["releaseKeys"]), JwsTyp.release)
            val expected = c["nonWireIntegers"]?.arrayValue?.map { it.stringValue!! }?.toSet()
            if (expected != null) f.check(result != null) { "${c["id"].stringValue}: carries nonWireIntegers but did not verify" }
            if (result != null) f.equal(expected ?: emptySet<String>(), result.nonWireIntegers.pointers) { "${c["id"].stringValue} pointers" }
        }
        f.done(30)
    }

    /** Step 12: a body of 88 845 bytes is refused at `hash` WITHOUT hashing, even when its hash is the pin. */
    @Test
    fun anOversizedBodyIsRefusedBeforeHashing() {
        val body = "a".repeat(MAX_RECORD_JWS_BYTES + 1)
        val r = verifyReleaseRecord(body, VerifyReleaseRecordOptions(emptyMap(), emptyMap(), "djdl", recordHash(body)))
        assertEquals(VerifyReleaseRecordResult.Refused(ReleaseRecordStep.hash), r)
        val nonAscii = "é." + "a".repeat(10)
        val r2 = verifyReleaseRecord(nonAscii, VerifyReleaseRecordOptions(emptyMap(), emptyMap(), "djdl", recordHash(nonAscii)))
        assertTrue(r2 is VerifyReleaseRecordResult.Refused && r2.step == ReleaseRecordStep.hash)
    }
}
