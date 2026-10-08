// @pkey-feature core.sync license.entitlements license.deactivate license.gate
//
// SP-51: the client's licence state is live. Every transition is emitted (an activation, a deactivation,
// a server revoke seen by a sync that moved no ETag), `entitlementValue()` and `entitlements()` obey the
// gate, the §5 re-acquire cannot become a request storm, concurrent syncs share one pass, and
// `listDevices()` says when it is offline.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveStateTest {
    private val signer = TestSigner()
    private val now = 1_700_000_000L

    /** A scripted Worker whose licence can be revoked: the document then answers 401, as does the token route. */
    private class Server(val signer: TestSigner, val now: Long) {
        @Volatile var revoked = false
        @Volatile var rosterFails = false
        val tokenRequests = AtomicInteger()
        val documentRequests = AtomicInteger()

        fun transport() = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/license/activate" -> respond(200, """{"token":"pkeyt_live","schemaVersion":4}""")
                "/djdl/license/token" -> {
                    tokenRequests.incrementAndGet()
                    respond(401, """{"error":{"code":"unauthorized"}}""")
                }
                "/djdl/license/document" -> {
                    documentRequests.incrementAndGet()
                    if (revoked) {
                        respond(401, """{"error":{"code":"unauthorized"}}""")
                    } else {
                        val device = r.headers["X-PKey-Device"] ?: r.headers["x-pkey-device"] ?: "dev-live"
                        respond(200, signer.licenseDoc("djdl", device, now, mapOf("pro" to JsonPrimitive(true), "seats" to JsonPrimitive(3))), mapOf("etag" to "\"v1\""))
                    }
                }
                "/djdl/devices" -> if (rosterFails) respond(503, "{}") else respond(200, """{"devices":[]}""")
                else -> respond(200, """{"ok":true}""")
            }
        }
    }

    private fun client(server: Server, store: InMemoryStore = InMemoryStore("djdl", "dev-live")) = PolarisKeyClient(
        PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = store, transport = server.transport(), clock = { now }, expectedServices = listOf(ServiceSlug.license),
            ),
            license = LicenseClientOptions(fingerprint = false),
        ),
    )

    @Test
    fun deactivateAndAServerRevokeEachEmitWithinOneTick() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        val seen = java.util.concurrent.CopyOnWriteArrayList<LicenseState>()
        val collector = async(kotlinx.coroutines.Dispatchers.Unconfined) { c.licenseChanges.collect { seen += it } }
        assertTrue(c.activate("pkey_djdl_x") is ActivationResult.Ok)
        assertEquals(LicenseStatus.ok, seen.last().status)

        // A server revoke: the document 401s with no ETag movement; the next sync still says so.
        server.revoked = true
        val before = seen.size
        c.sync(force = true)
        withTimeout(1_000) { while (seen.size == before) delay(5) }
        assertEquals(LicenseStatus.revoked, seen.last().status)
        assertEquals(LicenseStatus.revoked, c.licenseState.value?.status)
        // The same state again is not re-emitted.
        val after = seen.size
        c.sync(force = true)
        delay(100)
        assertEquals(after, seen.size)

        // Deactivation: another transition.
        c.deactivate()
        withTimeout(1_000) { while (seen.size == after) delay(5) }
        assertEquals(LicenseStatus.needsActivation, seen.last().status)
        collector.cancel()
    }

    @Test
    fun aRevokedDeviceHasNoEntitlements() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        c.activate("pkey_djdl_x")
        assertEquals(JsonPrimitive(3), c.license.entitlementValue("seats"))
        assertEquals(setOf("pro", "seats"), c.license.entitlements().keys)
        server.revoked = true
        c.sync(force = true)
        assertNull(c.license.entitlementValue("seats"))
        assertTrue(c.license.entitlements().isEmpty())
        assertTrue(!c.license.isEntitled("pro"))
        // licenseInfo stays the diagnostic: the last verified document is still readable.
        assertNotNull(c.license.licenseInfo())
    }

    @Test
    fun aRejectedTokenIsAskedAboutOnceNotInAStorm() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        c.activate("pkey_djdl_x")
        server.revoked = true
        repeat(40) { c.sync(force = true) }
        assertTrue("token requests: ${server.tokenRequests.get()}", server.tokenRequests.get() <= 5)
        assertEquals(1, server.tokenRequests.get())
    }

    @Test
    fun concurrentSyncsShareOnePass() = runBlocking {
        val server = Server(signer, now)
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val slow = ScriptedTransport { r ->
            if (r.path == "/djdl/license/document") {
                server.documentRequests.incrementAndGet()
                runBlocking { gate.await() }
                respond(304, headers = mapOf("etag" to "\"v1\""))
            } else {
                respond(200, """{"token":"pkeyt_live","schemaVersion":4}""")
            }
        }
        val store = InMemoryStore("djdl", "dev-live").also { it.setToken("pkeyt_live") }
        val c = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, transport = slow, clock = { now }, expectedServices = listOf(ServiceSlug.license),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
        val calls = (1..5).map { async(kotlinx.coroutines.Dispatchers.Default) { c.sync() } }
        delay(200)
        gate.complete(Unit)
        calls.forEach { it.await() }
        assertEquals(1, server.documentRequests.get())
    }

    @Test
    fun overlappingPassesNeverLeaveTheStateStaleAtLicensed() = runBlocking {
        repeat(20) {
            val server = Server(signer, now)
            val c = client(server)
            c.activate("pkey_djdl_x")
            server.revoked = true
            val passes = (0 until 12).map { i ->
                async(kotlinx.coroutines.Dispatchers.Default) { if (i % 3 == 0) c.sync(force = true) else c.sync() }
            }
            passes.forEach { it.await() }
            assertEquals(LicenseStatus.revoked, c.status().status)
            assertEquals(LicenseStatus.revoked, c.licenseState.value?.status)
        }
    }

    @Test
    fun aPublishQueuedBehindTheLockNeverEmitsAStaleLicensedState() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        c.activate("pkey_djdl_x")
        val seen = java.util.concurrent.CopyOnWriteArrayList<LicenseState>()
        val collector = async(kotlinx.coroutines.Dispatchers.Unconfined) { c.licenseChanges.collect { seen += it } }
        // Hold the publish lock, as a slow concurrent pass would.
        val field = PolarisKeyClient::class.java.getDeclaredField("publishLock").apply { isAccessible = true }
        val lock = field.get(c) as kotlinx.coroutines.sync.Mutex
        lock.lock()
        try {
            // A forced publish (a second activation's) queues behind it while the licence is still ok...
            val first = async(kotlinx.coroutines.Dispatchers.Default) { c.activate("pkey_djdl_x") }
            delay(500)
            // ...then the server revokes, and a forced sync learns it (its publish queues too).
            server.revoked = true
            val second = async(kotlinx.coroutines.Dispatchers.Default) { c.sync(force = true) }
            withTimeout(5_000) { while (c.status().status != LicenseStatus.revoked) delay(10) }
            lock.unlock()
            first.await()
            second.await()
        } catch (e: Throwable) {
            if (lock.isLocked) lock.unlock()
            throw e
        }
        delay(100)
        collector.cancel()
        assertTrue("emissions: ${seen.map { it.status }}", seen.isNotEmpty())
        assertEquals("emissions: ${seen.map { it.status }}", LicenseStatus.revoked, seen.first().status)
        assertEquals(LicenseStatus.revoked, c.licenseState.value?.status)
    }

    @Test
    fun deactivatingThroughTheLicenseClientIsPublishedToo() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        val seen = java.util.concurrent.CopyOnWriteArrayList<LicenseState>()
        val collector = async(kotlinx.coroutines.Dispatchers.Unconfined) { c.licenseChanges.collect { seen += it } }
        c.activate("pkey_djdl_x")
        assertEquals(LicenseStatus.ok, c.licenseState.value?.status)
        c.license.deactivate()
        withTimeout(1_000) { while (seen.last().status == LicenseStatus.ok) delay(5) }
        assertEquals(LicenseStatus.needsActivation, seen.last().status)
        assertEquals(LicenseStatus.needsActivation, c.licenseState.value?.status)
        collector.cancel()
    }

    @Test
    fun aRevokedInstallListsNoChannelsBeyondStable() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        c.activate("pkey_djdl_x")
        server.revoked = true
        c.sync(force = true)
        assertEquals(listOf("stable"), c.license.entitledChannels())
    }

    @Test
    fun listDevicesSaysWhenItIsOffline() = runBlocking {
        val server = Server(signer, now)
        val c = client(server)
        c.activate("pkey_djdl_x")
        server.rosterFails = true
        val devices = c.listDevices()
        assertEquals(1, devices.size)
        assertTrue(devices.single().offline)
    }
}
