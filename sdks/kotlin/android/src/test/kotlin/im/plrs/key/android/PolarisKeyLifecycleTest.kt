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
                        productSlug = "diceroll",
                        version = "1.0.0",
                        pinnedKeys = signer.trust,
                        trustRefresh = false,
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
        val until = System.currentTimeMillis() + 3_000
        while (syncs == 0 && System.currentTimeMillis() < until) Thread.sleep(10)
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
        val until2 = System.currentTimeMillis() + 3_000
        while (syncs < 2 && System.currentTimeMillis() < until2) Thread.sleep(10)
        assertEquals(2, syncs)
        lifecycle.onActivityDestroyed(a)
        assertNull(lifecycle.currentActivity())
        client.close()
    }
}

/** U-07.K10: Cloud Sync's lifecycle flush (Q-5, no WorkManager) and its state under the no-backup directory (Q-6). */
@RunWith(RobolectricTestRunner::class)
class PolarisKeyLifecycleCloudSyncTest {
    private val signer = TestSigner()
    private val ctx: android.content.Context = androidx.test.core.app.ApplicationProvider.getApplicationContext()
    private val pushes = java.util.concurrent.atomic.AtomicInteger()

    private val pull =
        """{"encryption":"server","subject":"ps_AliceAliceAliceAlice1","cursor":1,"more":false,"serverNow":${System.currentTimeMillis()},""" +
            """"catalogVersion":1,"lastMutationId":0,"changes":[],"tombstones":[],"aliases":{},""" +
            """"usage":{"bytes":0,"settings":0,"records":0,"files":0},"quota":{"bytes":268435456,"files":true}}"""

    private fun handle(r: im.plrs.key.core.PolarisRequest) = when {
        r.path.endsWith("/.well-known/polaris.json") -> respond(
            200,
            """{"product":"diceroll","services":{"license":{"enabled":true},"config":{"enabled":true},"sync":{"enabled":true,"encryption":"server"},""" +
                """"identity":{"enabled":true,"account":true,"endpoints":{"subject":"https://key.example/diceroll/identity/subject"}}}}""",
        )

        r.path.endsWith("/identity/subject") -> respond(200, """{"subject":"ps_AliceAliceAliceAlice1"}""")

        r.path.endsWith("/sync/ops") -> {
            pushes.incrementAndGet()
            respond(200, pull.replace(""""changes":[""", """"results":[],"changes":["""))
        }

        r.path.contains("/sync") -> respond(200, pull)

        else -> respond(404)
    }

    @Test
    fun theLastActivityStoppingFlushesBoundedAndTheStateLivesUnderNoBackup() {
        val mirror = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"schemaVersion":1,"entries":[{"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}}]}""",
        ) as kotlinx.serialization.json.JsonObject
        // The Keystore store itself cannot run under Robolectric; its state directory is checked directly, and the
        // client runs on a file store at that very directory (the Keystore store's files and Cloud Sync's share it).
        val noBackup = java.io.File(ctx.noBackupFilesDir, "pkey/diceroll")
        assertEquals(noBackup.canonicalPath, AndroidKeystoreStore(ctx, "diceroll").stateDirectory.canonicalPath)
        val client = PolarisKeyAndroid.client(
            ctx,
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "diceroll",
                    baseUrl = "https://key.example",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = im.plrs.key.core.FileStore("diceroll", noBackup),
                    transport = ScriptedTransport(::handle),
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.identity, ServiceSlug.sync),
                ),
                license = LicenseClientOptions(fingerprint = false),
                cloudSync = im.plrs.key.sdk.CloudSyncHostOptions().also {
                    it.encryption = "server"
                    it.catalog = mirror
                },
            ),
        )
        runBlocking {
            client.core.store.setToken("pkeyt_alice")
            client.identity.subject()
            // Wait for the real precondition, not just "not Local": the machine is signed in and its first pull is
            // done (Idle, nothing waiting). Until then `config.set` quietly takes the local-only path (no machine
            // owns the key yet) and there is nothing for the last stop to push, which is what a slow runner showed.
            val end = System.currentTimeMillis() + 8_000
            while (client.cloudSync.status().let { it.state != im.plrs.key.core.sync.SyncState.Idle || it.pending != 0 } && System.currentTimeMillis() < end) Thread.sleep(20)
            val ready = client.cloudSync.status()
            assertEquals("the machine is signed in and idle before the edit: $ready", im.plrs.key.core.sync.SyncState.Idle, ready.state)
            client.config.set("audio.volume", kotlinx.serialization.json.JsonPrimitive(0.3))
            val edited = client.cloudSync.status()
            assertEquals("the machine took the edit (not the local-only path): $edited", 1, edited.pending)
        }
        val lifecycle = PolarisKeyLifecycle(60, { 1_000L }, CoroutineScope(Dispatchers.Default))
        lifecycle.attach(client)
        val a = Robolectric.buildActivity(Activity::class.java).create().get()
        lifecycle.onActivityStarted(a)
        assertEquals("nothing is flushed while the app is in the foreground", 0, pushes.get())
        lifecycle.onActivityStopped(a)
        val end = System.currentTimeMillis() + 8_000
        while (pushes.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(20)
        assertTrue("the last stop pushed the edit; status ${runBlocking { client.cloudSync.status() }}", pushes.get() > 0)
        assertTrue(PolarisKeyLifecycle.BACKGROUND_FLUSH_MILLIS <= 10_000)
        // The state file sits beside the Keystore store's files: noBackupFilesDir, never backed up.
        assertTrue(java.io.File(noBackup, im.plrs.key.sdk.CLOUD_SYNC_FILE).exists())
        client.close()
    }
}
