// @pkey-feature update.feed
//
// The channel feed (WIRE-CONTRACT-V4 §2.3, client steps 3–8), driven off conformance/corpus/v2's
// "cases.json" family `feedCases`, read in place, through :core's `verifyFeed` and `feedClaims`
// (what the update client's `decide()` and `channelFeed()` run), with the Swift and Node runners'
// assertions: the refusing step, the accepted `seq` and `issuedAt`, the decoded document, and the
// typed view equal to the payload.

package im.plrs.key.conformance

import im.plrs.key.core.ChannelFeedDoc
import im.plrs.key.core.FeedFloor
import im.plrs.key.core.JwsTyp
import im.plrs.key.core.JwsVerifier
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyFeedOptions
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.feed
import im.plrs.key.core.feedClaims
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.refusal
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyFeed
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class FeedCasesTest : ConformanceSuite() {
    private val cases: List<JsonObject> = Corpus.v2("cases.json")["feedCases"]!!.arrayValue!!.map { it.obj }

    private fun trust(e: JsonElement?): TrustSet = e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    /** Steps 3–8 through `verifyFeed`, every case, with the same ids as the other runners. */
    @Test
    fun everyFeedCase() {
        assertEquals(80, cases.size)
        val f = Failures("feedCases")
        for (c in cases) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val floors = c["floors"].objectValue?.mapValues { (_, v) -> FeedFloor(v.obj["seq"].longValue!!, v.obj["issuedAt"].longValue!!) } ?: emptyMap()
            val r = verifyFeed(
                c["jws"].stringValue!!,
                VerifyFeedOptions(
                    trust(c["trust"]), c["expectedAud"].stringValue!!, c["channel"].stringValue!!, c["platform"].stringValue,
                    c["now"].longValue, c["checkFreshness"].boolValue ?: true, floors,
                ),
            )
            if (expect["verify"].stringValue == "ok") {
                val feed = r.feed
                f.check(feed != null) { "$id → ok, got ${r.refusal}: ${c["description"].stringValue}" }
                if (feed == null) continue
                f.equal(expect["seq"].longValue, feed.seq) { "$id seq" }
                f.equal(expect["issuedAt"].longValue, feed.issuedAt) { "$id issuedAt" }
                expect["doc"].objectValue?.let { doc ->
                    f.check(jsonEquals(doc, feed.json)) { "$id doc" }
                    f.equal(ChannelFeedDoc.from(doc), feed) { "$id typed doc" }
                }
            } else {
                f.equal(expect["reason"].stringValue, r.refusal?.wire) { "$id reason: ${c["description"].stringValue}" }
            }
        }
        f.done(80)
    }

    /** Steps 4–6 alone, over every case that reaches them. */
    @Test
    fun feedClaimsOverEveryCaseThatReachesThem() {
        val f = Failures("feedCases claims")
        val claimReasons = setOf("claims", "channel", "selector")
        val reachable = claimReasons + setOf("freshness", "not-newer", "rollback")
        for (c in cases) {
            val expect = c["expect"]!!.obj
            val reason = if (expect["verify"].stringValue == "ok") null else expect["reason"].stringValue
            if (reason != null && reason !in reachable) continue
            val v = JwsVerifier.verify(c["jws"].stringValue!!, trust(c["trust"]), JwsTyp.feed)
            f.check(v != null) { "${c["id"].stringValue} reaches the claims step" }
            if (v == null) continue
            val got = feedClaims(v.payload, c["expectedAud"].stringValue!!, c["channel"].stringValue!!, c["platform"].stringValue, v.nonWireIntegers)
            f.equal(reason?.takeIf { it in claimReasons }, got?.wire) { "${c["id"].stringValue}: ${c["description"].stringValue}" }
        }
        f.done(50)
    }
}
