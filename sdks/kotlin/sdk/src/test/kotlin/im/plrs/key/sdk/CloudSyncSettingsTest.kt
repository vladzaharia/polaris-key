// @pkey-feature sync.settings
//
// U-07.K9: the Cloud Sync settings API on a real client against a scripted Worker (server mode, so no ring
// root is needed to talk; a root sits in an in-memory storage so the sign-out chain can be observed). A-1
// person change, A-2 offline boot, A-3 the sign-out chain (flush before forget, D-13 failure path), A-4 and
// A-5 a sign-out elsewhere and the vetted sign-in URL, A-6 the one-time import, A-7 the mode, `config` through
// the machine, the recovery-code entry and the typed N/A.

package im.plrs.key.sdk

import im.plrs.key.config.ConfigSource
import im.plrs.key.config.ConfigChange
import im.plrs.key.config.SettingSyncState
import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncEvent
import im.plrs.key.sdk.SyncRootRecord

private const val VOL = "audio.volume"
private const val ALICE = "ps_AliceAliceAliceAlice1"
private const val BOB = "ps_BobBobBobBobBobBobBob1"
private val ROOT = ByteArray(32) { (5 * it + 3).toByte() }
private val RING_ID = "rg_" + "A".repeat(22)

private val mirror: JsonObject = Json.parseToJsonElement(
    """{"schemaVersion":1,"entries":[
      {"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}},
      {"key":"locked.key","kind":"config","managementDefault":"enforced"}]}""",
) as JsonObject

class CloudSyncSettingsTest {
    @get:Rule val tmp = TemporaryFolder()

    private val signer = TestSigner()

    /** What the scripted Worker saw: `push:root=<held>`, in order, with the token each carried. */
    private val log = CopyOnWriteArrayList<String>()
    private val tokens = CopyOnWriteArrayList<String>()

    @Volatile private var who = ALICE

    @Volatile private var discovery = true

    @Volatile private var push403 = false

    @Volatile private var pushChange = ""
    private lateinit var keyringRef: SyncKeyring

    private fun pullBody(sub: String, extra: String = "") =
        """{"encryption":"server","subject":"$sub","cursor":1,"more":false,"serverNow":${System.currentTimeMillis()},""" +
            """"catalogVersion":1,"lastMutationId":0,"changes":[$extra],"tombstones":[],"aliases":{},""" +
            """"usage":{"bytes":0,"settings":0,"records":0,"files":0},"quota":{"bytes":268435456,"files":true}}"""

    private fun handle(r: PolarisRequest): PolarisResponse = when {
        r.path.endsWith("/.well-known/polaris.json") ->
            if (!discovery) {
                respond(503, "")
            } else {
                respond(
                    200,
                    """{"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true},""" +
                        """"sync":{"enabled":true,"encryption":"server"},""" +
                        """"identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity","endpoints":""" +
                        """{"subject":"https://key.example/djdl/identity/subject","signout":"https://key.example/djdl/identity/signout"}}}}""",
                )
            }

        r.path.endsWith("/identity/subject") -> respond(200, """{"subject":"$who"}""")

        r.path.endsWith("/identity/signout") -> {
            log += "signout"
            respond(200, """{"released":false}""")
        }

        r.path.endsWith("/sync/ops") -> {
            log += "push:root=${keyringRef.unlocked}"
            tokens += (r.headers.entries.firstOrNull { it.key.equals("authorization", true) }?.value ?: "")
            if (push403) {
                respond(403, """{"error":{"code":"account_required","signInUrl":"https://evil.example/login"}}""")
            } else {
                val ids = (Json.parseToJsonElement(String(r.body ?: ByteArray(0))) as? JsonObject)
                    ?.get("mutations")?.let { it as? kotlinx.serialization.json.JsonArray }
                    ?.mapNotNull { ((it as? JsonObject)?.get("mutationId") as? JsonPrimitive)?.content }
                    ?: emptyList()
                val results = ids.joinToString(",") { """{"mutationId":$it,"status":"ok","version":2}""" }
                respond(200, pullBody(who, pushChange).replace(""""changes":[""", """"results":[$results],"changes":["""))
            }
        }

        r.path.endsWith("/devices/keyring/recovery") -> respond(204)

        r.path.contains("/sync") -> respond(200, pullBody(who))

        else -> respond(404, """{"error":"not_found"}""")
    }

    /** A root store whose delete fails (a locked keystore). */
    private class LockedStorage(val inner: InMemoryDeviceKeyStorage, var failing: Boolean = true) : DeviceKeyStorage by inner {
        override suspend fun clear() {
            if (failing) throw java.io.IOException("locked")
            inner.clear()
        }
    }

    private inner class Rig(
        val dir: File = tmp.newFolder(),
        val roots: DeviceKeyStorage = InMemoryDeviceKeyStorage(),
        services: List<ServiceSlug> = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.identity, ServiceSlug.sync),
        seedRoot: Boolean = true,
    ) {
        val transport = ScriptedTransport(::handle)
        val client: PolarisKeyClient
        val events = CopyOnWriteArrayList<CloudSyncEvent>()
        val changes = CopyOnWriteArrayList<ConfigChange>()
        val stateFile = File(dir, CLOUD_SYNC_FILE)
        val marker = File(dir, CLOUD_SYNC_IMPORTED_FILE)

        init {
            val store = FileStore("djdl", dir)
            runBlocking { store.setToken("pkeyt_alice") }
            client = runBlocking {
                PolarisKeyClient.create(
                    PolarisKeyClientOptions(
                        core = CoreOptions(
                            productSlug = "djdl",
                            baseUrl = "https://key.example",
                            version = "1.0.0",
                            pinnedKeys = signer.trust,
                            trustRefresh = false,
                            store = store,
                            transport = transport,
                            clock = { 1_700_000_000L },
                            expectedServices = services,
                        ),
                        license = LicenseClientOptions(fingerprint = false),
                        keyring = KeyringOptions(keys = null, rootStorage = roots),
                        cloudSync = CloudSyncHostOptions().also {
                            it.encryption = "server"
                            it.catalog = mirror
                        },
                    ),
                )
            }
            keyringRef = client.keyring
            if (seedRoot) seed()
            client.scope.launch { client.events.collect { e -> if (e is PolarisEvent.CloudSync) events += e.event } }
            client.scope.launch { client.config.changes.collect { changes += it } }
        }

        /** A root of a ring this device pinned, as the key ring stores it. */
        private fun seed() = runBlocking {
            val kid = SyncKeys.deriveKid(ROOT)
            val vault = RingVault(client.core, KeyringOptions(rootStorage = roots))
            vault.save(SyncRootRecord(RING_ID, 1, hex(kid), Base64Url.encode(ROOT)))
            vault.writePin(SyncRingPin(RING_ID, 1, hex(kid)))
            assertTrue(client.keyring.status().unlocked)
        }

        suspend fun signIn(sub: String = ALICE) {
            who = sub
            client.identity.subject()
            eventually("signed in") { client.cloudSync.status().state != SyncState.Local }
        }
    }

    private suspend fun eventually(what: String, timeoutMs: Long = 8_000, cond: suspend () -> Boolean) {
        try {
            withTimeout(timeoutMs) { while (!cond()) delay(20) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            fail("timed out: $what $log")
        }
    }

    private fun json(v: Double) = JsonPrimitive(v)

    // ── A-3 ──────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun signOutFlushesWhileTheRootIsHeldThenForgetsAndPurges() = runBlocking {
        val r = Rig()
        r.signIn()
        r.client.config.set(VOL, json(0.3))
        r.client.identity.signOut()
        // The unsynced edit was pushed, and the root was still there when it was; the push came before the sign-out request.
        val pushes = log.filter { it.startsWith("push") }
        assertTrue(log.toString(), pushes.isNotEmpty())
        assertTrue(pushes.all { it == "push:root=true" })
        assertTrue("flush before the sign-out request: $log", log.indexOfLast { it.startsWith("push") } < log.indexOf("signout"))
        assertFalse("the root is gone", r.client.keyring.unlocked)
        assertFalse("and its stored copy", r.client.keyring.status().rootStored)
        assertFalse("the synced data is purged", r.stateFile.exists())
        assertEquals(SyncState.Local, r.client.cloudSync.status().state)
    }

    @Test
    fun aRingThatCannotForgetStopsTheSignOutBeforeTheWorkerAndNothingIsPurged() = runBlocking {
        val locked = LockedStorage(InMemoryDeviceKeyStorage())
        val r = Rig(roots = locked)
        r.signIn()
        r.client.config.set(VOL, json(0.3))
        try {
            r.client.identity.signOut()
            fail("a root that could not be deleted did not stop the sign-out")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.storeFailed, e.code)
        }
        assertFalse("the Worker was never asked to sign out: $log", log.contains("signout"))
        assertTrue("D-13: nothing is purged", r.stateFile.exists())
        assertNotEquals("D-13: the machine is left as it was", SyncState.Local, r.client.cloudSync.status().state)
        assertEquals("and the person's value is still there", json(0.3), r.client.config.get(VOL, JsonNull))
        assertFalse(r.events.contains(CloudSyncEvent.PurgeFailed))
        // The retry, with the storage healthy again, completes the chain.
        locked.failing = false
        r.client.identity.signOut()
        assertTrue(log.contains("signout"))
        assertFalse(r.stateFile.exists())
    }

    // ── A-1 ──────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun aPersonChangeNeverFlushesUnderTheNewToken() = runBlocking {
        val r = Rig()
        r.signIn()
        r.client.config.set(VOL, json(0.31))
        val before = log.count { it.startsWith("push") }
        // The credential in use becomes Bob's, then the identity says so.
        r.client.core.store.setToken("pkeyt_bob")
        who = BOB
        r.client.identity.subject()
        eventually("alice's value left memory") { r.client.config.get(VOL, JsonNull) != json(0.31) }
        delay(300)
        for (t in tokens.drop(before)) assertNotEquals("nothing of Alice's under Bob's token", "Bearer pkeyt_bob", t)
        assertEquals("nothing of Alice's was sent after the change", before, log.count { it.startsWith("push") })
        assertNotEquals(json(0.31), r.client.config.get(VOL, JsonNull))
    }

    // ── the sign-in window: the subject goes in before the token ───────────────────────────────────

    @Test
    fun aSignInStoresTheSubjectBeforeTheTokenAndRestoresItWhenTheTokenCannotBeStored() = runBlocking {
        val dir = tmp.newFolder()
        val subjectFile = File(dir, "identity-subject")
        val seen = CopyOnWriteArrayList<String>()
        var failing = false
        val inner = FileStore("djdl", dir)
        val store = object : im.plrs.key.core.Store by inner {
            override suspend fun setToken(token: String) {
                seen += subjectFile.takeIf { it.isFile }?.readText()?.trim().orEmpty()
                if (failing) throw im.plrs.key.core.StoreException("disk full")
                inner.setToken(token)
            }
        }
        val core = im.plrs.key.core.CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0", pinnedKeys = signer.trust,
                trustRefresh = false, store = store, transport = ScriptedTransport(::handle),
            ),
        )
        core.setSubject(ALICE)
        assertTrue(core.storeSignIn("pkeyt_bob", BOB, im.plrs.key.core.TokenSource.signin, personInitiated = true))
        assertEquals("the stored subject was already the new person's when the token went in", BOB, seen.last())
        failing = true
        try {
            core.storeSignIn("pkeyt_carol", "ps_CarolCarolCarolCarol1", im.plrs.key.core.TokenSource.signin)
            fail("a token that could not be stored was kept")
        } catch (e: im.plrs.key.core.StoreException) {
            // expected
        }
        assertEquals("the previous subject is back", BOB, core.storedSubject())
    }

    // ── A-2 ──────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun anOfflineBootIsNotASignOut() = runBlocking {
        val dir = tmp.newFolder()
        val roots = InMemoryDeviceKeyStorage()
        val first = Rig(dir = dir, roots = roots)
        first.signIn()
        first.client.config.set(VOL, json(0.4))
        first.client.cloudSync.flush()
        assertTrue(first.stateFile.exists())
        first.client.close()
        // A relaunch: nothing says who is signed in (no identity read yet, and discovery is down).
        File(dir, "identity-subject").delete()
        discovery = false
        val second = Rig(dir = dir, roots = roots, seedRoot = false)
        second.client.cloudSync.flush() // attaches
        assertNotEquals(SyncState.Local, second.client.cloudSync.status().state, "the saved journal still names its person")
        assertTrue("nothing was purged", second.stateFile.exists())
        assertTrue(second.events.none { it is CloudSyncEvent.SignedOut })
        assertEquals(json(0.4), second.client.config.get(VOL, JsonNull))
    }

    private fun assertNotEquals(a: Any?, b: Any?, msg: String) = org.junit.Assert.assertNotEquals(msg, a, b)

    // ── A-4, A-5 ─────────────────────────────────────────────────────────────────────────────────

    @Test
    fun aSignOutElsewhereForgetsOnceAndTheSignInUrlIsVetted() = runBlocking {
        val r = Rig()
        r.signIn()
        push403 = true
        r.client.config.set(VOL, json(0.5))
        r.client.cloudSync.flush()
        eventually("account_required reached the app") { r.events.any { it is CloudSyncEvent.SignedOut && it.reason == "accountRequired" } }
        eventually("offer after the forget") { r.events.any { it is CloudSyncEvent.SignInOffered } }
        val offers = r.events.filterIsInstance<CloudSyncEvent.SignInOffered>()
        assertEquals(1, offers.size)
        assertNull("an off-origin URL is never handed to the app", offers.single().signInUrl)
        assertFalse("the ring was forgotten", r.client.keyring.unlocked)
        assertFalse(r.stateFile.exists())
    }

    @Test
    fun theSignInUrlCheck() {
        val origin = "https://key.example"
        assertEquals("https://key.example/djdl/signin", safeSignInUrl("/djdl/signin", origin))
        assertEquals("https://key.example/x?y=1", safeSignInUrl("https://key.example/x?y=1", origin))
        for (bad in listOf(
            "https://evil.example/x", "http://key.example/x", "//evil.example/x", "https://key.example:8443/x",
            "https://key.example/a b", "https://key.example/\u0000", "https://key.example/\n", "javascript:alert(1)",
            "https://key.example.evil.example/x",
        )) {
            assertNull(bad, safeSignInUrl(bad, origin))
        }
        assertNull(safeSignInUrl(null, origin))
    }

    // ── A-6 and config through the machine ───────────────────────────────────────────────────────

    @Test
    fun localValuesAreOfferedOnceAndTheMarkerIsWrittenAfterSignIn() = runBlocking {
        val r = Rig()
        // Before any person: config.local holds the value.
        r.client.config.set(VOL, json(0.2))
        assertFalse(r.marker.exists())
        r.signIn()
        assertTrue(r.marker.exists())
        assertEquals(json(0.2), r.client.config.get(VOL, JsonNull))
        assertNotEquals(SettingSyncState.local, r.client.config.setting(VOL).sync())
    }

    @Test
    fun settingSyncStatesAndRefusalsInTheMachinesOrder() = runBlocking {
        val r = Rig()
        val handle = r.client.config.setting(VOL)
        assertEquals("no signed-in person", SettingSyncState.local, handle.sync())
        r.signIn()
        handle.set(json(0.6))
        assertEquals(SettingSyncState.pending, handle.sync())
        r.client.cloudSync.flush()
        assertEquals(SettingSyncState.synced, handle.sync())
        // bad_request first, then managed_by_admin
        try {
            handle.set(JsonPrimitive("loud"))
            fail("a value the schema refuses was kept")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.badRequest, e.code)
        }
        // A locked key's clear is a no-op and does not throw; its set is refused.
        r.client.config.setting("locked.key").clear()
        try {
            r.client.config.set("locked.key", JsonPrimitive(1))
            fail("a locked key was written")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.managedByAdmin, e.code)
        }
        assertEquals(ConfigSource.local, r.client.config.getConfigSource(VOL))
    }

    @Test
    fun configChangeOriginIsLocalByDefaultAndRemoteForAChangeAnotherDeviceMade() = runBlocking {
        val r = Rig()
        r.signIn()
        r.client.config.set(VOL, json(0.7))
        eventually("local change") { r.changes.any { it.key == VOL } }
        assertEquals("local", r.changes.last { it.key == VOL }.origin)
        // Another device wrote a key; the next answer brings it.
        pushChange = """{"setting":"remote.only","scope":"user","value":"hi","version":50,"editedHlc":"0000ffffffff:0000"}"""
        r.client.config.set(VOL, json(0.71))
        r.client.cloudSync.flush()
        eventually("remote change") { r.changes.any { it.key == "remote.only" } }
        assertEquals("remote", r.changes.first { it.key == "remote.only" }.origin)
    }

    // ── the recovery-code entry, the typed N/A, the futures ──────────────────────────────────────

    @Test
    fun newRecoveryCodeReachesTheKeyring() = runBlocking {
        val locked = Rig(seedRoot = false)
        try {
            locked.client.cloudSync.recoveryCode.generate()
            fail("a locked ring made a recovery code")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.syncLocked, e.code)
        }
        val held = Rig()
        val code = held.client.cloudSync.newRecoveryCode()
        assertTrue(code.isNotBlank())
        assertFalse("the code is kept nowhere", File(held.dir, CLOUD_SYNC_FILE).exists() && File(held.dir, CLOUD_SYNC_FILE).readText().contains(code))
    }

    @Test
    fun statusIsTheTypedNotApplicableWithoutTheSyncService() = runBlocking {
        val r = Rig(services = listOf(ServiceSlug.license), seedRoot = false)
        try {
            r.client.cloudSync.status()
            fail("status answered without the Sync service")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
            assertNotNull(e.unsupported)
        }
    }

    @Test
    fun theFuturesTwinsAnswerTheSameStatus() = runBlocking {
        val r = Rig()
        r.signIn()
        val pk = PolarisKeyFutures(r.client)
        assertNotEquals(SyncState.Local, pk.statusFuture().get().state)
        assertNotEquals(SyncState.Local, pk.flushFuture().get().state)
    }
}
