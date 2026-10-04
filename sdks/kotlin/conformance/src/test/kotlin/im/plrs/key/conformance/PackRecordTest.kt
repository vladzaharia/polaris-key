// @pkey-feature packs.record
//
// conformance/corpus/v2/"cases.json"'s `packRecordCases` and `markerCases` (plans/P4-01.md §4.6),
// read in place, through the Kotlin verifiers:
//
//   packRecordCases  step 14 over every case that reaches it      → releaseRecordClaims
//   packRecordCases  steps 12–15 with `pin.kind`, every case        → verifyReleaseRecord
//   markerCases      step 14 over every marker release reaching it → releaseRecordClaims
//   markerCases      V4 §3.7, every case                           → verifyMarker

package im.plrs.key.conformance

import im.plrs.key.core.Base64Url
import im.plrs.key.core.JsonText
import im.plrs.key.core.JwsTyp
import im.plrs.key.core.JwsVerifier
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifiedJws
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.record
import im.plrs.key.core.releaseRecordClaims
import im.plrs.key.core.step
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyReleaseRecord
import im.plrs.key.packs.PackRecordDoc
import im.plrs.key.packs.VerifyMarkerResult
import im.plrs.key.packs.verifyMarker
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PackRecordTest : ConformanceSuite() {
    private val corpus: JsonObject = Corpus.v2("cases.json")
    private val records = corpus["packRecordCases"]!!.arrayValue!!.map { it.obj }
    private val markers = corpus["markerCases"]!!.arrayValue!!.map { it.obj }

    private fun trust(e: JsonElement?): TrustSet = e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    /** Step 13's key selection from the pinned release keys, then the signature: the payload the claims see. */
    private fun reachClaims(jws: String, keys: TrustSet): VerifiedJws? {
        val header = JsonText.parse(Base64Url.decode(jws.split('.')[0])!!.toString(Charsets.UTF_8)).objectValue ?: return null
        val kid = header["kid"].stringValue ?: return null
        return JwsVerifier.verify(jws, mapOf(kid to (keys[kid] ?: return null)), JwsTyp.release)
    }

    @Test
    fun counts() {
        assertEquals(170, records.size)
        assertEquals(17, markers.size)
    }

    @Test
    fun packRecordClaimsOverEveryCaseThatReachesThem() {
        val f = Failures("packRecordCases claims")
        for (c in records) {
            val expect = c["expect"]!!.obj
            val step = if (expect["verify"].stringValue == "ok") null else expect["step"].stringValue
            if (step != null && step != "claims" && step != "cross-check") continue
            val v = reachClaims(c["jws"].stringValue!!, trust(c["releaseKeys"]))
            f.check(v != null) { "${c["id"].stringValue} reaches the claims step" }
            if (v == null) continue
            f.equal(step != "claims", releaseRecordClaims(v.payload, c["expectedAud"].stringValue!!, v.nonWireIntegers)) { "${c["id"].stringValue}: ${c["description"].stringValue}" }
        }
        f.done(150)
    }

    @Test
    fun markerReleaseClaimsOverEveryCaseThatReachesThem() {
        val f = Failures("markerCases claims")
        for (c in markers) {
            val expect = c["expect"]!!.obj
            val step = if (expect["verify"].stringValue == "ok") null else expect["step"].stringValue
            if (step != null && step != "claims" && step != "cross-check") continue
            val release = JsonText.parse(c["marker"].stringValue!!).objectValue?.get("release").stringValue
            f.check(release != null) { "${c["id"].stringValue} carries a release" }
            if (release == null) continue
            val v = reachClaims(release, trust(c["releaseKeys"]))
            f.check(v != null) { "${c["id"].stringValue} reaches the claims step" }
            if (v == null) continue
            f.equal(step != "claims", releaseRecordClaims(v.payload, c["expectedAud"].stringValue!!, v.nonWireIntegers)) { "marker ${c["id"].stringValue}: ${c["description"].stringValue}" }
        }
        f.done(1)
    }

    @Test
    fun everyPackRecordCase() {
        val f = Failures("packRecordCases")
        for (c in records) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val pin = c["pin"].objectValue?.let {
                ReleaseRecordPin(it["kind"].stringValue ?: "app", it["deliverable"].stringValue!!, it["version"].stringValue!!, it["seq"].longValue!!)
            }
            val r = verifyReleaseRecord(
                c["jws"].stringValue!!,
                VerifyReleaseRecordOptions(trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!, c["expectedHash"].stringValue!!, pin),
            )
            if (expect["verify"].stringValue == "ok") {
                val record = r.record
                f.check(record != null) { "$id → ok, got ${r.step}: ${c["description"].stringValue}" }
                if (record == null) continue
                f.equal(expect["kind"].stringValue, record.kind) { "$id kind" }
                expect["doc"].objectValue?.let { doc -> f.check(jsonEquals(doc, record.json)) { "$id doc" } }
                if (record.kind == "pack") f.check(PackRecordDoc.from(record.json) != null) { "$id typed pack record" }
            } else {
                f.equal(expect["step"].stringValue, r.step?.wire) { "$id: ${c["description"].stringValue}" }
            }
        }
        f.done(170)
    }

    @Test
    fun everyMarkerCase() {
        val f = Failures("markerCases")
        for (c in markers) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            when (val r = verifyMarker(c["marker"].stringValue!!, trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!)) {
                is VerifyMarkerResult.Ok -> {
                    f.equal("ok", expect["verify"].stringValue) { "marker $id: ${c["description"].stringValue}" }
                    f.equal(expect["packId"].stringValue, r.packId) { "marker $id packId" }
                    f.equal(expect["version"].stringValue, r.version) { "marker $id version" }
                    f.equal(expect["recordSha256"].stringValue, r.recordSha256) { "marker $id recordSha256" }
                    f.equal(r.packId, r.record.deliverable) { "marker $id deliverable" }
                }
                is VerifyMarkerResult.Rejected -> {
                    f.equal("fail", expect["verify"].stringValue) { "marker $id: ${c["description"].stringValue}" }
                    f.equal(expect["step"].stringValue, r.step) { "marker $id step" }
                }
            }
        }
        f.done(17)
    }
}
