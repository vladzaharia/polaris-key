// @pkey-feature update.content packs.revoke packs.delta.feed
//
// The Kotlin runner for P4-13's corpus sections (plans/P4-13.md §4), read in place, with the same ids
// as the Node, Python and Swift runners:
//
//   feedContentCases  §2.2's content members, every case          → verifyFeed, feedContent
//                     (plans/P4-29.md §4.2: `content.deltas` against `expect.deltas ?? null`)
//   revocationCases   §2.3's steps 12–16, superseding              → verifyRevocation,
//                                                                    verifyReleaseRecord, newerRevocation
//   contentRows       "update-matrix.json", §2.6's content decision → decideUpdate, bootDecision, packSetId
//
// Both from conformance/corpus/v2/"cases.json". The stamp cases' holds run in ContentCorpusTest.

package im.plrs.key.conformance

import im.plrs.key.core.BootEvent
import im.plrs.key.core.FeedRevocation
import im.plrs.key.core.NonWireIntegers
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.TrustSet
import im.plrs.key.core.UpdateBlockedReason
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.VerifyFeedOptions
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyRevocationOptions
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.bootDecision
import im.plrs.key.core.contentBlock
import im.plrs.key.core.decideUpdate
import im.plrs.key.core.feed
import im.plrs.key.core.feedContent
import im.plrs.key.core.json
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.newerRevocation
import im.plrs.key.core.objectValue
import im.plrs.key.core.record
import im.plrs.key.core.refusal
import im.plrs.key.core.revocation
import im.plrs.key.core.revocationOf
import im.plrs.key.core.step
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyFeed
import im.plrs.key.core.verifyReleaseRecord
import im.plrs.key.core.verifyRevocation
import im.plrs.key.core.withFeedContent
import im.plrs.key.packs.PackSetEntry
import im.plrs.key.packs.packSetId
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ContentDecisionTest : ConformanceSuite() {
    private val cases: JsonObject = Corpus.v2("cases.json")

    private fun trust(v: JsonElement?): TrustSet = v.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    private fun entry(v: JsonElement?): FeedRevocation {
        val e = v!!.obj
        return FeedRevocation(e["record"].stringValue!!, e["pack"].stringValue!!, e["target"].stringValue!!, e["version"].stringValue!!, e["seq"].longValue!!, e["kind"].stringValue)
    }

    private fun feedOptions(c: JsonObject) = VerifyFeedOptions(
        trust(c["trust"]), c["expectedAud"].stringValue!!, c["channel"].stringValue!!, c["platform"].stringValue, c["now"].longValue, c["checkFreshness"].boolValue ?: true,
    )

    // ── feedContentCases ────────────────────────────────────────────────────────────────────

    @Test
    fun everyFeedContentCase() {
        val list = cases["feedContentCases"]!!.arrayValue!!.map { it.obj }
        assertEquals(76, list.size)
        val f = Failures("feedContentCases")
        for (c in list) {
            val id = c["id"].stringValue
            val r = verifyFeed(c["jws"].stringValue!!, feedOptions(c))
            val feed = r.feed
            f.check(feed != null) { "$id → ok, got ${r.refusal}" }
            if (feed == null) continue
            val expect = c["expect"]!!.obj
            f.check(jsonEquals(expect["content"], feed.content.json)) { "$id: ${c["description"].stringValue}: got ${feed.content.json}" }
            f.check(jsonEquals(expect["deltas"] ?: JsonNull, feed.content.deltasJson)) { "$id deltas: got ${feed.content.deltasJson}" }
            f.equal(feed.content, feedContent(feed.json, feed.nonWireIntegers)) { "$id reparse" }
            // withFeedContent keeps exactly the parsed members.
            f.equal(feed.content, feedContent(withFeedContent(feed, feed.content).json)) { "$id round trip" }
        }
        f.done(76)
    }

    // ── revocationCases ─────────────────────────────────────────────────────────────────────

    @Test
    fun everyRevocationCase() {
        val list = cases["revocationCases"]!!.arrayValue!!.map { it.obj }
        assertEquals(27, list.size)
        val byId = list.associateBy { it["id"].stringValue!! }
        fun verify(c: JsonObject) = verifyRevocation(
            c["jws"].stringValue!!, VerifyRevocationOptions(trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!, entry(c["entry"])),
        )
        val f = Failures("revocationCases")
        for (c in list) {
            val id = c["id"].stringValue
            val expect = c["expect"]!!.obj
            val ok = expect["verify"].stringValue == "ok"
            if (c["mode"].stringValue == "replacement") {
                val pin = c["pin"]!!.obj
                val r = verifyReleaseRecord(
                    c["jws"].stringValue!!,
                    VerifyReleaseRecordOptions(
                        trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!, c["expectedHash"].stringValue!!,
                        ReleaseRecordPin(pin["kind"].stringValue ?: "app", pin["deliverable"].stringValue!!, pin["version"].stringValue!!, pin["seq"].longValue!!),
                    ),
                )
                if (ok) f.equal(expect["kind"].stringValue, r.record?.kind) { "$id kind" } else f.equal(expect["step"].stringValue, (r as? im.plrs.key.core.VerifyReleaseRecordResult.Refused)?.step?.wire) { "$id step" }
                continue
            }
            val r = verify(c)
            if (!ok) {
                f.equal(expect["step"].stringValue, r.step?.wire) { "$id: ${c["description"].stringValue}" }
                continue
            }
            val rev = r.revocation
            f.check(rev != null) { "$id → ok, got ${r.step}" }
            if (rev == null) continue
            f.check(jsonEquals(expect["revocation"], rev.body.json)) { "$id revocation: got ${rev.body.json}" }
            val supersedes = expect["supersedes"].stringValue ?: continue
            val other = verify(byId.getValue(supersedes)).revocation!!
            val win = newerRevocation(rev, other)
            f.equal(win, newerRevocation(other, rev)) { "$id symmetric" }
            f.equal(entry(byId.getValue(expect["winner"].stringValue!!)["entry"]).record, win.record) { "$id winner" }
        }
        f.done(27)
    }

    /** `revocationOf` reads the body alone; the token rule applies at `/replacement/seq`. */
    @Test
    fun revocationOfTokenRule() {
        val doc = buildJsonObject {
            put("kind", JsonPrimitive("revocation"))
            put("deliverable", JsonPrimitive("djdl.levels"))
            put("revokes", JsonPrimitive("a".repeat(64)))
            put("issuedAt", im.plrs.key.core.jsonInt(1))
            put("replacement", buildJsonObject {
                put("sha256", JsonPrimitive("b".repeat(64)))
                put("seq", im.plrs.key.core.jsonInt(1))
                put("version", JsonPrimitive("1.0.0"))
            })
            put("reason", JsonPrimitive("r"))
        }
        assertNotNull(revocationOf(doc))
        assertNull(revocationOf(doc, NonWireIntegers.of("/replacement/seq")))
    }

    // ── contentRows ─────────────────────────────────────────────────────────────────────────

    private val contentRows: List<JsonObject> by lazy { Corpus.v2("update-matrix.json")["contentRows"]!!.arrayValue!!.map { it.obj } }

    @Test
    fun everyContentRow() {
        assertEquals(44, contentRows.size)
        val f = Failures("contentRows")
        for (row in contentRows) {
            val name = row["name"].stringValue
            val expect = row["expect"]!!.obj
            val input = decisionInput(row["input"]!!)
            f.check(input.content != null) { "$name has content" }
            val decision = decideUpdate(input)
            f.check(jsonEquals(expect["decision"], decision.json)) { "content row $name: expected ${expect["decision"]}, got ${decision.json}" }
            f.equal(expect["boot"].stringValue, bootDecision(decision).wire) { "content row $name boot" }
            val want = expect["packSetId"].stringValue ?: continue
            val packs = decision as? UpdateDecision.Packs
            f.check(packs != null) { "content row $name: expected packs" }
            if (packs != null) f.equal(want, packSetId(packs.set.map { PackSetEntry(it.pack, it.sha256) })) { "content row $name packSetId" }
        }
        f.done(44)
    }

    /** Decision 4: `required` exactly on the rows whose decision is `revoked-content`. */
    @Test
    fun requiredExactlyOnRevokedContentRows() {
        for (row in contentRows) {
            val d = row["expect"]!!.obj["decision"]!!.obj
            val revoked = d["reason"].stringValue == UpdateBlockedReason.revokedContent || d["contentBlock"].stringValue == UpdateBlockedReason.revokedContent
            assertEquals(row["name"].stringValue, revoked, row["expect"]!!.obj["boot"].stringValue == BootEvent.Decision.required.wire)
        }
    }

    /** Without `content` every content row is P3-01's answer. */
    @Test
    fun noContentIsP301() {
        for (row in contentRows) {
            val d = decideUpdate(decisionInput(row["input"]!!).copy(content = null))
            assertNull(d.contentBlock)
            assertEquals(false, d is UpdateDecision.Packs)
            assertNotEquals(BootEvent.Decision.required, bootDecision(d))
        }
    }
}
