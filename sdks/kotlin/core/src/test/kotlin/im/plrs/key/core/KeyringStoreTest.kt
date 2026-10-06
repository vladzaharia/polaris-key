// @pkey-feature core.store
//
// The JVM desktop OS keyring store (UK-40, SP-K12): the storage contract (token, device id and
// cache round-trip, clear, status) and Python's KeyringStore fallback rules (P1b-09, R4-11) over a
// scripted backend, the store-aware `supports(core.store)`, and the same contract against the REAL
// OS keyring (Keychain, Credential Manager, Secret Service) when PKEY_KEYRING_TESTS=1, which the
// kotlin-desktop CI matrix sets on macOS, Windows and Linux. On Linux a session with no reachable
// Secret Service skips that test and prints the recorded N/A; on macOS and Windows it must pass.

package im.plrs.key.core

import java.io.File
import java.nio.file.Files
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** A scripted keyring: a map, with switches for every failure mode. */
class FakeKeyring : KeyringBackend {
    val entries = LinkedHashMap<Pair<String, String>, String>()
    var unavailableReason: String? = null
    var failReads = false
    var failWrites = false
    var failDeletes = false
    /** A write that "succeeds" but stores something else (Python's mismatched read-back). */
    var corruptWrites = false
    var deletes = 0

    override fun unavailable(): String? = unavailableReason

    override fun get(service: String, account: String): String? {
        if (failReads) throw KeyringException("read refused")
        return entries[service to account]
    }

    override fun set(service: String, account: String, secret: String) {
        if (failWrites) throw KeyringException("write refused")
        entries[service to account] = if (corruptWrites) "$secret-corrupt" else secret
    }

    override fun delete(service: String, account: String) {
        deletes++
        if (failDeletes) throw KeyringException("delete refused")
        entries.remove(service to account)
    }
}

class KeyringStoreTest {
    private fun tempDir(): File = Files.createTempDirectory("pkey-keyring").toFile().also { it.deleteOnExit() }

    private val key = "pkey:demo" to "device-token"

    // ── The storage contract, run against any keyring backend ─────────────────────────────────

    private suspend fun storageContract(store: KeyringStore, dir: File, expectKeyring: Boolean) {
        assertNull("a fresh store holds no token", store.getToken())
        store.setToken("tok-1")
        assertEquals("tok-1", store.getToken())
        store.setToken("tok-2")
        assertEquals("a second write replaces the first", "tok-2", store.getToken())
        assertEquals(expectKeyring, !File(dir, "token").exists())
        val status = store.status()
        if (expectKeyring) assertEquals(StoreStatus(StoreBackend.keyring), status) else assertEquals(StoreBackend.file, status.backend)
        val id = store.getDeviceId()
        assertEquals(32, id.length)
        assertEquals("the device id is stable", id, store.getDeviceId())
        val record = CacheRecord(trustJws = "a.b.c", docs = mapOf(DocumentSlice.license to "d.e.f"))
        store.writeCache(record)
        assertEquals(record, store.readCache())
        store.clearCache()
        assertNull(store.readCache())
        store.clearToken()
        assertNull("a cleared token is gone", store.getToken())
        assertFalse(File(dir, "token").exists())
        assertEquals("clearing the token keeps the device id", id, store.getDeviceId())
    }

    @Test
    fun theContractHoldsOverAHealthyKeyring() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring()
        storageContract(KeyringStore("demo", dir, ring), dir, expectKeyring = true)
        assertTrue("the keyring entry is removed on clear", ring.entries.isEmpty())
    }

    @Test
    fun theContractHoldsWithNoKeyringThroughTheFile() = runTest {
        val dir = tempDir()
        storageContract(KeyringStore("demo", dir, NoKeyring("no keyring here")), dir, expectKeyring = false)
    }

    @Test
    fun theServiceTagIsPkeyProduct() {
        val store = KeyringStore("demo", tempDir(), FakeKeyring())
        assertEquals("pkey:demo", store.service)
        assertEquals("device-token", KeyringStore.ACCOUNT)
    }

    // ── Python's KeyringStore rules (tests/test_store_status.py) ──────────────────────────────

    @Test
    fun noKeyringReportsFileKeyringUnavailableAndNeverWrites() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring().apply { unavailableReason = "java-keyring is not on the classpath" }
        val store = KeyringStore("demo", dir, ring)
        store.setToken("tok")
        assertEquals("tok", store.getToken())
        assertTrue(ring.entries.isEmpty())
        assertEquals(0, ring.deletes)
        assertEquals(
            StoreStatus(StoreBackend.file, StoreStatus.Degraded(StoreDegradedReason.keyringUnavailable, "java-keyring is not on the classpath")),
            store.status(),
        )
    }

    @Test
    fun aHealthyKeyringVerifiedWriteLeavesNoFile() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring()
        val store = KeyringStore("demo", dir, ring)
        store.setToken("tok")
        assertEquals("tok", ring.entries[key])
        assertFalse(File(dir, "token").exists())
        assertEquals(StoreStatus(StoreBackend.keyring), store.status())
    }

    @Test
    fun aRaisingBackendReportsKeyringError() = runTest {
        val ring = FakeKeyring().apply { failReads = true }
        val status = KeyringStore("demo", tempDir(), ring).status()
        assertEquals(StoreBackend.file, status.backend)
        assertEquals(StoreDegradedReason.keyringError, status.degraded?.reason)
        assertEquals("read refused", status.degraded?.detail)
    }

    @Test
    fun aReadBackThatDiffersFallsBackAndDeletesTheEntry() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring().apply { corruptWrites = true }
        val store = KeyringStore("demo", dir, ring)
        store.setToken("tok")
        assertEquals("tok", File(dir, "token").readText())
        assertNull("the unverified entry is deleted", ring.entries[key])
        assertEquals("tok", store.getToken())
    }

    @Test
    fun aFailedWriteFallsBackToTheFileAndStatusSaysSo() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring().apply { failWrites = true }
        val store = KeyringStore("demo", dir, ring)
        store.setToken("tok")
        assertEquals("tok", store.getToken())
        val status = store.status()
        assertEquals(StoreBackend.file, status.backend)
        assertEquals(StoreDegradedReason.keyringError, status.degraded?.reason)
    }

    @Test
    fun aStaleKeyringTokenNeverShadowsANewerFileToken() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring()
        ring.entries[key] = "old"
        val store = KeyringStore("demo", dir, ring)
        FileStore("demo", dir).setToken("new")
        assertEquals("new", store.getToken())
    }

    @Test
    fun aFileStoreTokenMovesIntoTheKeyringOnRead() = runTest {
        val dir = tempDir()
        FileStore("demo", dir).setToken("legacy")
        val ring = FakeKeyring()
        val store = KeyringStore("demo", dir, ring)
        assertEquals("legacy", store.getToken())
        assertEquals("legacy", ring.entries[key])
        assertFalse(File(dir, "token").exists())
        assertEquals(StoreStatus(StoreBackend.keyring), store.status())
        assertEquals("legacy", store.getToken())
    }

    @Test
    fun aFailedWriteThenARecoveredKeyringStillReadsTheFile() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring().apply { failWrites = true }
        val store = KeyringStore("demo", dir, ring)
        store.setToken("tok")
        ring.failWrites = false
        assertEquals("tok", store.getToken())
        assertEquals(StoreStatus(StoreBackend.keyring), store.status())
    }

    @Test
    fun aFallbackWriteDeletesTheKeyringEntry() = runTest {
        val ring = FakeKeyring()
        ring.entries[key] = "older"
        val store = KeyringStore("demo", tempDir(), ring)
        ring.failWrites = true
        store.setToken("newer")
        assertNull(ring.entries[key])
        assertEquals("newer", store.getToken())
    }

    @Test
    fun aFailedFileWriteSurfacesAndNothingIsLost() = runTest {
        val dir = tempDir()
        val ring = FakeKeyring().apply { failWrites = true }
        // A non-empty directory where the token file belongs: the fallback write cannot happen.
        File(dir, "token").mkdirs()
        File(dir, "token/occupied").writeText("x")
        val store = KeyringStore("demo", dir, ring)
        try {
            store.setToken("tok")
            throw AssertionError("a write that lands nowhere must throw")
        } catch (e: StoreException) {
            // Surfaced, never swallowed (R4-12).
        }
    }

    // ── supports(core.store) follows the store ───────────────────────────────────────────────

    @Test
    fun supportsCoreStoreFollowsTheKeyring() {
        val healthy = KeyringStore("demo", tempDir(), FakeKeyring())
        val absent = KeyringStore("demo", tempDir(), NoKeyring("java-keyring is not on the classpath"))
        fun engine(store: Store) = Capabilities.forStore(store).let { Capabilities(it.detectors, runtime = "jvm") }
        assertTrue(engine(healthy).supports(Feature.coreStore, DEFAULT_SERVICES).isSupported)
        val na = engine(absent).supports(Feature.coreStore, DEFAULT_SERVICES) as Support.Unavailable
        assertEquals(UnsupportedReason.dependency, na.unsupported.reason)
        assertEquals("java-keyring is not on the classpath", na.unsupported.detail)
        val file = engine(FileStore("demo", tempDir())).supports(Feature.coreStore, DEFAULT_SERVICES) as Support.Unavailable
        assertEquals(UnsupportedReason.dependency, file.unsupported.reason)
    }

    @Test
    fun javaKeyringNotFoundMessagesAreRecognised() {
        assertTrue(JavaKeyringBackend.isNotFound("No stored credentials match pkey:demo account: device-token"))
        assertTrue(JavaKeyringBackend.isNotFound("Error code 1168"))
        assertTrue(JavaKeyringBackend.isNotFound("No password to delete. No stored credentials match x"))
        assertFalse(JavaKeyringBackend.isNotFound("Error code 5"))
        assertFalse(JavaKeyringBackend.isNotFound(null))
    }

    // ── The real OS keyring ──────────────────────────────────────────────────────────────────

    @Test
    fun theContractHoldsOnTheRealOsKeyring() = runTest {
        assumeTrue("set PKEY_KEYRING_TESTS=1 to run against this machine's OS keyring", System.getenv("PKEY_KEYRING_TESTS") == "1")
        assertTrue("java-keyring is on the test classpath", JavaKeyringBackend.onClasspath)
        val os = System.getProperty("os.name").orEmpty()
        val backend = JavaKeyringBackend()
        val why = backend.unavailable()
        if (why != null && os.startsWith("Linux", true)) {
            println("N/A core.store jvm dependency (Linux, no Secret Service in this session): $why")
            assumeTrue(why, false)
        }
        assertNull("the OS keyring is reachable on $os", why)
        val product = "uk40-test-${UUID.randomUUID().toString().take(8)}"
        val service = "${KeyringStore.KEYRING_SERVICE_PREFIX}$product"
        if (os.startsWith("Linux", true)) {
            // A reachable Secret Service can still refuse (a locked or missing default collection).
            try {
                backend.set(service, "probe", "p")
                backend.delete(service, "probe")
            } catch (e: KeyringException) {
                println("N/A core.store jvm dependency (Linux, Secret Service refused): ${e.message}")
                assumeTrue(e.message, false)
            }
        }
        val dir = tempDir()
        val store = KeyringStore(product, dir, backend)
        try {
            storageContract(store, dir, expectKeyring = true)
            store.setToken("real-token")
            assertEquals("real-token", backend.get(service, KeyringStore.ACCOUNT))
            assertFalse(File(dir, "token").exists())
        } finally {
            store.clearToken()
        }
        assertNull(backend.get(store.service, KeyringStore.ACCOUNT))
    }
}
