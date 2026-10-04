// @pkey-feature config.resolve config.list
//
// Config resolution conformance (WIRE-CONTRACT-V3 §2.2.1), driven off conformance/corpus/v2's
// "config-matrix.json", read in place, over :config's `ConfigResolution` (what `ConfigClient`
// delegates to). The JVM has an environment layer, so every row is checked against `expect`; the
// Node, React, Python, Swift and Godot runners run the same rows.

package im.plrs.key.conformance

import im.plrs.key.config.ConfigResolution
import im.plrs.key.config.ResolveContext
import im.plrs.key.config.UserConfigEntry
import im.plrs.key.core.ManagedEntry
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.decimalValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("config-matrix.json")

    private fun cases(name: String): List<JsonObject> = matrix[name]!!.arrayValue!!.map { it.obj }

    private fun ctx(c: JsonObject, env: Map<String, String>? = null) = ResolveContext(
        remote = c["remote"].objectValue?.mapValues { ManagedEntry.from(it.value) },
        localOverrides = c["localOverrides"]!!.obj,
        env = env ?: c["env"]!!.obj.mapValues { it.value.stringValue!! },
        envPrefix = c["envPrefix"].stringValue!!,
    )

    private fun resolve(context: ResolveContext, key: String, fallback: JsonElement): Pair<JsonElement, String> =
        (ConfigResolution.resolveValue(context, key) ?: fallback) to ConfigResolution.resolveSource(context, key).wire

    private fun passes(got: Pair<JsonElement, String>, want: JsonObject): Boolean =
        got.second == want["source"].stringValue && jsonEquals(got.first, want["value"] ?: JsonNull)

    private fun list(context: ResolveContext): List<UserConfigEntry> =
        ConfigResolution.listUserEntries(context).sortedWith { a, b -> compareUtf8Bytes(a.key, b.key) }

    private fun listPasses(got: List<UserConfigEntry>, want: List<JsonObject>): Boolean =
        got.size == want.size && got.zip(want).all { (g, w) ->
            g.key == w["key"].stringValue && g.enforced == w["enforced"].boolValue && jsonEquals(g.value, w["value"])
        }

    @Test
    fun versionAndFloors() {
        assertEquals(1L, matrix["configMatrixVersion"].longValue)
        assertTrue(cases("resolveCases").size >= 24)
        assertTrue(cases("envValueCases").size >= 82)
        assertTrue(cases("listCases").size >= 8)
    }

    @Test
    fun resolveCases() {
        val f = Failures("config-matrix.json resolveCases")
        for (c in cases("resolveCases")) {
            val got = resolve(ctx(c), c["key"].stringValue!!, c["fallback"]!!)
            f.check(passes(got, c["expect"]!!.obj)) { "${c["id"].stringValue}: got $got, expected ${c["expect"]}" }
        }
        f.done(24)
    }

    @Test
    fun envValueCases() {
        val f = Failures("config-matrix.json envValueCases")
        for (c in cases("envValueCases")) {
            val id = c["id"].stringValue
            val context = ResolveContext(null, emptyMap(), mapOf("PKEY_CONFIG_value" to c["raw"].stringValue!!), "PKEY_CONFIG_")
            val (value, source) = resolve(context, "value", JsonPrimitive("(fallback)"))
            f.equal("env", source) { "$id source" }
            if (c["anyNumber"].boolValue == true) {
                val p = value as? JsonPrimitive
                f.check(p != null && !p.isString && value.decimalValue != null) { "$id: expected a number, got $value" }
            } else {
                f.check(jsonEquals(value, c["value"] ?: JsonNull)) { "$id: got $value, expected ${c["value"]}" }
            }
        }
        f.done(82)
    }

    @Test
    fun listCases() {
        val f = Failures("config-matrix.json listCases")
        for (c in cases("listCases")) {
            val want = c["expect"]!!.arrayValue!!.map { it.obj }
            val got = list(ctx(c))
            f.check(listPasses(got, want)) { "${c["id"].stringValue}: got $got" }
        }
        f.done(8)
    }

    @Test
    fun aDoctoredRowFails() {
        val row = cases("resolveCases").first()
        val got = resolve(ctx(row), row["key"].stringValue!!, row["fallback"]!!)
        assertTrue(passes(got, row["expect"]!!.obj))
        val doctored = JsonObject(row["expect"]!!.obj + ("value" to JsonPrimitive("doctored")))
        assertFalse(passes(got, doctored))
        val l = cases("listCases").first()
        val want = l["expect"]!!.arrayValue!!.map { it.obj }
        assertTrue(listPasses(list(ctx(l)), want))
        assertFalse(listPasses(list(ctx(l)), want.drop(1)))
    }

    /** No corpus row can hold a raw U+0000 or a leading BOM; both keep the raw string. */
    @Test
    fun aRawNulOrBomKeepsTheRawString() {
        for (raw in listOf("[\u0000]\u0000", "\uFEFF[1]", "\"\uD800\"")) {
            assertEquals(JsonPrimitive(raw), ConfigResolution.readEnvValue(raw))
        }
    }
}
