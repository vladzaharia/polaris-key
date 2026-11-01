// @pkey-feature sync.records
//
// The host codec's cells (WIRE-CONTRACT-V5 section 13.10.4): a `merge` record's field is sealed under
// `id U+0000 field`, a `union` record's element under `id U+0000 canonicalJson(e)`, each name sent as
// `blind("field" | "element", collection, name)`, and a pulled record opens only when every envelope's `k` re-blinds
// to the names on the wire and all of them name one record.

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
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

private val ROOT = ByteArray(32) { (3 * it + 7).toByte() }

private class CellsCodec : SyncCodecPort {
    var seals = 0
    override val locked: Boolean = false

    override fun seal(collection: String, name: String, value: JsonElement): ByteArray {
        seals++
        return SyncEnvelope.seal(ROOT, collection, name, value)
    }

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(ROOT, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(ROOT, collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = SyncBlind.blind(ROOT, kind, ctx, name)
}

private const val CARDS = "cards"
private const val TAGS = "tags"
private val codec = CellsCodec()

private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

private fun str(s: String) = JsonPrimitive(s)

private fun bl(kind: SyncBlind.Kind, ctx: String, n: String) = SyncBlind.blind(ROOT, kind, ctx, n)

private fun ct(collection: String, name: String, v: JsonElement): String = Base64Url.encode(SyncEnvelope.seal(ROOT, collection, name, v))

private fun ref(c: String, id: String) = JsonArray(listOf(str(c), str(id)))

private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

private fun mutation(op: String, c: String, id: String, vararg extra: Pair<String, JsonElement>): JsonObject =
    obj("mutationId" to JsonPrimitive(1), "target" to obj("record" to ref(c, id)), "op" to str(op), *extra)

private fun seal(m: JsonObject): JsonObject = HostCodec.sealPush(
    obj("clientId" to str("c_x"), "cursor" to JsonPrimitive(0), "mutations" to JsonArray(listOf(m))),
    codec,
    emptyList<String>(),
).objectValue!!["mutations"].arrayValue!![0] as JsonObject

private fun code(f: () -> Unit): String? = try {
    f()
    null
} catch (e: PolarisException) {
    e.code
}

private fun field(id: String, name: String, v: JsonElement) =
    obj("field" to str(bl(SyncBlind.Kind.Field, CARDS, name)), "ct" to str(ct(CARDS, "$id\u0000$name", v)))

private fun element(id: String, e: JsonElement) = obj(
    "element" to str(bl(SyncBlind.Kind.Element, TAGS, CanonicalJson.encode(e))),
    "ct" to str(ct(TAGS, "$id\u0000${CanonicalJson.encode(e)}", e)),
)

private fun row(c: String, id: String, key: String, cells: List<JsonElement>) =
    obj("record" to ref(c, bl(SyncBlind.Kind.Record, c, id)), key to JsonArray(cells), "version" to JsonPrimitive(4))

private fun open(vararg rows: JsonObject, held: List<Pair<String, String>> = emptyList()) =
    HostCodec.openPull(obj("changes" to JsonArray(rows.toList())), codec, emptyList(), emptyMap(), emptyList(), held)

class HostCodecCellsTest {
    @Test
    fun setFieldSealsUnderIdNulField() {
        val m = seal(mutation("setField", CARDS, "c1", "field" to str("hp"), "value" to JsonPrimitive(30), "editedHlc" to str("h")))
        assertEquals(bl(SyncBlind.Kind.Field, CARDS, "hp"), m["field"].stringValue)
        assertEquals(ref(CARDS, bl(SyncBlind.Kind.Record, CARDS, "c1")), m["target"].objectValue!!["record"])
        assertNull(m["value"])
        val ok = SyncEnvelope.open(ROOT, CARDS, "c1\u0000hp", Base64Url.decodeStrict(m["ct"].stringValue!!)!!) as SyncEnvelope.Opened.Ok
        assertEquals(JsonPrimitive(30), ok.value)
        // Not under another record: the name binds the placement.
        assertFalse(SyncEnvelope.open(ROOT, CARDS, "c2\u0000hp", Base64Url.decodeStrict(m["ct"].stringValue!!)!!) is SyncEnvelope.Opened.Ok)
        for (plain in listOf("\"c1\"", "\"hp\"")) assertFalse(plain, m.toString().contains(plain))
        assertEquals("h", m["editedHlc"].stringValue)
    }

    @Test
    fun removeFieldAndRemoveCarryNoCt() {
        val rf = seal(mutation("removeField", CARDS, "c1", "field" to str("hp")))
        assertEquals(bl(SyncBlind.Kind.Field, CARDS, "hp"), rf["field"].stringValue)
        assertNull(rf["ct"])
        val e = j("""{"a":1,"b":[2]}""")
        val rm = seal(mutation("remove", TAGS, "t1", "element" to e, "observedSeq" to JsonPrimitive(3)))
        assertEquals(bl(SyncBlind.Kind.Element, TAGS, """{"a":1,"b":[2]}"""), rm["element"].stringValue)
        assertNull(rm["ct"])
        assertEquals(JsonPrimitive(3), rm["observedSeq"])
    }

    @Test
    fun addSealsTheElementUnderItsCanonicalJson() {
        val e = j("""{"b":2,"a":1}""")
        val m = seal(mutation("add", TAGS, "t1", "element" to e))
        val name = """{"a":1,"b":2}"""
        assertEquals(bl(SyncBlind.Kind.Element, TAGS, name), m["element"].stringValue)
        val ok = SyncEnvelope.open(ROOT, TAGS, "t1\u0000$name", Base64Url.decodeStrict(m["ct"].stringValue!!)!!) as SyncEnvelope.Opened.Ok
        assertTrue(SyncJson.jsonEqual(e, ok.value))
    }

    @Test
    fun refusesWhatACellDoesNotTake() {
        val one = JsonPrimitive(1)
        val refused = mapOf(
            "empty field" to mutation("setField", CARDS, "c", "field" to str(""), "value" to one),
            "field with a NUL" to mutation("setField", CARDS, "c", "field" to str("a\u0000b"), "value" to one),
            "no field" to mutation("removeField", CARDS, "c"),
            "setField with no value" to mutation("setField", CARDS, "c", "field" to str("f")),
            "setField with an element" to mutation("setField", CARDS, "c", "field" to str("f"), "value" to one, "element" to one),
            "removeField with a value" to mutation("removeField", CARDS, "c", "field" to str("f"), "value" to one),
            "add with no element" to mutation("add", TAGS, "t"),
            "add with a value" to mutation("add", TAGS, "t", "element" to one, "value" to one),
            "add with a field" to mutation("add", TAGS, "t", "element" to one, "field" to str("f")),
            "remove with a member" to mutation("remove", TAGS, "t", "element" to one, "member" to str("m")),
            "delete with a field" to mutation("delete", CARDS, "c", "field" to str("f")),
            "a ct" to mutation("add", TAGS, "t", "element" to one, "ct" to str("AAAA")),
            "an element canonical JSON refuses" to mutation("add", TAGS, "t", "element" to Json.parseToJsonElement("9007199254740993")),
        )
        for ((name, m) in refused) {
            val c = CellsCodec()
            val body = obj("clientId" to str("c_x"), "cursor" to JsonPrimitive(0), "mutations" to JsonArray(listOf(m)))
            assertEquals(name, ErrorCode.invalidOptions, code { HostCodec.sealPush(body, c, emptyList<String>()) })
            assertEquals(name, 0, c.seals)
        }
    }

    @Test
    fun aMergeRecordOpensToItsFields() {
        val r = open(row(CARDS, "c1", "fields", listOf(field("c1", "hp", JsonPrimitive(30)), field("c1", "title", str("Dragon")))))
        assertEquals(listOf<OpenedRow?>(OpenedRow(sealed = true)), r.opened.changes)
        val c = r.body.objectValue!!["changes"].arrayValue!![0] as JsonObject
        assertEquals(ref(CARDS, "c1"), c["record"])
        assertEquals(j("""{"hp":30,"title":"Dragon"}"""), c["value"])
        assertNull(c["fields"])
    }

    @Test
    fun aUnionRecordOpensToItsElementsInServedOrder() {
        val es = listOf(j("""{"k":2}"""), str("x"), JsonPrimitive(7))
        val r = open(row(TAGS, "t1", "elements", es.map { element("t1", it) }))
        assertEquals(listOf<OpenedRow?>(OpenedRow(sealed = true)), r.opened.changes)
        val c = r.body.objectValue!!["changes"].arrayValue!![0] as JsonObject
        assertEquals(ref(TAGS, "t1"), c["record"])
        assertEquals(JsonArray(es), c["value"])
    }

    @Test
    fun anEmptyRecordTakesItsIdFromTheHeldRecords() {
        val held = open(row(CARDS, "c1", "fields", emptyList()), held = listOf(CARDS to "c1"))
        val c = held.body.objectValue!!["changes"].arrayValue!![0] as JsonObject
        assertEquals(ref(CARDS, "c1"), c["record"])
        assertEquals(JsonObject(emptyMap()), c["value"])
        val unknown = open(row(CARDS, "c1", "fields", emptyList()))
        assertEquals(listOf<OpenedRow?>(OpenedRow(sealed = true)), unknown.opened.changes)
        assertEquals(
            ref(CARDS, bl(SyncBlind.Kind.Record, CARDS, "c1")),
            (unknown.body.objectValue!!["changes"].arrayValue!![0] as JsonObject)["record"],
        )
    }

    @Test
    fun hostileCellsMakeTheRowInvalid() {
        val good = field("c1", "hp", JsonPrimitive(1))
        val elem = element("t1", str("x"))
        val invalid = OpenedRow(invalid = true)
        val rows = mapOf(
            "a field of another record" to row(CARDS, "c1", "fields", listOf(good, field("c2", "title", str("x")))),
            "a swapped field name" to
                row(CARDS, "c1", "fields", listOf(obj("field" to str(bl(SyncBlind.Kind.Field, CARDS, "other")), "ct" to good["ct"]!!))),
            "a field cell under the wrong record id" to row(CARDS, "c2", "fields", listOf(good)),
            "a repeated field" to row(CARDS, "c1", "fields", listOf(good, good)),
            "an unblinded field name" to row(CARDS, "c1", "fields", listOf(obj("field" to str("hp"), "ct" to good["ct"]!!))),
            "an element under the wrong record" to row(TAGS, "t2", "elements", listOf(elem)),
            "an element whose name is not its spelling" to
                row(
                    TAGS,
                    "t1",
                    "elements",
                    listOf(
                        obj(
                            "element" to str(bl(SyncBlind.Kind.Element, TAGS, "\"y\"")),
                            "ct" to str(ct(TAGS, "t1\u0000\"y\"", str("x"))),
                        ),
                    ),
                ),
            "an envelope with no cut" to
                row(
                    CARDS,
                    "c1",
                    "fields",
                    listOf(
                        obj(
                            "field" to str(bl(SyncBlind.Kind.Field, CARDS, "hp")),
                            "ct" to str(ct(CARDS, "c1", JsonPrimitive(1))),
                        ),
                    ),
                ),
            "a cell that is not an object" to row(CARDS, "c1", "fields", listOf(str("x"))),
            "a ct beside fields" to JsonObject(row(CARDS, "c1", "fields", listOf(good)) + ("ct" to good["ct"]!!)),
            "plaintext fields" to JsonObject(obj("record" to ref(CARDS, "c1"), "fields" to JsonArray(emptyList()))),
        )
        for ((name, r) in rows) {
            val opened = open(r)
            assertEquals(name, listOf<OpenedRow?>(invalid), opened.opened.changes)
            val c = opened.body.objectValue!!["changes"].arrayValue!![0] as JsonObject
            assertNull(name, c["value"])
            assertNull(name, c["fields"])
            assertNull(name, c["elements"])
        }
    }

    @Test
    fun aConflictCopyOpensAgainstTheMutationsOwnRecord() {
        val server = obj("fields" to JsonArray(listOf(field("c1", "hp", JsonPrimitive(30)))), "version" to JsonPrimitive(3))
        val body = obj(
            "results" to JsonArray(listOf(obj("mutationId" to JsonPrimitive(1), "status" to str("conflict"), "server" to server))),
        )
        val m = mutation("setField", CARDS, "c1", "field" to str("hp"), "value" to JsonPrimitive(1))
        val r = HostCodec.openPull(body, codec, listOf(m))
        assertEquals(OpenedRow(sealed = true), r.opened.conflicts[1L])
        val copy = r.body.objectValue!!["results"].arrayValue!![0].objectValue!!["server"].objectValue!!
        assertEquals(j("""{"hp":30}"""), copy["value"])
        assertNull(copy["fields"])
        // Cells of another record are not this record's copy.
        val wrong = obj("fields" to JsonArray(listOf(field("c2", "hp", JsonPrimitive(30)))), "version" to JsonPrimitive(3))
        val other = HostCodec.openPull(
            obj("results" to JsonArray(listOf(obj("mutationId" to JsonPrimitive(1), "status" to str("conflict"), "server" to wrong)))),
            codec,
            listOf(m),
        )
        assertEquals(OpenedRow(invalid = true), other.opened.conflicts[1L])
    }
}
