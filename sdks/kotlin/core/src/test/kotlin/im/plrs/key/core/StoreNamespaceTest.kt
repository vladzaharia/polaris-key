// @pkey-feature core.store
//
// A local control plane is a separate authority: it must not reuse the production token, device
// identity, cache or unsigned state merely because the product slug is the same.

package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class StoreNamespaceTest {
    @Test
    fun productionNamesStayStableAndOtherOriginsAreDistinct() {
        assertEquals("tidewater", storeNamespace("tidewater", "https://key.plrs.im"))
        assertEquals("tidewater", storeNamespace("tidewater", "https://KEY.PLRS.IM:443/"))
        assertEquals("tidewater@localhost_8787", storeNamespace("tidewater", "http://localhost:8787"))
        assertEquals("tidewater@localhost_8788", storeNamespace("tidewater", "http://localhost:8788"))
    }

    @Test
    fun defaultStoresUseTheOriginNamespace() {
        val production = CoreContext(
            CoreOptions(productSlug = "tidewater", version = "1.0.0", pinnedKeys = emptyMap(), transport = NoNetworkTransport),
        )
        val development = CoreContext(
            CoreOptions(productSlug = "tidewater", baseUrl = "http://localhost:8787", version = "1.0.0", pinnedKeys = emptyMap(), transport = NoNetworkTransport),
        )

        assertEquals("tidewater", production.storageNamespace)
        assertEquals("tidewater@localhost_8787", development.storageNamespace)
        assertEquals("tidewater", (production.store as FileStore).productSlug)
        assertEquals("tidewater@localhost_8787", (development.store as FileStore).productSlug)
        assertNotEquals((production.store as FileStore).directory, (development.store as FileStore).directory)
    }
}
