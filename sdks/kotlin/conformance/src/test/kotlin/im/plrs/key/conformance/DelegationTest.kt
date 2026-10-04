// @pkey-feature packs.delegation
//
// The Kotlin runner for P4-19's corpus sections (plans/P4-19.md §4.2, §4.3), read in place, with the
// same ids as the Node, Python and Swift runners:
//
//   delegationCases  §2.3's delegated steps 12–16, recordRevoked,   → verifyReleaseRecord, verifyRevocation,
//                    delegation revocations, the feed entry `kind`     recordRevoked, verifyFeed
//                    (conformance/corpus/v2/"cases.json")
//   dataOnlyCases    §2.5's data-only rule and Amendment A1          → dataOnlyRefusal
//                    ("conformance/corpus/v2/content/", read from the checkout)

package im.plrs.key.conformance

import im.plrs.key.core.DATA_ONLY_HEAD_BYTES
import im.plrs.key.core.DATA_ONLY_TAIL_BYTES
import im.plrs.key.core.FeedRevocation
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyFeedOptions
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyRevocationOptions
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.delegation
import im.plrs.key.core.feed
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.record
import im.plrs.key.core.recordRevoked
import im.plrs.key.core.refusal
import im.plrs.key.core.revocation
import im.plrs.key.core.step
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyFeed
import im.plrs.key.core.verifyReleaseRecord
import im.plrs.key.core.verifyRevocation
import im.plrs.key.packs.dataOnlyRefusal
import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class DelegationTest : ConformanceSuite() {
    private fun trust(v: JsonElement?): TrustSet = v.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    private fun entry(v: JsonElement?): FeedRevocation {
        val e = v!!.obj
        return FeedRevocation(e["record"].stringValue!!, e["pack"].stringValue!!, e["target"].stringValue!!, e["version"].stringValue!!, e["seq"].longValue!!, e["kind"].stringValue)
    }

    @Test
    fun everyDelegationCase() {
        val list = Corpus.v2("cases.json")["delegationCases"]!!.arrayValue!!.map { it.obj }
        assertEquals(46, list.size)
        val f = Failures("delegationCases")
        for (c in list) {
            val id = c["id"].stringValue
            val mode = c["mode"].stringValue!!
            val expect = c["expect"]!!.obj
            val ok = expect["verify"].stringValue == "ok"
            val desc = "$id: ${c["description"].stringValue}"
            when (mode) {
                "feed" -> {
                    val r = verifyFeed(
                        c["jws"].stringValue!!,
                        VerifyFeedOptions(trust(c["trust"]), c["expectedAud"].stringValue!!, c["channel"].stringValue!!, c["platform"].stringValue, c["now"].longValue, c["checkFreshness"].boolValue ?: true),
                    )
                    val feed = r.feed
                    f.check(feed != null) { "$id → ok, got ${r.refusal}" }
                    if (feed == null) continue
                    f.check(jsonEquals(expect["content"], feed.content.json)) { "$desc: got ${feed.content.json}" }
                    // plans/P4-29.md §4.2: these feeds carry no delta menu.
                    f.equal(null, feed.content.deltas) { "$desc deltas" }
                }
                "revocation" -> {
                    val r = verifyRevocation(
                        c["jws"].stringValue!!,
                        VerifyRevocationOptions(trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!, entry(c["entry"])),
                    )
                    if (ok) f.check(jsonEquals(expect["revocation"], r.revocation?.body?.json)) { "$desc revocation" } else f.equal(expect["step"].stringValue, r.step?.wire) { desc }
                }
                else -> {
                    val pin = c["pin"].objectValue?.let {
                        ReleaseRecordPin(it["kind"].stringValue ?: "app", it["deliverable"].stringValue!!, it["version"].stringValue!!, it["seq"].longValue!!)
                    }
                    val delegation = if (mode == "record") c["delegation"].stringValue else null
                    val r = verifyReleaseRecord(
                        c["jws"].stringValue!!,
                        VerifyReleaseRecordOptions(trust(c["releaseKeys"]), trust(c["productTrust"]), c["expectedAud"].stringValue!!, c["expectedHash"].stringValue!!, pin, delegation),
                    )
                    if (!ok) {
                        f.equal(expect["step"].stringValue, r.step?.wire) { desc }
                        continue
                    }
                    val record = r.record
                    f.check(record != null) { "$id → ok, got ${r.step}" }
                    if (record == null) continue
                    f.equal(expect["kind"].stringValue, record.kind) { "$desc kind" }
                    f.check(jsonEquals(expect["delegation"] ?: JsonNull, r.delegation?.json ?: JsonNull)) { "$desc delegation: got ${r.delegation?.json}" }
                    val revoked = c["revoked"].arrayValue
                    if (revoked != null) {
                        val got = recordRevoked(c["expectedHash"].stringValue!!, r.delegation?.sha256, revoked.mapNotNull { it.stringValue }.toSet())
                        f.check(jsonEquals(expect["revoked"] ?: JsonNull, got?.let { JsonPrimitive(it.wire) } ?: JsonNull)) { "$desc revoked: got $got" }
                    }
                }
            }
        }
        f.done(46)
    }

    @Test
    fun everyDataOnlyCase() {
        val list = ContentCorpus.load()["dataOnlyCases"]!!.arrayValue!!.map { it.obj }
        assertEquals(76, list.size)
        // The literal path the parity gate reads: "conformance/corpus/v2/content/".
        val f = Failures("dataOnlyCases")
        val b64 = Base64.getDecoder()
        for (c in list) {
            val id = c["id"].stringValue
            val file: ByteArray = c["content"].stringValue?.let { b64.decode(it) } ?: run {
                val head = b64.decode(c["head"].stringValue ?: "")
                val fill = c["tailFill"].objectValue
                val tail = if (fill != null) ByteArray(fill["length"].longValue!!.toInt()) { fill["byte"].longValue!!.toByte() } else b64.decode(c["tail"].stringValue ?: "")
                head + tail
            }
            val rule = dataOnlyRefusal(
                c["path"].stringValue!!,
                file.copyOf(minOf(file.size, DATA_ONLY_HEAD_BYTES)),
                file.copyOfRange(maxOf(0, file.size - DATA_ONLY_TAIL_BYTES), file.size),
                file,
            )
            val got: JsonObject = if (rule == null) buildJsonObject { put("ok", JsonPrimitive(true)) } else buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("rule", JsonPrimitive(rule.wire))
            }
            f.check(jsonEquals(c["expect"], got)) { "$id: ${c["description"].stringValue}: got $got" }
        }
        f.done(76)
    }
}
