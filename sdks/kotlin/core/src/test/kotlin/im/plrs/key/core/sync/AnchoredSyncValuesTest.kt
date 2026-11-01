// @pkey-feature sync.scenarios
//
// Sync value validators match the whole string: a trailing line break or control character is refused.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Test

class AnchoredSyncValuesTest {
    private val tails = listOf("\n", "\r", "\u0000")

    @Test
    fun hlcRefusesTrailingControlCharacters() {
        SyncValues.parseHlc("0000000000ab:0001")
        for (tail in tails) {
            assertTrue(runCatching { SyncValues.parseHlc("0000000000ab:0001$tail") }.isFailure)
        }
    }

    @Test
    fun clientIdRefusesTrailingControlCharacters() {
        for (tail in tails) {
            val empty = JsonObject(emptyMap())
            val opts = CloudSyncOptions("demo", empty, empty, 1L) { "c_000000000000000client1$tail" }
            val core = MachineCore(opts, MachineState(null, LinkedHashMap()))
            assertTrue(runCatching { core.freshClientId() }.isFailure)
        }
    }
}
