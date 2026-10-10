// @pkey-feature core.presentation
//
// The Kotlin runner for conformance/corpus/v2/presentation-matrix.json (WIRE-CONTRACT-V4 §5.5,
// plans/HA-13.md §4): every parse row through `PresentationRules.parsePresentation` (and the fixed
// point: what the Worker emits re-parses to itself), every pick row through `pickIconSize` with the
// row's decodable set and again with this runtime's, and every verify row through `iconMatches`.
// Then the edges the corpus cannot carry (a lone surrogate, unknown members, a nonsensical hero).

package im.plrs.key.conformance

import im.plrs.key.core.IconPick
import im.plrs.key.core.PRESENTATION_MATRIX_VERSION
import im.plrs.key.core.PresentationIcon
import im.plrs.key.core.PresentationIconSize
import im.plrs.key.core.PresentationRules
import im.plrs.key.core.arrayValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("presentation-matrix.json")

    private fun rows(family: String): List<JsonObject> = matrix[family]!!.arrayValue!!.map { it.obj }

    private fun pickJson(p: IconPick): JsonElement = when (p) {
        is IconPick.Size -> JsonObject(
            mapOf("source" to JsonPrimitive("size"), "w" to jsonInt(p.w.toLong()), "sha256" to JsonPrimitive(p.sha256), "url" to JsonPrimitive(p.url)),
        )
        is IconPick.Original -> JsonObject(mapOf("source" to JsonPrimitive("original"), "sha256" to JsonPrimitive(p.sha256), "url" to JsonPrimitive(p.url)))
        IconPick.None -> JsonObject(mapOf("source" to JsonPrimitive("none")))
    }

    /** A pick row's `icon` is already normalised (the generator emits parsed members). */
    private fun icon(o: JsonObject): PresentationIcon = PresentationIcon(
        sha256 = o["sha256"].stringValue!!,
        contentType = o["contentType"].stringValue!!,
        width = o["width"].longValue?.toInt(),
        height = o["height"].longValue?.toInt(),
        original = o["original"].stringValue!!,
        url = o["url"].stringValue,
        sizes = o["sizes"]?.arrayValue?.map { PresentationIconSize(it.obj["w"].longValue!!.toInt(), it.obj["sha256"].stringValue!!) } ?: emptyList(),
    )

    @Test
    fun versionAndShape() {
        assertEquals(PRESENTATION_MATRIX_VERSION.toLong(), matrix["presentationMatrixVersion"].longValue)
        assertTrue(rows("parseCases").size > 50)
        assertTrue(rows("pickCases").size > 15)
        assertTrue(rows("verifyCases").size >= 4)
    }

    @Test
    fun parseCases() {
        val f = Failures("presentation-matrix parseCases")
        for (row in rows("parseCases")) {
            val name = row["name"].stringValue!!
            val doc = row["doc"]!!.obj
            val product = doc["product"].stringValue!!
            val got = PresentationRules.parsePresentation(row["core"], doc["name"], product)
            val want = row["expect"]
            val gotJson: JsonElement = got?.toJson() ?: JsonNull
            f.check(jsonEquals(want, gotJson)) { "parse $name: expected $want, got $gotJson" }
            if (got != null) {
                // The fixed point: what the Worker emits, every SDK re-parses to itself.
                val again = PresentationRules.parsePresentation(JsonObject(mapOf("presentation" to got.toJson())), doc["name"], product)
                f.check(again == got) { "parse $name: re-parse gave $again" }
            }
        }
        f.done(50)
    }

    @Test
    fun pickCases() {
        val f = Failures("presentation-matrix pickCases")
        for (row in rows("pickCases")) {
            val name = row["name"].stringValue!!
            val px = row["px"].decimalValue!!.toDouble()
            val scale = row["scale"].decimalValue!!.toDouble()
            val decodable = row["decodable"]!!.arrayValue!!.map { it.stringValue!! }
            val got = pickJson(PresentationRules.pickIconSize(icon(row["icon"]!!.obj), px, scale, decodable))
            f.check(jsonEquals(row["expect"], got)) { "pick $name: expected ${row["expect"]}, got $got" }
        }
        f.done(15)
    }

    @Test
    fun pickWithThisRuntimesDecoders() {
        // The JVM decodes PNG, JPEG and GIF (no WebP reader): a ladder is never chosen, the original
        // is when it is one of those, and nothing otherwise.
        for (row in rows("pickCases")) {
            val ic = icon(row["icon"]!!.obj)
            val got = PresentationRules.pickIconSize(ic, 64.0, 2.0, PresentationRules.JVM_DECODABLE)
            if (ic.contentType in PresentationRules.JVM_DECODABLE) {
                assertEquals(row["name"].stringValue, IconPick.Original(ic.sha256, ic.original), got)
            } else {
                assertEquals(row["name"].stringValue, IconPick.None, got)
            }
        }
        // Android adds WebP (and AVIF from API 31): the ladder.
        val ladder = icon(rows("pickCases").first()["icon"]!!.obj)
        assertTrue(PresentationRules.pickIconSize(ladder, 32.0, 2.0, PresentationRules.androidDecodable(24)) is IconPick.Size)
        assertTrue("image/avif" in PresentationRules.androidDecodable(31))
        assertTrue("image/avif" !in PresentationRules.androidDecodable(30))
    }

    @Test
    fun verifyCases() {
        val f = Failures("presentation-matrix verifyCases")
        for (row in rows("verifyCases")) {
            val bytes = Base64.getDecoder().decode(row["bytes"].stringValue!!)
            val want = row["expect"].toString() == "true"
            f.equal(want, PresentationRules.iconMatches(bytes, row["sha256"].stringValue!!)) { "verify ${row["name"].stringValue}" }
        }
        f.done(4)
    }

    @Test
    fun aLoneSurrogateIsNotText() {
        val core = JsonObject(mapOf("presentation" to JsonObject(mapOf("name" to JsonPrimitive("a\uDC00")))))
        assertEquals("p", PresentationRules.parsePresentation(core, null, "p")!!.name)
        val high = JsonObject(mapOf("presentation" to JsonObject(mapOf("name" to JsonPrimitive("\uD800b"), "developerName" to JsonPrimitive("x\uD83D")))))
        val got = PresentationRules.parsePresentation(high, JsonPrimitive("Doc"), "p")!!
        assertEquals("Doc", got.name)
        assertNull(got.developerName)
        // A pair is one character, four UTF-8 bytes, and kept.
        val pair = JsonObject(mapOf("presentation" to JsonObject(mapOf("name" to JsonPrimitive("🎲")))))
        assertEquals("🎲", PresentationRules.parsePresentation(pair, null, "p")!!.name)
    }

    @Test
    fun unknownMembersAreNeverCarried() {
        val raw = JsonObject(
            mapOf(
                "name" to JsonPrimitive("P"),
                "extra" to jsonInt(1),
                "icon" to JsonObject(
                    mapOf(
                        "sha256" to JsonPrimitive("a".repeat(64)),
                        "contentType" to JsonPrimitive("image/png"),
                        "original" to JsonPrimitive("https://img.plrs.im/p/a/x"),
                        "extra" to jsonInt(2),
                    ),
                ),
            ),
        )
        val got = PresentationRules.parsePresentation(JsonObject(mapOf("presentation" to raw)), null, "p")!!
        assertEquals(setOf("name", "icon"), got.toJson().keys)
        assertEquals(setOf("sha256", "contentType", "original", "sizes"), got.toJson()["icon"].objectValue!!.keys)
    }

    @Test
    fun originsAndSafeLinks() {
        assertEquals("https://img.plrs.im:443", PresentationRules.usableUrlOrigin("HTTPS://Img.Plrs.Im:443/x?y"))
        assertEquals("http://[::1]", PresentationRules.usableUrlOrigin("http://[::1]/x"))
        assertNull(PresentationRules.usableUrlOrigin("http://[::2]/x"))
        assertNull(PresentationRules.usableUrlOrigin("http://img.plrs.im/x"))
        assertNull(PresentationRules.usableUrlOrigin(null))
        assertTrue(PresentationRules.safeFetchUrl("https://img.plrs.im/a/64.webp", "https://IMG.plrs.im/a"))
        assertTrue(PresentationRules.safeFetchUrl("http://127.0.0.1:8080/a", "http://127.0.0.1:8080/b"))
        assertTrue(!PresentationRules.safeFetchUrl("https://evil.example/a", "https://img.plrs.im/a"))
        assertTrue(!PresentationRules.safeFetchUrl("http://img.plrs.im/a", "https://img.plrs.im/a"))
        assertTrue(!PresentationRules.safeFetchUrl("https://img.plrs.im:444/a", "https://img.plrs.im/a"))
    }

    @Test
    fun aNonsensicalHeroSizeStillPicksSomething() {
        val ic = PresentationIcon(
            sha256 = "a".repeat(64), contentType = "image/png", original = "https://img.plrs.im/p/a/x",
            url = "https://img.plrs.im/p/a/x/{w}.webp", sizes = listOf(PresentationIconSize(64, "b".repeat(64))),
        )
        assertEquals(64, (PresentationRules.pickIconSize(ic, Double.NaN, 2.0, listOf("image/webp")) as IconPick.Size).w)
        assertEquals(64, (PresentationRules.pickIconSize(ic, -5.0, 1.0, setOf("image/webp")) as IconPick.Size).w)
        assertEquals(64, (PresentationRules.pickIconSize(ic, Double.POSITIVE_INFINITY, 1.0, setOf("image/webp")) as IconPick.Size).w)
    }
}
