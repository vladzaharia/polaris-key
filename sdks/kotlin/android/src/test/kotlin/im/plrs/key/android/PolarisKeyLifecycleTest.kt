// @pkey-feature core.sync
package im.plrs.key.android

import android.app.Activity
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** SP-K08: the current activity, and a throttled sync each time the app comes to the foreground. */
@RunWith(RobolectricTestRunner::class)
class PolarisKeyLifecycleTest {
    private val signer = TestSigner()

    @Test
    fun foregroundSyncsAreThrottledAndTheActivityIsTracked() {
        var syncs = 0
        val client = runBlocking {
            PolarisKeyClient.create(
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "diceroll", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                        store = InMemoryStore("diceroll", "dev1").also { it.setToken("pkeyt_held") },
                        expectedServices = listOf(ServiceSlug.license),
                        transport = ScriptedTransport { r ->
                            if (r.path == "/diceroll/license/document") syncs++
                            respond(404)
                        },
                    ),
                    license = LicenseClientOptions(fingerprint = false),
                ),
            )
        }
        var now = 1_000L
        val lifecycle = PolarisKeyLifecycle(60, { now }, CoroutineScope(Dispatchers.Unconfined))
        lifecycle.attach(client)

        val a = Robolectric.buildActivity(Activity::class.java).create().get()
        assertNull(lifecycle.currentActivity())
        lifecycle.onActivityStarted(a)
        lifecycle.onActivityResumed(a)
        assertSame(a, lifecycle.currentActivity())
        assertTrue(lifecycle.inForeground)
        assertEquals("the first foreground syncs", 1, syncs)

        // A second activity starting is not a new foreground.
        val b = Robolectric.buildActivity(Activity::class.java).create().get()
        lifecycle.onActivityStarted(b)
        assertEquals(1, syncs)
        lifecycle.onActivityStopped(b)
        lifecycle.onActivityStopped(a)
        assertFalse(lifecycle.inForeground)

        // Back within the throttle: no sync. After it: one.
        now += 30
        lifecycle.onActivityStarted(a)
        assertEquals(1, syncs)
        lifecycle.onActivityStopped(a)
        now += 60
        // Syncs are de-duplicated while one runs (SP-51): let the first foreground pass finish.
        Thread.sleep(500)
        lifecycle.onActivityStarted(a)
        assertEquals(2, syncs)
        lifecycle.onActivityDestroyed(a)
        assertNull(lifecycle.currentActivity())
        client.close()
    }
}
