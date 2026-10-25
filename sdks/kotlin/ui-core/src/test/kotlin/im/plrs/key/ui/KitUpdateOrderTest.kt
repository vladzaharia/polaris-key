// @pkey-feature ui.update
package im.plrs.key.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** UI-KITS.md 4.3 UpdatePrompt: while downloading, Restart when ready leads and Later follows; the bar reads the fraction. */
class KitUpdateOrderTest {
    private fun inputs(text: String): KitInputs = KitInputs.fromJson(Json.parseToJsonElement(text) as JsonObject)

    private val downloading = inputs("""{"update":{"action":"binary","version":"2.5.0","progress":{"phase":"download","fraction":0.4}}}""")

    @Test
    fun restartWhenReadyComesBeforeLaterWhileDownloading() {
        val screen = KitStates.resolve(KitComponent.updatePrompt, downloading)
        assertEquals("downloading", screen.state)
        val keys = screen.copy.map { it.key }
        assertTrue(keys.indexOf("update.restartWhenReady") in 0 until keys.indexOf("update.later"))
    }

    @Test
    fun theRowDataCarriesTheDownloadFraction() {
        assertEquals(0.4f, KitRowData.from(downloading).progress)
        val counted = inputs("""{"update":{"action":"binary","progress":{"phase":"download","bytes":25,"totalBytes":100}}}""")
        assertEquals(0.25f, KitRowData.from(counted).progress)
        assertNull(KitRowData.from(inputs("""{"update":{"action":"none"}}""")).progress)
    }
}
