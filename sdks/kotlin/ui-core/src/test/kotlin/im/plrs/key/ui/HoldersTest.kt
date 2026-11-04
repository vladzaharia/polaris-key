// @pkey-feature ui.kit.holders
//
// The holders family's pure parts (UK-43.7): the maskEmail vectors from the corpus's holdersFlow
// section, the reason lines, the lead-in split and the portal / app choice for Add. The rows
// themselves run in UIMatrixPresentationTest.holdersFamily.
package im.plrs.key.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class HoldersTest {
    private val matrix: JsonObject = run {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui-core's test task" }
        Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject
    }

    @Test
    fun maskEmailMatchesEveryCorpusVector() {
        val vectors = requireNotNull(matrix.obj("holdersFlow").array("maskEmail")).objects()
        assertTrue(vectors.size >= 10)
        for (vector in vectors) {
            val email = vector["email"].let { if (it is JsonNull) null else it.string() }
            assertEquals("mask of $email", vector.string("masked"), KitFormat.maskEmail(email))
        }
    }

    @Test
    fun maskEmailKeepsAWholeFirstCodePoint() {
        assertEquals("😀•••@example.com", KitFormat.maskEmail("😀x@example.com"))
    }

    @Test
    fun reasonsFollowIdentityAndSync() {
        assertEquals(listOf("activate.recommend.portal"), recommendReasons(identity = false, sync = true))
        assertEquals(
            listOf("activate.recommend.recover", "activate.recommend.devices"),
            recommendReasons(identity = true, sync = false),
        )
        assertEquals("activate.recommend.sync", recommendReasons(identity = true, sync = true).first())
    }

    @Test
    fun leadPartsSplitOnTheMarkers() {
        val copy = KitCopy.bundled
        assertEquals(
            listOf(LeadPart("Cloud Sync", true), LeadPart(": saves follow you", false)),
            copy.leadParts("**Cloud Sync**: saves follow you"),
        )
        assertEquals(listOf(LeadPart("plain", false)), copy.leadParts("plain"))
        assertEquals(emptyList<LeadPart>(), copy.leadParts(""))
    }

    @Test
    fun addInPortalDecidesWhichControlAddUses() {
        val base = mapOf<String, JsonElement>(
            "activateDone" to JsonObject(mapOf("tier" to JsonPrimitive("Pro"))),
        )
        val app = KitStates.resolve(KitComponent.activateDone, KitInputs.of(base))
        assertTrue(app.shows("activate.recommend.action"))
        assertFalse(app.shows("signin.key.addInLocker"))
        val portal = KitStates.resolve(
            KitComponent.activateDone,
            KitInputs.of(base + ("licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive(""), "addIn" to JsonPrimitive("portal"))))),
        )
        assertTrue(portal.shows("signin.key.addInLocker"))
        assertTrue(portal.shows("a11y.externalLink"))
        assertEquals(listOf(KitAction.openManageUrl), portal.actions)
    }

    @Test
    fun theMaskedAddressIsTheOnlyFormTheWaitingScreenShows() {
        val inputs = KitInputs.of(
            mapOf(
                "activateDone" to JsonObject(emptyMap()),
                "licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive("maya@example.com"))),
            ),
        )
        val screen = KitStates.resolve(KitComponent.activateDone, inputs)
        assertEquals("waiting", screen.state)
        val line = screen.copy.first { it.key == "activate.waiting" }
        assertEquals(
            "m•••@example.com",
            (line.args["maskedEmail"] as CopyArgument.Text).value,
        )
        assertFalse(screen.copy.any { line -> line.args.values.any { it is CopyArgument.Text && "maya@" in it.value } })
    }

    @Test
    fun aHolderEmailWithIdentityOffDrawsTheReadyStateWithThePortalLine() {
        fun resolve(services: List<String>) = KitStates.resolve(
            KitComponent.activateDone,
            KitInputs.of(
                mapOf(
                    "services" to kotlinx.serialization.json.JsonArray(services.map { JsonPrimitive(it) }),
                    "activateDone" to JsonObject(emptyMap()),
                    "licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive("maya@example.com"))),
                ),
            ),
        )
        assertEquals("waiting", resolve(listOf("license", "identity")).state)
        val off = resolve(listOf("license"))
        assertEquals("ready", off.state)
        assertTrue(off.shows("activate.recommend.portal"))
        assertTrue(off.shows("signin.key.addInLocker"))
        assertTrue(off.shows("a11y.externalLink"))
        assertFalse(off.shows("activate.waiting"))
        assertFalse(off.shows("activate.waitingSignIn"))
        assertFalse(off.copy.any { line -> line.args.containsKey("maskedEmail") })
    }
}
