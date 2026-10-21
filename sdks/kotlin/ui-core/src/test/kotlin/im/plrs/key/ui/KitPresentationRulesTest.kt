// Presentation-core rules `ui-matrix.json` leaves unpinned (it compares states, copy keys and
// actions, never a line's arguments or a corner of the inputs). Each mirrors the Swift core.
package im.plrs.key.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KitPresentationRulesTest {
    private fun inputs(json: String): KitInputs = KitInputs.fromJson(Json.parseToJsonElement(json) as JsonObject)

    private val tidewater = "pkey_tidewater_"

    @Test
    fun keyVerdictFollowsTheWorkersKeyShape() {
        val secret22 = "Q2xvdWRzT3ZlclRoZUhpbG"
        assertEquals(22, secret22.length)
        assertEquals(KeyVerdict.Kind.Empty, KeyVerdict.of("  ").kind)
        assertEquals(KeyVerdict.Kind.SubmittedEmpty, KeyVerdict.of("", submitted = true).kind)
        assertEquals(KeyVerdict.Kind.Typing, KeyVerdict.of("pk").kind)
        assertEquals(KeyVerdict.Kind.Malformed, KeyVerdict.of("pk", submitted = true).kind)
        assertEquals(KeyVerdict.Kind.Malformed, KeyVerdict.of("px").kind)
        assertEquals(KeyVerdict.Kind.Typing, KeyVerdict.of("pkey_tidewater").kind)
        assertEquals(KeyVerdict.Kind.Malformed, KeyVerdict.of("pkey_Tide_$secret22").kind)
        val parsed = KeyVerdict.of(" $tidewater$secret22 ")
        assertEquals(KeyVerdict.Kind.Parsed, parsed.kind)
        assertEquals("tidewater", parsed.slug)
        assertEquals(KeyVerdict.Kind.Typing, KeyVerdict.of(tidewater + secret22.dropLast(1)).kind)
        assertEquals(KeyVerdict.Kind.CutShort, KeyVerdict.of(tidewater + secret22.dropLast(1), submitted = true).kind)
        assertEquals(KeyVerdict.Kind.Malformed, KeyVerdict.of("$tidewater${secret22}x").kind)
    }

    @Test
    fun aCutShortKeyNamesItsPrefixAndCount() {
        val screen = KitStates.resolve(
            KitComponent.activate,
            inputs("""{"keyField":{"text":"${tidewater}Q2xvdWRzT3ZlclRoZUhpb","submitted":true}}"""),
        )
        assertEquals("cut-short", screen.state)
        val line = screen.copy.single { it.key == "part.keyField.cutShort" }
        assertEquals("part.keyField.cutShort", line.key)
        assertTrue(KitCopy.bundled.argumentNames(line.key).all { it in line.args })
        assertEquals(
            "This key is cut short: after pkey_tidewater_ it has 21 of 22 characters.",
            KitCopy.bundled.format(line, "en"),
        )
    }

    @Test
    fun anActivationNamesItsSeatsOnlyWhenTheRefusalCountsThem() {
        val counted = KitStates.resolve(
            KitComponent.activate,
            inputs("""{"activation":{"result":"device-limit","deviceCount":3,"limit":3,"manageUrl":"https://key.plrs.im/manage"}}"""),
        )
        assertTrue(counted.shows("part.seatMeter.caption"))
        assertFalse(counted.shows("deviceLimit.noManage"))
        val uncounted = KitStates.resolve(
            KitComponent.activate,
            inputs("""{"activation":{"result":"device-limit"}}"""),
        )
        assertFalse(uncounted.shows("part.seatMeter.caption"))
        val noManage = uncounted.copy.single { it.key == "deviceLimit.noManage" }
        assertTrue(KitCopy.bundled.argumentNames(noManage.key).all { it in noManage.args })
    }

    @Test
    fun platformPredicatesFollowTheOsAndTheFormFactor() {
        fun platform(os: String, formFactor: String) = inputs("""{"platform":{"os":"$os","formFactor":"$formFactor"}}""")
        assertTrue(platform("macos", "mac").isDesktop)
        assertTrue(platform("windows", "computer").isDesktop)
        assertFalse("the web is not a desktop window", platform("web", "computer").isDesktop)
        assertTrue(platform("android", "phone").isHandheld)
        assertTrue(platform("ios", "ipad").isHandheld)
        assertTrue(platform("android", "tv").isTv)
        assertTrue(platform("tvos", "other").isTv)
        assertFalse(platform("android", "tv").isHandheld)
        assertFalse(platform("android", "tv").isDesktop)
        assertFalse(platform("linux", "tv").isDesktop)
    }

    @Test
    fun servicesAreClosedUnderTheirRequirements() {
        assertEquals(8, inputs("{}").closedServices.size)
        assertEquals(emptySet<String>(), inputs("""{"services":["update"]}""").closedServices)
        assertEquals(
            setOf("release", "distribution", "update"),
            inputs("""{"services":["release","distribution","update"]}""").closedServices,
        )
        assertEquals(setOf("config"), inputs("""{"services":["config","sync"]}""").closedServices)
        assertEquals(
            "a toast about an update needs the whole chain",
            "hidden",
            KitStates.resolve(KitComponent.toast, inputs("""{"services":["update"],"toast":{"kind":"update"}}""")).state,
        )
    }

    @Test
    fun aLoadingStateWaitsOutTheDelayEvenForAFractionalElapsedTime() {
        fun devices(elapsed: String) =
            KitStates.resolve(KitComponent.devices, inputs("""{"loading":true$elapsed}"""))
        assertTrue(devices(""","elapsedMs":100.5""").copy.isEmpty())
        assertTrue(devices(""","elapsedMs":249""").copy.isEmpty())
        assertEquals(listOf("devices.title", "common.loading"), devices(""","elapsedMs":250""").copy.map { it.key })
        assertEquals(listOf("devices.title", "common.loading"), devices("").copy.map { it.key })
    }

    @Test
    fun theMonogramIsTheFirstWholeCharacter() {
        fun monogram(name: String) = KitIdentity.resolve(
            KitInputs.of(mapOf("integrator" to JsonObject(mapOf("name" to JsonPrimitive(name))))),
        ).monogram
        assertEquals("T", monogram("Tidewater"))
        assertEquals("H", monogram("  harbor audio"))
        assertEquals("🎮", monogram("🎮 Arcade"))
        assertEquals("?", KitIdentity.resolve(inputs("""{"bundle":{"slug":" "}}""")).monogram)
    }

    @Test
    fun aTvDefaultsToTheDarkScheme() {
        val tv = inputs("""{"platform":{"os":"android","formFactor":"tv"}}""")
        assertEquals(KitColorScheme.dark, KitIdentity.theme(tv, KitKind.compose).colorScheme)
        assertEquals(KitColorScheme.light, KitIdentity.theme(tv, KitKind.compose, colorScheme = KitColorScheme.light).colorScheme)
        assertEquals(KitColorScheme.system, KitIdentity.theme(inputs("{}"), KitKind.compose).colorScheme)
        assertEquals(KitColorScheme.dark, KitIdentity.theme(inputs("{}"), KitKind.godot).colorScheme)
    }

    @Test
    fun onlyHttpsAndLoopbackLinksAreUsable() {
        assertEquals("https://polaris.locker/device", KitLinks.valid("https://polaris.locker/device"))
        assertEquals("http://localhost:8080/cb", KitLinks.valid("http://localhost:8080/cb"))
        assertEquals("http://127.0.0.1:9/cb", KitLinks.valid("http://127.0.0.1:9/cb"))
        assertNull(KitLinks.valid("http://example.com/"))
        assertNull(KitLinks.valid("javascript:alert(1)"))
        assertNull(KitLinks.valid("https://"))
        assertNull(KitLinks.valid(" not a url"))
        assertNull(KitLinks.valid(null))
    }
}
