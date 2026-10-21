// @pkey-feature packs.state
//
// B-144: below Android API 26 there is no java.nio.file, so the packs facet answers a typed
// UnsupportedException (reason `runtime`) instead of a NoClassDefFoundError escaping the SDK.

package im.plrs.key.packs

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PacksRuntimeSupportTest {
    private val original = packsRuntimeHasNioFile

    @After
    fun restore() {
        packsRuntimeHasNioFile = original
    }

    private fun client(): PacksClient {
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0",
                pinnedKeys = mapOf("k" to "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"),
                store = InMemoryStore("djdl"),
            ),
        )
        return PacksClient(core, emptyMap())
    }

    @Test
    fun aRuntimeWithoutNioFileAnswersTheTypedUnsupportedResult() = runBlocking {
        packsRuntimeHasNioFile = { false }
        try {
            client().state()
            fail("the facet started without java.nio.file")
        } catch (e: UnsupportedException) {
            assertEquals(ErrorCode.unsupported, e.code)
            assertEquals(Feature.packsState, e.unsupported.feature)
            assertEquals(UnsupportedReason.runtime, e.unsupported.reason)
            assertTrue(e.unsupported.detail.contains("API 26"))
        }
    }

    @Test
    fun aJvmHasNioFile() {
        assertTrue(original())
    }
}
