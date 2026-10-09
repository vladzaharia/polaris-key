// @pkey-feature core.verify core.bundle
//
// The Kotlin runner for conformance/corpus/v2/cases.json, read in place: the families :core owns,
// with the Node runner's assertions (conformance/runners/node/suites.ts), vector for vector.
//
//   jwsCases         §1–§2 raw compact-JWS verification     → JwsVerifier.verify
//   licenseDocCases  §3 claim validation, licence           → verifyLicenseDoc
//   configDocCases   §3 claim validation, config            → verifyConfigDoc
//   trustCases       §1 trust merge / prune / revocation    → verifyTrustManifest + mergeTrust
//   clockFloorCases  §4.2 the floor over three artifacts    → the reload path + licenseState
//   bundleCases      §7 offline bundle import               → inspectBundle (the refusing step)
//   pointer sets     V4 §4.1 nonWireIntegers, the five families above
//
// The remaining families are the later slices' (feedCases, feedContentCases, releaseRecordCases,
// revocationCases, packRecordCases, markerCases, delegationCases: P6-07 and P6-08), which add
// their suites to this module.

package im.plrs.key.conformance

import im.plrs.key.core.BundleInspection
import im.plrs.key.core.BundleFloors
import im.plrs.key.core.BundleOptions
import im.plrs.key.core.BundleProfile
import im.plrs.key.core.GateInput
import im.plrs.key.core.JwsTyp
import im.plrs.key.core.JwsVerifier
import im.plrs.key.core.MAX_BUNDLE_BYTES
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyOptions
import im.plrs.key.core.VerifyTrustManifestOptions
import im.plrs.key.core.ActivationSource
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.effectiveNow
import im.plrs.key.core.highWaterMark
import im.plrs.key.core.inspectBundle
import im.plrs.key.core.loadPinRevocations
import im.plrs.key.core.usablePins
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.licenseState
import im.plrs.key.core.longValue
import im.plrs.key.core.mergeTrust
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyBundle
import im.plrs.key.core.verifyConfigDoc
import im.plrs.key.core.verifyLicenseDoc
import im.plrs.key.core.verifyTrustManifest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class CorpusV2Test : ConformanceSuite() {
    companion object {
        private lateinit var corpus: JsonObject

        @BeforeClass
        @JvmStatic
        fun load() {
            corpus = Corpus.v2("cases.json")
        }

        private fun trust(e: JsonElement?): TrustSet =
            e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

        private fun cases(family: String): List<JsonObject> = corpus[family]!!.arrayValue!!.map { it.obj }

        private fun docOptions(c: JsonObject) = VerifyOptions(
            trust = trust(c["trust"]),
            expectedAud = c["expectedAud"].stringValue!!,
            expectedIss = c["expectedIss"].stringValue!!,
            deviceId = c["deviceId"].stringValue!!,
            now = c["now"].longValue!!,
            lastAcceptedIssuedAt = c["lastAcceptedIssuedAt"].longValue,
            checkFreshness = c["checkFreshness"].boolValue ?: true,
        )
    }

    @Test
    fun hasVectorsInEverySection() {
        assertEquals(2L, corpus["corpusVersion"].longValue)
        for (family in listOf("jwsCases", "licenseDocCases", "configDocCases", "trustCases", "clockFloorCases", "bundleCases")) {
            assertTrue(family, cases(family).isNotEmpty())
        }
    }

    @Test
    fun jwsCases() {
        val f = Failures("jwsCases")
        for (c in cases("jwsCases")) {
            val id = c["id"].stringValue!!
            val expect = c["expect"]!!.obj
            val result = JwsVerifier.verify(
                c["jws"].stringValue!!, trust(c["trust"]), JwsTyp.of(c["typ"].stringValue),
                maxPayloadBytes = c["maxPayloadBytes"].longValue?.toInt(),
            )
            if (expect["verify"].stringValue == "ok") {
                f.check(result != null) { "$id should verify" }
                if (result != null) {
                    f.equal(expect["kid"].stringValue, result.kid) { "$id kid" }
                    expect["doc"]?.let { doc -> f.check(jsonEquals(doc, result.payload)) { "$id payload ${result.payload} != $doc" } }
                }
            } else {
                f.check(result == null) { "$id must fail verification" }
            }
        }
        f.done(85)
    }

    @Test
    fun licenseDocCases() {
        val f = Failures("licenseDocCases")
        for (c in cases("licenseDocCases")) {
            val accept = verifyLicenseDoc(c["jws"].stringValue!!, docOptions(c)) != null
            f.equal(c["expect"]!!.obj["accept"].boolValue, accept) { "${c["id"].stringValue} — ${c["description"].stringValue}" }
        }
        f.done(25)
    }

    @Test
    fun configDocCases() {
        val f = Failures("configDocCases")
        for (c in cases("configDocCases")) {
            val accept = verifyConfigDoc(c["jws"].stringValue!!, docOptions(c)) != null
            f.equal(c["expect"]!!.obj["accept"].boolValue, accept) { "${c["id"].stringValue} — ${c["description"].stringValue}" }
        }
        f.done(21)
    }

    @Test
    fun trustCases() {
        val f = Failures("trustCases")
        for (c in cases("trustCases")) {
            val id = c["id"].stringValue!!
            val pinned = trust(c["pinned"])
            // V4 §4.1: the evidence held before the manifest re-derives the tombstones first.
            val held = loadPinRevocations(trust(c["pinRevocations"]), pinned, "djdl")
            val result = verifyTrustManifest(
                c["manifestJws"].stringValue!!,
                VerifyTrustManifestOptions(
                    pinned = pinned, tombstones = held.tombstones, expectedAud = "djdl", now = c["now"].longValue!!,
                    checkFreshness = c["checkFreshness"].boolValue ?: true,
                ),
            )
            val expect = c["expect"]!!.obj
            f.equal(expect["accepted"].boolValue, result.doc != null) { "$id acceptance" }
            val tombstones = (held.tombstones + result.revokedPins).distinct().sortedWith(compareBy { it.toByteArray(Charsets.UTF_8).joinToString("") { b -> "%02x".format(b) } })
            // Accepted ⇒ the discovered set REPLACES what was held; rejected ⇒ untouched.
            val discovered = if (result.doc != null) result.discovered else trust(c["before"])
            f.equal(trust(expect["trust"]), mergeTrust(usablePins(pinned, tombstones), discovered)) { "$id trust" }
            f.equal(expect["revokedPins"]?.arrayValue?.map { it.stringValue!! } ?: emptyList<String>(), tombstones) { "$id revokedPins" }
            expect["issuedAt"].longValue?.let { f.equal(it, result.doc?.issuedAt) { "$id issuedAt" } }
        }
        f.done(30)
    }

    /** §4.2: the cache-RELOAD path as pure data, then the gate at max(systemClock, floor). */
    @Test
    fun clockFloorCases() {
        val f = Failures("clockFloorCases")
        for (c in cases("clockFloorCases")) {
            val id = c["id"].stringValue!!
            val pinned = trust(c["pinned"])
            val aud = c["expectedAud"].stringValue!!
            val deviceId = c["deviceId"].stringValue!!
            val system = c["systemClock"].longValue!!
            var trust = pinned
            val verified = ArrayList<Long>()
            c["trustJws"].stringValue?.let { jws ->
                val m = verifyTrustManifest(jws, VerifyTrustManifestOptions(pinned, expectedAud = aud, now = system, checkFreshness = false))
                if (m.doc != null) {
                    trust = mergeTrust(pinned, m.discovered)
                    verified += m.doc!!.issuedAt
                }
            }
            val reload = VerifyOptions(trust, aud, deviceId, lastAcceptedIssuedAt = null, now = system, checkFreshness = false)
            val license = c["licenseJws"].stringValue?.let { verifyLicenseDoc(it, reload) }
            license?.let { verified += it.issuedAt }
            c["configJws"].stringValue?.let { verifyConfigDoc(it, reload) }?.let { verified += it.issuedAt }
            val floor = highWaterMark(verified)
            val expect = c["expect"]!!.obj
            f.equal(expect["highWaterMark"].longValue, floor) { "$id highWaterMark" }
            f.equal(expect["effectiveNow"].longValue, effectiveNow(system, floor)) { "$id effectiveNow" }
            val state = licenseState(
                GateInput(licenseServiceEnabled = true, activation = ActivationSource.token, doc = license, now = system, highWaterMark = floor),
            )
            f.equal(expect["status"].stringValue, state.status.wire) { "$id — ${c["description"].stringValue}" }
        }
        f.done(7)
    }

    @Test
    fun bundleCases() {
        val f = Failures("bundleCases")
        for (c in cases("bundleCases")) {
            val id = c["id"].stringValue!!
            // The cap is the implementation's own constant, never the caller's.
            f.equal(MAX_BUNDLE_BYTES.toLong(), c["maxPayloadBytes"].longValue) { "$id cap" }
            val pinned = trust(c["pinned"])
            val held = loadPinRevocations(trust(c["pinRevocations"]), pinned, c["expectedAud"].stringValue!!)
            val floors = c["floors"].objectValue
            val options = BundleOptions(
                pinned = pinned, product = c["expectedAud"].stringValue!!,
                deviceId = c["deviceId"].stringValue!!, now = c["now"].longValue!!,
                floors = BundleFloors(floors?.get("license").longValue, floors?.get("config").longValue),
                profile = if (c["profile"].stringValue == "reload") BundleProfile.reload else BundleProfile.import,
                tombstones = held.tombstones,
            )
            val expect = c["expect"]!!.obj
            when (val outcome = inspectBundle(c["bundleJws"].stringValue!!, options)) {
                is BundleInspection.Ok -> {
                    f.equal(true, expect["imports"].boolValue) { "$id imports" }
                    val docs = expect["docs"]?.arrayValue?.map { it.stringValue }
                    f.equal(docs, outcome.bundle.importedSlices.map { it.wire }) { "$id docs" }
                    // The two entry points never disagree.
                    f.equal(outcome.bundle, verifyBundle(c["bundleJws"].stringValue!!, options)) { "$id verifyBundle" }
                }
                is BundleInspection.Refused -> {
                    f.equal(false, expect["imports"].boolValue) { "$id imports" }
                    f.equal(expect["reason"].stringValue, outcome.reason.code) { "$id reason" }
                }
            }
        }
        f.done(23)
    }

    @Test
    fun bundleValidFullYieldsTheArtifactsTheCacheWriteNeeds() {
        val c = cases("bundleCases").first { it["id"].stringValue == "bundle-valid-full" }
        val pinned = trust(c["pinned"])
        val bundle = verifyBundle(
            c["bundleJws"].stringValue!!,
            BundleOptions(pinned, c["expectedAud"].stringValue!!, c["deviceId"].stringValue!!, c["now"].longValue!!, BundleFloors.NONE, BundleProfile.import),
        )
        assertNotNull(bundle)
        bundle!!
        assertTrue(bundle.bundleId.isNotEmpty())
        assertEquals(3, bundle.trustJws.split('.').size)
        assertTrue(bundle.effectiveTrust.size > pinned.size)
        assertEquals(c["deviceId"].stringValue, bundle.license!!.doc.deviceId)
        assertEquals(c["expectedAud"].stringValue, bundle.license!!.doc.aud)
        assertEquals(c["deviceId"].stringValue, bundle.config!!.doc.deviceId)
    }

    /** V4 §4.1: whenever a family's JWS verifies, its pointer set equals the case's member. */
    @Test
    fun nonWireIntegerPointerSets() {
        val f = Failures("nonWireIntegers")
        data class Spec(val jws: String, val keys: TrustSet, val typ: JwsTyp?, val cap: Int?)
        val families: List<Pair<String, (JsonObject) -> Spec>> = listOf(
            "jwsCases" to { c -> Spec(c["jws"].stringValue!!, trust(c["trust"]), JwsTyp.of(c["typ"].stringValue), c["maxPayloadBytes"].longValue?.toInt()) },
            "licenseDocCases" to { c -> Spec(c["jws"].stringValue!!, trust(c["trust"]), JwsTyp.of(c["typ"].stringValue), null) },
            "configDocCases" to { c -> Spec(c["jws"].stringValue!!, trust(c["trust"]), JwsTyp.of(c["typ"].stringValue), null) },
            "trustCases" to { c -> Spec(c["manifestJws"].stringValue!!, trust(c["pinned"]), JwsTyp.trust, null) },
            "bundleCases" to { c -> Spec(c["bundleJws"].stringValue!!, trust(c["pinned"]), JwsTyp.bundle, MAX_BUNDLE_BYTES) },
        )
        for ((family, spec) in families) {
            for (c in cases(family)) {
                val s = spec(c)
                val result = JwsVerifier.verify(s.jws, s.keys, s.typ, maxPayloadBytes = s.cap)
                val expected = c["nonWireIntegers"]?.arrayValue?.map { it.stringValue!! }?.toSet()
                if (expected != null) f.check(result != null) { "$family ${c["id"].stringValue}: carries nonWireIntegers but did not verify" }
                if (result != null) {
                    f.equal(expected ?: emptySet<String>(), result.nonWireIntegers.pointers) { "$family ${c["id"].stringValue} pointers" }
                }
            }
        }
        f.done(100)
    }
}
