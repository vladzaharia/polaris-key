// @pkey-feature devices.report update.bootguard
//
// The update-health journal (notes/SDK-PARITY-PASS.md §3.13; P6-03): every entry is one the
// Worker's allowlist keeps (W/core/updateHealth.ts boundedEntry), a report carries at most 16 and
// marks them sent, the queue keeps the newest 64, an offer seen on every launch is journaled once,
// and the journal survives a restart in its own file beside the token store.

package im.plrs.key.core

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateEventJournalTest {
    private fun journal(slot: StateSlot = MemoryStateSlot()) =
        UpdateEventJournal(slot) { 1_700_000_000L }.also { it.context = { "play" to "beta" } }

    @Test
    fun anEntryIsWhatTheWorkerKeeps() {
        val j = journal()
        val e = j.record(UpdateEvent.updateApplied, "1.2.0", fromRelease = "1.1.0", code = "ok code!")!!
        assertEquals(UpdateEvent.updateApplied, e.event)
        assertEquals("app", e.deliverable)
        assertEquals("play", e.outlet)
        assertEquals("beta", e.channel)
        assertEquals(1_700_000_000L, e.at)
        assertEquals("okcode", e.code)
        assertTrue(Regex("^[A-Za-z0-9._:-]{1,64}$").matches(e.eventId))
        // Round-trips through the Worker's own validation.
        assertEquals(e, UpdateEventEntry.from(e.json))
        // An unknown event, or a deliverable outside the alphabet, is never queued.
        assertNull(j.record("update_exploded", "1.0.0"))
        assertNull(j.record(UpdateEvent.packFailed, "1.0.0", deliverable = "Bad Pack"))
        // The same release as fromRelease is dropped (it names no move).
        assertNull(j.record(UpdateEvent.updateConfirmed, "2.0.0", fromRelease = "2.0.0")!!.fromRelease)
    }

    @Test
    fun anUnknownOutletOrBadChannelIsNormalised() {
        val j = UpdateEventJournal(MemoryStateSlot()) { 5 }.also { it.context = { null to "Not A Channel" } }
        val e = j.record(UpdateEvent.updateOffered, "1.0.0")!!
        assertEquals(OUTLET_UNKNOWN, e.outlet)
        assertEquals(CHANNEL_STABLE, e.channel)
    }

    @Test
    fun aReportCarriesSixteenAndMarksThemSent() {
        val j = journal()
        repeat(20) { j.record(UpdateEvent.updateDownloaded, "1.0.$it") }
        val pending = j.pending()
        assertEquals(MAX_UPDATE_EVENTS, pending.size)
        assertEquals("1.0.0", pending.first().release)
        j.markSent(pending.map { it.eventId })
        assertEquals(listOf("1.0.16", "1.0.17", "1.0.18", "1.0.19"), j.pending().map { it.release })
    }

    @Test
    fun theQueueKeepsTheNewest() {
        val j = journal()
        repeat(UpdateEventJournal.MAX_JOURNAL + 5) { j.record(UpdateEvent.updateDownloaded, "1.0.$it") }
        val events = j.events()
        assertEquals(UpdateEventJournal.MAX_JOURNAL, events.size)
        assertEquals("1.0.5", events.first().release)
    }

    @Test
    fun anOfferIsJournaledOncePerRelease() {
        val j = journal()
        assertNotNull(j.recordOnce(UpdateEvent.updateOffered, "1.1.0", fromRelease = "1.0.0"))
        assertNull(j.recordOnce(UpdateEvent.updateOffered, "1.1.0", fromRelease = "1.0.0"))
        // Even after the first one was reported.
        j.markSent(j.pending().map { it.eventId })
        assertNull(j.recordOnce(UpdateEvent.updateOffered, "1.1.0", fromRelease = "1.0.0"))
        assertNotNull(j.recordOnce(UpdateEvent.updateOffered, "1.2.0", fromRelease = "1.0.0"))
    }

    @Test
    fun theJournalSurvivesARestartBesideTheStore() {
        val dir = Files.createTempDirectory("pkey-journal").toFile()
        try {
            val store = FileStore("djdl", dir)
            assertEquals(dir, store.stateDirectory)
            val slot = FileStateSlot(java.io.File(store.stateDirectory, "update-events.json"))
            journal(slot).record(UpdateEvent.bootRolledBack, "1.1.0", code = "failed-boots")
            val reloaded = journal(FileStateSlot(java.io.File(dir, "update-events.json")))
            assertEquals(listOf(UpdateEvent.bootRolledBack), reloaded.events().map { it.event })
            // A damaged file is an empty journal, never an error.
            java.io.File(dir, "update-events.json").writeText("{not json")
            assertTrue(reloaded.events().isEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun theCoreContextJournalsBesideAFileStore() {
        val dir = Files.createTempDirectory("pkey-core").toFile()
        try {
            val core = CoreContext(
                CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), store = FileStore("djdl", dir), transport = NoNetworkTransport),
            )
            core.updateEvents.record(UpdateEvent.updateConfirmed, "1.0.0", fromRelease = "0.9.0")
            assertTrue(java.io.File(dir, "update-events.json").isFile)
            assertEquals("stable", core.updateEvents.events().single().channel)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aReleaseIsNamedByItsTagElseItsVersion() {
        // The Worker counts an event only under Release's releaseId (W/core/updateHealth.ts): the
        // record's tag when it names one, else the version, as Godot's PKeyUpdater.release_id.
        assertEquals("v1.4.0", releaseId("1.4.0", "v1.4.0"))
        assertEquals("1.4.0", releaseId("1.4.0", null))
        assertEquals("1.4.0", releaseId("1.4.0", ""))
        val store = UpdateDecision.Store(DecisionRelease("1.4.0", 14), null, false, false, false)
        val check = UpdateCheck("stable", store, UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.network, emptyList(), releaseTag = "v1.4.0")
        assertEquals("v1.4.0", check.releaseId)
        assertEquals("1.4.0", check.copy(releaseTag = null).releaseId)
        assertNull(check.copy(decision = UpdateDecision.None("up-to-date", false, false)).releaseId)
        // The tag is not part of the wire UpdateCheck.
        assertEquals(check.copy(releaseTag = null).json, check.json)
    }
}
