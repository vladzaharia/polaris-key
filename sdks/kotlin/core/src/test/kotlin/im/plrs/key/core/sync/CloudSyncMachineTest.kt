// @pkey-feature sync.scenarios
//
// Machine-level checks beside the corpus (the local half): a JSON null is a value, not "no value"
// (U-06.5), a relaunch keeps the journal, and a sign-in moves a signed-out device edit.

package im.plrs.key.core.sync

import im.plrs.key.core.sync.SyncValues.applySettingOp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudSyncMachineTest {
    private fun options(subject: String?): CloudSyncOptions {
        val ids = ArrayDeque(listOf("c_000000000000000client1", "c_000000000000000client2"))
        val catalog = Json.parseToJsonElement("""{"settings":[{"key":"a.num","route":"synced","scope":"user","policy":"lastWrite"}]}""") as JsonObject
        val doc = Json.parseToJsonElement("""{"values":{"open.key":"doc"}}""") as JsonObject
        return CloudSyncOptions("demo", catalog, doc, 1_760_000_000_000L) { ids.removeFirst() }.also {
            it.contacted = true
            it.subject = subject
            it.encryption = "server"
        }
    }

    @Test
    fun nullIsAValueAndClearIsNot() {
        assertEquals(JsonNull, applySettingOp("lastWrite", JsonPrimitive(1), "set", JsonNull, null))
        assertNull(applySettingOp("lastWrite", JsonPrimitive(1), "clear", null, null))
        assertEquals(JsonPrimitive(2), applySettingOp("lastWrite", null, "set", JsonPrimitive(2), null))
    }

    @Test
    fun nullIsReadBackAndClearFallsToTheDocument() {
        val m = CloudSyncMachine(options("sub_alice"))
        assertEquals(CallResult.Ok, m.set("open.key", JsonNull))
        assertEquals(ReadResult(JsonNull, "pending"), m.get("open.key"))
        m.flush()
        assertEquals(ReadResult(JsonNull, "pending"), m.get("open.key"))
        assertEquals(CallResult.Ok, m.clear("open.key"))
        assertEquals(ReadResult(JsonPrimitive("doc"), "document"), m.get("open.key"))
    }

    @Test
    fun aSignedOutNullSurvivesARelaunch() {
        val opts = options(null)
        var m = CloudSyncMachine(opts)
        m.set("open.key", JsonNull)
        m.flush()
        assertEquals(ReadResult(JsonNull, "device"), m.get("open.key"))
        m = CloudSyncMachine.relaunch(m, opts)
        assertEquals(ReadResult(JsonNull, "device"), m.get("open.key"))
    }

    @Test
    fun aSignInMovesTheDeviceEditIntoTheJournal() {
        val m = CloudSyncMachine(options(null))
        m.set("a.num", JsonPrimitive(3))
        m.flush()
        m.signIn("sub_alice")
        val pending = (m.journal()["sub_alice"] as JsonObject)["pending"].toString()
        assertTrue(pending, pending.contains("\"moved\":true"))
        assertEquals(1, m.status().pending)
    }
}
