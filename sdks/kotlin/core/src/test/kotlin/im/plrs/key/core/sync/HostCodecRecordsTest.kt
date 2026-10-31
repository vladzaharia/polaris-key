// @pkey-feature sync.e2e
//
// The host codec's record half (U-23.K3; WIRE-CONTRACT-V5 section 13.10.4): scalar record values sealed under
// their collection with `k = id`, the id sent as `blind("record", c, id)`, and a pulled record opened only when
// the `k` inside the envelope re-blinds to the id on the wire. Merge and union records are outside the native
// codec (D-2). The corpus's record rows run in the conformance SyncVectorsTest.

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class RecordsFixtureCodec(private val root: ByteArray) : SyncCodecPort {
    var isLocked = false
    var seals = 0
    override val locked: Boolean get() = isLocked

    override fun seal(collection: String, name: String, value: JsonElement): ByteArray {
        seals++
        return SyncEnvelope.seal(root, collection, name, value)
    }

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(root, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(root, collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = SyncBlind.blind(root, kind, ctx, name)
}

private val ROOT = ByteArray(32) { (3 * it + 7).toByte() }
private val OTHER_ROOT = ByteArray(32) { (250 - 5 * it).toByte() }
private const val SAVES = "saves"
private const val VOL = "audio.volume"
private val codec = RecordsFixtureCodec(ROOT)
private val SEALED = OpenedRow(sealed = true)
private val INVALID = OpenedRow(invalid = true)

private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

private fun str(s: String) = JsonPrimitive(s)

private fun bl(kind: SyncBlind.Kind, ctx: String, n: String) = SyncBlind.blind(ROOT, kind, ctx, n)

private fun ct(collection: String, name: String, v: JsonElement, root: ByteArray = ROOT): String =
    Base64Url.encode(SyncEnvelope.seal(root, collection, name, v))

private fun ref(collection: String, id: String): JsonArray = JsonArray(listOf(str(collection), str(id)))

private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

private fun push(vararg mutations: JsonElement): JsonElement = obj(
    "clientId" to str("c_x"),
    "cursor" to JsonPrimitive(0),
    "atomic" to JsonPrimitive(false),
    "mutations" to JsonArray(mutations.toList()),
)

private fun rec(id: Int, op: String, collection: String, name: String, value: JsonElement? = null): JsonObject {
    val m = mutableMapOf<String, JsonElement>(
        "mutationId" to JsonPrimitive(id),
        "target" to obj("record" to ref(collection, name)),
        "op" to str(op),
        "baseVersion" to JsonPrimitive(3),
    )
    if (value != null) m["value"] = value
    return JsonObject(m)
}

private fun setting(id: Int, key: String, value: JsonElement): JsonObject = obj(
    "mutationId" to JsonPrimitive(id),
    "target" to obj("setting" to str(key), "scope" to str("user")),
    "op" to str("set"),
    "value" to value,
)

private fun sealed(vararg mutations: JsonElement): List<JsonObject> =
    HostCodec.sealPush(push(*mutations), codec, listOf(VOL)).objectValue!!["mutations"].arrayValue!!.map { it as JsonObject }

private fun codeOf(f: () -> Unit): String? = try {
    f()
    null
} catch (e: PolarisException) {
    e.code
} catch (e: SyncCryptoException) {
    "crypto:" + e.message
}

private fun pull(
    body: JsonElement,
    mutations: List<JsonElement> = emptyList(),
    recordKeys: List<Pair<String, String>> = emptyList(),
    c: SyncCodecPort = codec,
) = HostCodec.openPull(body, c, mutations, emptyMap(), emptyList(), recordKeys)

private fun changes(b: JsonElement): List<JsonObject> = b.objectValue!!["changes"].arrayValue!!.map { it as JsonObject }

class HostCodecRecordsTest {
    @Test
    fun setSealsUnderCollectionWithKEqualId() {
        val body = push(rec(1, "set", SAVES, "slot-1", j("""{"hp":10}""")), rec(2, "delete", SAVES, "slot-2"))
        val before = body.toString()
        val out = HostCodec.sealPush(body, codec, listOf(VOL))
        val ms = out.objectValue!!["mutations"].arrayValue!!.map { it as JsonObject }
        assertEquals(ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, "slot-1")), ms[0]["target"].objectValue!!["record"])
        assertTrue(SyncBlind.isBlindedName(bl(SyncBlind.Kind.Record, SAVES, "slot-1")))
        assertEquals(JsonPrimitive(3), ms[0]["baseVersion"])
        assertNull(ms[0]["value"])
        val env = Base64Url.decodeStrict(ms[0]["ct"].stringValue!!)!!
        val ok = SyncEnvelope.open(ROOT, SAVES, "slot-1", env) as SyncEnvelope.Opened.Ok
        assertEquals("slot-1", ok.name)
        assertTrue(SyncJson.jsonEqual(j("""{"hp":10}"""), ok.value))
        // Not under another id or another collection: the name binds the placement.
        assertFalse(SyncEnvelope.open(ROOT, SAVES, "slot-2", env) is SyncEnvelope.Opened.Ok)
        assertFalse(SyncEnvelope.open(ROOT, "other", "slot-1", env) is SyncEnvelope.Opened.Ok)
        // A delete blinds the id and carries no ct.
        assertEquals(ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, "slot-2")), ms[1]["target"].objectValue!!["record"])
        assertNull(ms[1]["ct"])
        assertNull(ms[1]["value"])
        val wire = out.toString()
        for (plain in listOf("slot-1", "slot-2", "\"hp\"")) assertFalse(plain, wire.contains(plain))
        assertEquals(before, body.toString())
    }

    @Test
    fun aSettingAndARecordSealInOneBatch() {
        val ms = sealed(setting(1, VOL, JsonPrimitive(0.5)), rec(2, "set", SAVES, "a", JsonPrimitive(1)))
        assertEquals(VOL, ms[0]["target"].objectValue!!["setting"].stringValue)
        assertEquals(bl(SyncBlind.Kind.Record, SAVES, "a"), ms[1]["target"].objectValue!!["record"].arrayValue!![1].stringValue)
    }

    @Test
    fun refusesWhatTheScalarCodecDoesNotSeal() {
        fun m(op: String, target: JsonElement = obj("record" to ref(SAVES, "a")), extra: Map<String, JsonElement> = emptyMap()): JsonElement =
            JsonObject(mapOf("mutationId" to JsonPrimitive(1), "target" to target, "op" to str(op)) + extra)
        val one = JsonPrimitive(1)
        val refused = mapOf(
            "setField" to m("setField", extra = mapOf("field" to str("hp"), "value" to one)),
            "removeField" to m("removeField", extra = mapOf("field" to str("hp"))),
            "add" to m("add", extra = mapOf("element" to str("e"), "value" to one)),
            "remove" to m("remove", extra = mapOf("element" to str("e"), "observedSeq" to one)),
            "clear" to m("clear"),
            "delete with a value" to m("delete", extra = mapOf("value" to one)),
            "set with no value" to m("set"),
            "set with a ct" to m("set", extra = mapOf("value" to one, "ct" to str("AAAA"))),
            "set with a field" to m("set", extra = mapOf("value" to one, "field" to str("f"))),
            "set with a member" to m("set", extra = mapOf("value" to one, "member" to str("m"))),
            "one-element reference" to m("set", obj("record" to JsonArray(listOf(str(SAVES)))), mapOf("value" to one)),
            "non-string id" to m("set", obj("record" to JsonArray(listOf(str(SAVES), one))), mapOf("value" to one)),
            "id with a NUL" to m("set", obj("record" to ref(SAVES, "a\u0000b")), mapOf("value" to one)),
            "empty id" to m("set", obj("record" to ref(SAVES, "")), mapOf("value" to one)),
            "empty collection" to m("set", obj("record" to ref("", "a")), mapOf("value" to one)),
            "settings namespace" to m("set", obj("record" to ref(HostCodec.SETTINGS_COLLECTION, "a")), mapOf("value" to one)),
        )
        for ((name, mutation) in refused) {
            val c = RecordsFixtureCodec(ROOT)
            assertEquals(name, ErrorCode.invalidOptions, codeOf { HostCodec.sealPush(push(mutation), c, listOf(VOL)) })
            assertEquals(name, 0, c.seals)
        }
        // A value canonical JSON refuses (an integer over 2^53) seals nothing.
        val big = Json.parseToJsonElement("9007199254740993")
        assertTrue(codeOf { HostCodec.sealPush(push(rec(1, "set", SAVES, "a", big)), codec, listOf(VOL)) }!!.startsWith("crypto:"))
    }

    @Test
    fun aLockedCodecSealsNoRecord() {
        val c = RecordsFixtureCodec(ROOT).also { it.isLocked = true }
        assertEquals(ErrorCode.syncLocked, codeOf { HostCodec.sealPush(push(rec(1, "set", SAVES, "a", JsonPrimitive(1))), c, listOf(VOL)) })
        assertEquals(0, c.seals)
        assertEquals(ErrorCode.syncLocked, codeOf { HostCodec.openPull(j("""{"changes":[]}"""), c) })
    }

    @Test
    fun aSealedChangeOpensToTheIdAndValue() {
        val served = bl(SyncBlind.Kind.Record, SAVES, "slot-1")
        val r = pull(
            obj(
                "changes" to JsonArray(
                    listOf(
                        obj(
                            "record" to ref(SAVES, served),
                            "ct" to str(ct(SAVES, "slot-1", j("""{"hp":10}"""))),
                            "version" to JsonPrimitive(8),
                            "editedHlc" to str("h"),
                            "value" to str("FORGED"),
                            "sealed" to JsonPrimitive(true),
                            "seq" to JsonPrimitive(1),
                        ),
                        obj("record" to ref(SAVES, "legacy"), "value" to JsonPrimitive(1), "version" to JsonPrimitive(2)),
                    ),
                ),
            ),
        )
        val c0 = changes(r.body)[0]
        assertEquals(ref(SAVES, "slot-1"), c0["record"])
        assertTrue(SyncJson.jsonEqual(j("""{"hp":10}"""), c0["value"]))
        assertEquals(setOf("record", "value", "version", "editedHlc"), c0.keys)
        assertEquals(listOf<OpenedRow?>(SEALED, OpenedRow(seq = 2)), r.opened.changes)
    }

    @Test
    fun hostileChangesAreInvalidWithNoValueAndNoCt() {
        val served = bl(SyncBlind.Kind.Record, SAVES, "slot-1")
        val good = ct(SAVES, "slot-1", JsonPrimitive(1))
        val tampered = Base64Url.decodeStrict(good)!!.also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        val hostile = mapOf(
            "another id (swapped)" to mapOf("record" to ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, "slot-2")), "ct" to str(good)),
            "another collection" to mapOf("record" to ref("other", served), "ct" to str(good)),
            "the settings namespace" to mapOf("record" to ref(HostCodec.SETTINGS_COLLECTION, served), "ct" to str(good)),
            "an id that is not blinded" to mapOf("record" to ref(SAVES, "slot-1"), "ct" to str(good)),
            "another root" to mapOf("record" to ref(SAVES, served), "ct" to str(ct(SAVES, "slot-1", JsonPrimitive(1), OTHER_ROOT))),
            "a tampered ct" to mapOf("record" to ref(SAVES, served), "ct" to str(Base64Url.encode(tampered))),
            "a ct that is not canonical" to mapOf("record" to ref(SAVES, served), "ct" to str("$good=")),
            "an empty ct" to mapOf("record" to ref(SAVES, served), "ct" to str("")),
            "a field envelope served as a value" to mapOf("record" to ref(SAVES, served), "ct" to str(ct(SAVES, "slot-1\u0000hp", JsonPrimitive(1)))),
            "an id holding NUL" to
                mapOf("record" to ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, "s")), "ct" to str(ct(SAVES, "s\u00001", JsonPrimitive(1)))),
            "sealed fields" to mapOf("record" to ref(SAVES, served), "fields" to JsonArray(emptyList())),
            "sealed elements" to mapOf("record" to ref(SAVES, served), "elements" to JsonArray(emptyList())),
            "a malformed reference" to mapOf("record" to JsonArray(listOf(str(SAVES))), "ct" to str(good)),
        )
        for ((name, entry) in hostile) {
            val e = JsonObject(entry + mapOf("version" to JsonPrimitive(4), "value" to str("FORGED")))
            val r = pull(obj("changes" to JsonArray(listOf(e))))
            assertEquals(name, listOf<OpenedRow?>(INVALID), r.opened.changes)
            assertNull(name, changes(r.body)[0]["value"])
            assertNull(name, changes(r.body)[0]["ct"])
        }
        // A swapped envelope leaves the served blinded id.
        val swapped =
            pull(obj("changes" to JsonArray(listOf(obj("record" to ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, "slot-2")), "ct" to str(good))))))
        assertEquals(bl(SyncBlind.Kind.Record, SAVES, "slot-2"), changes(swapped.body)[0]["record"].arrayValue!![1].stringValue)
    }

    @Test
    fun recordsOfOneCollectionKeepTheirOwnValues() {
        fun row(id: String, v: String, version: Int) =
            obj("record" to ref(SAVES, bl(SyncBlind.Kind.Record, SAVES, id)), "ct" to str(ct(SAVES, id, str(v))), "version" to JsonPrimitive(version))
        val r = pull(obj("changes" to JsonArray(listOf(row("slot-1", "one", 1), row("slot-2", "two", 2)))))
        assertEquals(str("one"), changes(r.body)[0]["value"])
        assertEquals(str("two"), changes(r.body)[1]["value"])
        assertEquals(ref(SAVES, "slot-2"), changes(r.body)[1]["record"])
    }

    @Test
    fun sealThenOpenRoundTrips() {
        val m = sealed(rec(1, "set", SAVES, "slot-9", j("""{"gold":3}""")))[0]
        val r = pull(
            obj(
                "changes" to
                    JsonArray(listOf(obj("record" to m["target"].objectValue!!["record"]!!, "ct" to m["ct"]!!, "version" to JsonPrimitive(5)))),
            ),
        )
        assertEquals(ref(SAVES, "slot-9"), changes(r.body)[0]["record"])
        assertTrue(SyncJson.jsonEqual(j("""{"gold":3}"""), changes(r.body)[0]["value"]))
        assertEquals(listOf<OpenedRow?>(SEALED), r.opened.changes)
    }

    @Test
    fun tombstonesMapBackOnlyForHeldRecords() {
        fun t(c: String, id: String, extra: Map<String, JsonElement> = mapOf("editedHlc" to str("h"))) =
            JsonObject(mapOf("record" to ref(c, bl(SyncBlind.Kind.Record, SAVES, id))) + extra)
        val r = pull(
            obj("tombstones" to JsonArray(listOf(t(SAVES, "slot-1"), t(SAVES, "unknown"), t("other", "slot-1", emptyMap())))),
            recordKeys = listOf(SAVES to "slot-1", HostCodec.SETTINGS_COLLECTION to "x"),
        )
        val ts = r.body.objectValue!!["tombstones"].arrayValue!!.map { it as JsonObject }
        assertEquals(ref(SAVES, "slot-1"), ts[0]["record"])
        assertEquals(str("h"), ts[0]["editedHlc"])
        assertEquals(bl(SyncBlind.Kind.Record, SAVES, "unknown"), ts[1]["record"].arrayValue!![1].stringValue)
        assertEquals("other", ts[2]["record"].arrayValue!![0].stringValue)
        assertTrue(SyncBlind.isBlindedName(ts[2]["record"].arrayValue!![1].stringValue!!))
    }

    @Test
    fun conflictCopiesOpenAgainstTheMutationsOwnRecord() {
        val ms = listOf(
            rec(7, "set", SAVES, "slot-1", JsonPrimitive(1)),
            rec(8, "set", SAVES, "slot-1", JsonPrimitive(1)),
            rec(9, "delete", SAVES, "slot-3"),
            setting(10, VOL, JsonPrimitive(1)),
        )
        fun result(id: Int, server: JsonObject) = obj("mutationId" to JsonPrimitive(id), "status" to str("conflict"), "server" to server)
        val r = pull(
            obj(
                "results" to JsonArray(
                    listOf(
                        result(
                            7,
                            obj(
                                "ct" to str(ct(SAVES, "slot-1", j("""{"hp":99}"""))),
                                "version" to JsonPrimitive(40),
                                "editedHlc" to str("h"),
                                "sealed" to JsonPrimitive(true),
                            ),
                        ),
                        result(8, obj("ct" to str(ct(SAVES, "slot-2", JsonPrimitive(98))), "version" to JsonPrimitive(41))),
                        result(9, obj("ct" to str(ct(SAVES, "slot-3", str("x"))), "version" to JsonPrimitive(42))),
                        result(10, obj("ct" to str(ct(SAVES, "slot-1", JsonPrimitive(1))), "version" to JsonPrimitive(43))),
                        result(11, obj("ct" to str(ct(SAVES, "slot-1", JsonPrimitive(1))), "version" to JsonPrimitive(44))),
                        result(12, obj("value" to j("""{"hp":5}"""), "version" to JsonPrimitive(3))),
                    ),
                ),
            ),
            ms,
        )
        val rs = r.body.objectValue!!["results"].arrayValue!!.map { it as JsonObject }
        val s0 = rs[0]["server"].objectValue!!
        assertTrue(SyncJson.jsonEqual(j("""{"hp":99}"""), s0["value"]))
        assertEquals(setOf("value", "version", "editedHlc"), s0.keys)
        assertEquals(SEALED, r.opened.conflicts[7])
        assertEquals(INVALID, r.opened.conflicts[8])
        assertNull(rs[1]["server"].objectValue!!["value"])
        assertEquals(SEALED, r.opened.conflicts[9])
        assertEquals(str("x"), rs[2]["server"].objectValue!!["value"])
        assertEquals(INVALID, r.opened.conflicts[10])
        assertEquals(INVALID, r.opened.conflicts[11])
        assertEquals(OpenedRow(seq = 3), r.opened.conflicts[12])
        val f = pull(obj("results" to JsonArray(listOf(result(7, obj("fields" to JsonArray(emptyList()), "version" to JsonPrimitive(3)))))), ms)
        assertEquals(INVALID, f.opened.conflicts[7])
    }

    @Test
    fun theCorpusRecordValueRowsOpenAndTheSwappedRowIsInvalid() {
        val rows = JsonText.parse(java.io.File(repoRoot(), "conformance/corpus/v2/sync-vectors.json").readText())
            .objectValue!!["envelopeCases"].arrayValue!!.map { it as JsonObject }
        val ok = rows.first { it["id"].stringValue == "seal-record-value" }
        val swapped = rows.first { it["id"].stringValue == "record-value-swapped-id" }
        val root = unhex(ok["rootHex"].stringValue!!)
        val vCodec = RecordsFixtureCodec(root)
        fun served(c: JsonObject, id: String) = obj(
            "changes" to JsonArray(
                listOf(
                    obj(
                        "record" to
                            ref(c["collection"].stringValue!!, SyncBlind.blind(root, SyncBlind.Kind.Record, c["collection"].stringValue!!, id)),
                        "ct" to str(Base64Url.encode(unhex(c["envelopeHex"].stringValue!!))),
                        "version" to JsonPrimitive(4),
                    ),
                ),
            ),
        )
        val good = pull(served(ok, "slot-1"), c = vCodec)
        assertTrue(SyncJson.jsonEqual(j("""{"hp":10,"gold":3}"""), changes(good.body)[0]["value"]))
        assertEquals(ref("saves", "slot-1"), changes(good.body)[0]["record"])
        assertEquals(listOf<OpenedRow?>(SEALED), good.opened.changes)
        assertEquals("invalid", swapped["expect"].objectValue!!["result"].stringValue)
        assertEquals(listOf<OpenedRow?>(INVALID), pull(served(swapped, "slot-2"), c = vCodec).opened.changes)
    }

    private fun repoRoot(): java.io.File = System.getProperty("pkey.repoRoot")?.let { java.io.File(it) } ?: java.io.File("../..").canonicalFile

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
