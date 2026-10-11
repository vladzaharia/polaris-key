package im.plrs.key.ui

import im.plrs.key.packs.PackProgress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Progress reduction and subscription do not need a renderer. */
class PolarisPackProgressStateTest {
    @Test
    fun foldsEventsInFirstReportedOrder() {
        var ui = PolarisPackProgressUi()
        ui = ui.reduce(PackProgress("base", "download", 10, 100))
        ui = ui.reduce(PackProgress("dlc", "download", 0, 300))
        ui = ui.reduce(PackProgress("base", "apply", 100, 100))
        ui = ui.reduce(PackProgress("x", "mystery", 1, 1))

        assertEquals(listOf("base", "dlc"), ui.packs.map { it.packId })
        assertEquals(PolarisPackRow.Phase.Installing, ui.packs[0].phase)
        assertEquals(0.25f, ui.fraction)
        assertFalse(ui.complete)

        ui = ui.reduce(PackProgress("base", "done", 100, 100))
            .reduce(PackProgress("dlc", "done", 300, 300))
        assertTrue(ui.complete)
        assertEquals(1f, ui.fraction)

        val issue = ui.reduce(PackProgress("dlc", "state-issue", 0, 0, issue = "torn"))
        assertEquals(PolarisPackRow.Phase.Issue, issue.packs[1].phase)
        assertNull(issue.packs[1].fraction)
    }

    @Test
    fun subscribesAndUnsubscribes() {
        var listener: ((PackProgress) -> Unit)? = null
        var unsubscribed = false
        val state = PolarisPackProgressState { next ->
            listener = next
            { unsubscribed = true }
        }

        state.start()
        listener!!(PackProgress("base", "download", 5, 10))
        assertEquals(0.5f, state.ui.value.fraction)
        state.stop()
        assertTrue(unsubscribed)
    }
}
