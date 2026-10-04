// @pkey-feature packs.type.l10n.table packs.type.data.json packs.type.ml.model packs.handlers
//
// P4-16's pack-type handlers (P6-08): the shared cases (`packages/client-core/test/fixtures/
// pack-type-cases.json`, read from the checkout) run through each handler's check and activation and
// must reach client-core's verdicts, as the Swift and Python runners do; then an l10n.table pack
// through the engine (install, hot activation, rollback with deactivation).

package im.plrs.key.packs

import im.plrs.key.core.JsonText
import im.plrs.key.core.PackTarget
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.io.File
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private val repoRoot: File get() = File(System.getProperty("pkey.repoRoot") ?: "../..")

private val typeCases: JsonObject by lazy { JsonText.parse(File(repoRoot, "packages/client-core/test/fixtures/pack-type-cases.json").readText()) as JsonObject }

private fun caseFiles(c: JsonObject): List<Pair<String, ByteArray>> = (c["files"].arrayValue ?: emptyList()).map { f ->
    val o = f.objectValue!!
    val path = o["path"].stringValue!!
    path to (o["text"].stringValue?.toByteArray(Charsets.UTF_8) ?: Base64.getDecoder().decode(o["base64"].stringValue!!))
}

private fun installedFiles(files: List<Pair<String, ByteArray>>): List<InstalledFile> =
    files.map { InstalledFile(it.first, sha256Of(it.second), it.second.size.toLong(), MemorySource(it.second)) }

private val zeroSha = "0".repeat(64)

private fun staged(files: List<Pair<String, ByteArray>>, type: String, variant: Map<String, String> = emptyMap()): StagedPack {
    val ref = buildJsonObject {
        put("sha256", JsonPrimitive(zeroSha))
        put("bytes", im.plrs.key.core.jsonInt(0))
        put("size", im.plrs.key.core.jsonInt(0))
        put("codec", JsonPrimitive("none"))
    }
    val v = buildJsonObject {
        put("variant", JsonObject(variant.mapValues { JsonPrimitive(it.value) }))
        put("payload", buildJsonObject { put("size", im.plrs.key.core.jsonInt(0)); put("sha256", JsonPrimitive(zeroSha)) })
        put("full", ref)
        put("files", JsonObject(ref + mapOf("format" to JsonPrimitive("pkey-files/1"), "layout" to JsonPrimitive("tree"))))
    }
    val rec = PackRecordDoc.from(
        buildJsonObject {
            put("kind", JsonPrimitive("pack"))
            put("deliverable", JsonPrimitive("djdl.case"))
            put("version", JsonPrimitive("1.0.0"))
            put("seq", im.plrs.key.core.jsonInt(1))
            put("issuedAt", im.plrs.key.core.jsonInt(1))
            put("type", JsonPrimitive(type))
            put("formatVersion", im.plrs.key.core.jsonInt(1))
            put("variants", JsonArray(listOf(v)))
        },
    )!!
    return StagedPack("djdl.case", rec, rec.variants[0], "mem:case", installedFiles(files), null)
}

private fun reader(files: List<Pair<String, ByteArray>>): PackPayloadReader {
    val fs = installedFiles(files)
    return PackPayloadReader { InstalledPayload(null, fs) }
}

private fun probeInstall(packId: String = "djdl.case") = PackInstall(packId, "", zeroSha, "1.0.0", 1, "x", "", "tree", zeroSha, 0, "hot", "mem:case", null, 0)

private fun messageJson(m: L10nMessage) = buildJsonObject {
    put("context", m.context?.let { JsonPrimitive(it) } ?: JsonNull)
    put("id", JsonPrimitive(m.id))
    put("plural", m.plural?.let { JsonPrimitive(it) } ?: JsonNull)
    put("strings", JsonArray(m.strings.map { JsonPrimitive(it) }))
}

private fun tableJson(t: L10nTable) = buildJsonObject {
    put("path", JsonPrimitive(t.path))
    put("locale", JsonPrimitive(t.locale))
    put("messages", JsonArray(t.messages.map { messageJson(it) }))
}

class PackTypeHandlersTest {
    private fun cases(name: String): List<JsonObject> = typeCases[name]!!.arrayValue!!.map { it as JsonObject }

    private fun expected(v: JsonElement?): Triple<Boolean, String?, String?> {
        val o = v!!.objectValue!!
        return Triple(o["ok"] == JsonPrimitive(true), o["detail"].stringValue, o["path"].stringValue)
    }

    @Test
    fun bcp47Cases() {
        val list = cases("bcp47")
        assertTrue(list.size > 10)
        for (o in list) {
            val tag = o["tag"].stringValue!!
            val got = bcp47Canonical(tag)
            if (o["ok"] == JsonPrimitive(true)) assertEquals("bcp47 $tag", o["canonical"].stringValue ?: tag, got) else assertNull("bcp47 $tag", got)
        }
    }

    @Test
    fun dataJsonCases() = runBlocking {
        for (o in cases("dataJson")) {
            val name = o["name"].stringValue
            val max = o["options"].objectValue?.get("maxFileBytes").longValue ?: PACK_TEXT_MAX_FILE_BYTES
            val h = DataJsonHandler(maxFileBytes = max)
            val files = caseFiles(o)
            val r = h.check(staged(files, "data.json"))
            val (ok, detail, path) = expected(o["expect"])
            if (ok) {
                assertNull(name, r)
                h.activate(probeInstall(), reader(files))
                val docs = h.documents("djdl.case")!!
                assertEquals(name, files.map { it.first }, docs.map { it.path })
                val got = JsonObject(docs.associate { it.path to it.value })
                assertTrue("$name: got $got", jsonEquals(o["expect"]!!.objectValue!!["documents"], got))
            } else {
                assertEquals(name, detail, r?.detail)
                assertEquals(name, path, r?.path)
            }
        }
    }

    @Test
    fun l10nTableCases() = runBlocking {
        for (o in cases("l10nTable")) {
            val name = o["name"].stringValue
            val max = o["options"].objectValue?.get("maxFileBytes").longValue ?: PACK_TEXT_MAX_FILE_BYTES
            val variant = (o["variant"].objectValue ?: JsonObject(emptyMap())).mapValues { it.value.stringValue!! }
            val h = L10nTableHandler(maxFileBytes = max)
            val files = caseFiles(o)
            val r = h.check(staged(files, "l10n.table", variant))
            val (ok, detail, path) = expected(o["expect"])
            if (ok) {
                assertNull("$name: $r", r)
                h.activate(probeInstall(), reader(files))
                val got = JsonArray(h.tables("djdl.case")!!.map { tableJson(it) })
                assertTrue("$name: got $got", jsonEquals(o["expect"]!!.objectValue!!["tables"], got))
            } else {
                assertEquals(name, detail, r?.detail)
                assertEquals(name, path, r?.path)
            }
        }
    }

    @Test
    fun mlModelCases() = runBlocking {
        for (o in cases("mlModel")) {
            val name = o["name"].stringValue
            val opts = o["options"]!!.objectValue!!
            val lt = o["loadTest"]
            val seen = ArrayList<String>()
            val pass = lt == JsonPrimitive(true)
            val test: (suspend (MlModelLoadTest) -> Boolean)? = if (lt == null || lt is JsonNull) null else { m ->
                seen += m.file.path
                pass
            }
            val h = MlModelHandler(
                opts["runtimes"]!!.arrayValue!!.map { it.stringValue!! }, opts["ramBytes"].longValue!!, opts["vramBytes"].longValue ?: 0,
                opts["quantizations"].arrayValue?.map { it.stringValue!! }, test,
            )
            val files = caseFiles(o)
            val r = h.check(staged(files, "ml.model"))
            val (ok, detail, path) = expected(o["expect"])
            if (ok) {
                assertNull("$name: $r", r)
                h.activate(probeInstall(), reader(files))
                assertEquals(name, o["expect"]!!.objectValue!!["file"].stringValue, h.model("djdl.case")?.path)
                if (test != null) assertEquals(name, listOf(h.model("djdl.case")!!.path), seen)
            } else {
                assertEquals(name, detail, r?.detail)
                assertEquals(name, path, r?.path)
            }
        }
    }

    @Test
    fun mlModelHandlerValidatesItsOptionsAndAThrowingLoadTestRefuses() = runBlocking {
        for (bad in listOf<() -> Unit>({ MlModelHandler(emptyList(), 1) }, { MlModelHandler(listOf("onnx"), -1) })) {
            try {
                bad()
                fail("invalid options accepted")
            } catch (e: PackException) {
                assertEquals("invalid-options", e.code)
            }
        }
        val h = MlModelHandler(listOf("onnx"), 10, loadTest = { throw IllegalStateException("boom") })
        val files = listOf("model.json" to "{\"runtime\":\"onnx\",\"file\":\"m.onnx\",\"memBytes\":1}".toByteArray(), "m.onnx" to "x".toByteArray())
        assertEquals(PackCheckRefusal("load-test", "m.onnx"), h.check(staged(files, "ml.model")))
    }

    @Test
    fun anL10nTablePackInstallsActivatesAndRollsBack() = runBlocking {
        fun table(hello: String) = mapOf("fr.po" to "msgid \"\"\nmsgstr \"Language: fr\\n\"\n\nmsgid \"hello\"\nmsgstr \"$hello\"\n".toByteArray())
        val v1 = treePack("djdl.l10n", "1.0.0", 1, table("Bonjour"), type = "l10n.table")
        val v2 = treePack("djdl.l10n", "1.1.0", 2, table("Salut"), type = "l10n.table")
        val events = ArrayList<String>()
        val h = L10nTableHandler(
            onActivate = { _, t -> events += "on ${t[0].messages[0].strings[0]}" },
            onDeactivate = { _, t -> events += "off ${t.firstOrNull()?.messages?.get(0)?.strings?.get(0) ?: "-"}" },
        )
        val engine = engineOf(ByteServer(v1, v2), stampOf(v1), handlers = listOf(h))
        engine.load()
        engine.ensure(listOf("djdl.l10n"))
        engine.ensureReleases(listOf(PackTarget("djdl.l10n", v2.pin)))
        assertEquals("Salut", h.tables("djdl.l10n")!![0].messages[0].strings[0])
        engine.rollback("djdl.l10n")
        assertEquals("Bonjour", h.tables("djdl.l10n")!![0].messages[0].strings[0])
        assertEquals(listOf("on Bonjour", "off Bonjour", "on Salut", "off Salut", "on Bonjour"), events)
    }
}
