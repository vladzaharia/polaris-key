// `pkey sdk --lang kotlin --write` (SDK parity pass §3.19, SP-02). PolarisConfig.kt beside this file
// is what the CLI writes (in package polaris.generated), committed and pinned to the renderer by
// packages/cli/test/sdkConfig.test.ts. Compiling it against :sdk, :core and :update is half the
// proof; this checks the options it builds.

package polaris.generated

import im.plrs.key.core.ServiceSlug
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class PolarisConfigTest {
    @Test
    fun generatedConfigBuildsClientOptions() {
        val options = PolarisConfig.clientOptions(version = "1.2.3")
        assertEquals("acme", options.core.productSlug)
        assertEquals("https://key.plrs.im", options.core.baseUrl)
        assertEquals("1.2.3", options.core.version)
        assertEquals(mapOf("pkey-test-prod-2026" to "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"), options.core.pinnedKeys)
        assertEquals(listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.release, ServiceSlug.update), options.core.expectedServices)
        val update = options.update
        assertNotNull(update)
        assertEquals(PolarisConfig.pinnedReleaseKeys, update!!.pinnedReleaseKeys)
    }
}
