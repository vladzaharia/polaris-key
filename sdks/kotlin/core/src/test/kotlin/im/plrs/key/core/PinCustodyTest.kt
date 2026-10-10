// @pkey-feature core.cache core.bundle core.sync
//
// Host custody of the wire-v4 key rules (the verdicts themselves are the corpus's): a pinned key's
// tombstone is persisted as signed evidence in the same write as the manifest that proved it, is
// re-derived on every load, and survives a deactivation and a device-id re-binding; the signer
// retry order; the offline bundle is stored as its own signed JWS (the old `importedBundle`
// marker is gone, never read), activation re-derives from it, a byte-identical re-import writes
// nothing, and each inner document must be newer than the cached one of its type.
//
// The artifacts are the corpus's own vectors, so nothing here is signed by the test.

package im.plrs.key.core

import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PinCustodyTest {
    private val cases = (JsonText.parse(File(System.getProperty("pkey.repoRoot"), "conformance/corpus/v2/cases.json").readText()) as JsonObject)

    private fun case(family: String, id: String): JsonObject =
        cases[family]!!.arrayValue!!.map { it as JsonObject }.first { it["id"].stringValue == id }

    private fun map(e: kotlinx.serialization.json.JsonElement?): Map<String, String> =
        e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    private val PIN = "pkey-test-prod-2026"

    /** A store that counts the cache writes it receives. */
    private class CountingStore(private val inner: InMemoryStore) : Store by inner {
        val writes = AtomicInteger()
        override suspend fun writeCache(record: CacheRecord) {
            writes.incrementAndGet()
            inner.writeCache(record)
        }
    }

    private fun core(store: Store, c: JsonObject, now: Long, transport: PolarisTransport = NoNetworkTransport) = CoreContext(
        CoreOptions(
            productSlug = "djdl", version = "1.0.0", pinnedKeys = map(c["pinned"]), store = store,
            transport = transport, clock = { now }, expectedServices = listOf(ServiceSlug.license),
        ),
    )

    // ── B4: the tombstone is evidence, written with the manifest, re-derived on load ───────────
    @Test
    fun aRefreshThatTombstonesAPinWritesTheManifestAsItsEvidenceInTheSameWrite() = runBlocking {
        val c = case("trustCases", "pin-revoked-by-other-pin")
        val jws = c["manifestJws"].stringValue!!
        val store = InMemoryStore("djdl", "dev1")
        store.setToken("pkeyt_held")
        val core = core(store, c, c["now"].longValue!!, ScriptedTransport { r -> if (r.path.endsWith("polaris-trust.jws")) respond(200, jws) else respond(404) })
        core.start()
        assertTrue(core.refreshTrust())
        assertEquals(listOf(PIN), core.revokedPins())
        assertEquals(jws, store.readCache()!!.trustJws)
        assertEquals(mapOf(PIN to jws), store.readCache()!!.pinRevocations)
        // A restart reaches the same state from the record alone.
        val fresh = core(store, c, c["now"].longValue!!)
        fresh.start()
        assertEquals(listOf(PIN), fresh.revokedPins())
        assertEquals(map((c["expect"] as JsonObject)["trust"]), fresh.trust())
    }

    @Test
    fun evidenceThatNoLongerVerifiesIsDroppedAndAForgedTombstoneIsNotHonoured() = runBlocking {
        val c = case("trustCases", "pin-revocation-sticky")
        val evidence = map(c["pinRevocations"])
        val store = InMemoryStore("djdl", "dev1")
        store.writeCache(CacheRecord(pinRevocations = evidence + (PIN to evidence.getValue(PIN).dropLast(2) + "AA")))
        val core = core(store, c, c["now"].longValue!!)
        core.start()
        assertEquals(emptyList<String>(), core.revokedPins())
        assertTrue(core.trust().containsKey(PIN))
        core.setToken("pkeyt_x")
        core.clearAll()
        assertNull(store.readCache()?.pinRevocations?.get(PIN))
    }

    @Test
    fun aTombstoneSurvivesADeactivationAndIsInEveryRewrite() = runBlocking {
        val c = case("trustCases", "pin-revocation-sticky")
        val store = InMemoryStore("djdl", "dev1")
        store.setToken("pkeyt_held")
        val evidence = map(c["pinRevocations"])
        store.writeCache(CacheRecord(pinRevocations = evidence, trustJws = c["manifestJws"].stringValue))
        val core = core(store, c, c["now"].longValue!!)
        core.start()
        assertEquals(listOf(PIN), core.revokedPins())
        core.clearAll()
        val after = store.readCache()!!
        assertEquals(evidence, after.pinRevocations)
        assertNull(after.trustJws)
        assertEquals(listOf(PIN), core.revokedPins())
        assertTrue(!core.trust().containsKey(PIN))
    }

    // ── B9: a device-id re-binding keeps the evidence, drops the grant keys, and the old marker ─
    @Test
    fun aDeviceIdRebindingKeepsPinEvidenceAndDropsTheBundle() = runBlocking {
        val c = case("bundleCases", "bundle-valid-full")
        val t = case("trustCases", "pin-revocation-sticky")
        val inner = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        val store = object : Store by inner {
            override suspend fun anchoredDeviceId(): String = "anchored-elsewhere"
            override suspend fun replaceDeviceId(id: String) = inner.replaceDeviceId(id)
        }
        inner.writeCache(
            CacheRecord(
                trustJws = t["manifestJws"].stringValue, bundle = c["bundleJws"].stringValue,
                docs = mapOf(DocumentSlice.license to "l.l.l"), pinRevocations = map(t["pinRevocations"]),
            ),
        )
        core(store, t, t["now"].longValue!!).start()
        val kept = inner.readCache()!!
        assertEquals(map(t["pinRevocations"]), kept.pinRevocations)
        assertNull(kept.bundle)
        assertNull(kept.trustJws)
        assertTrue(kept.docs.isEmpty())
    }

    // ── B5: the signer retry order ────────────────────────────────────────────────────────────
    @Test
    fun theSignerRetryAsksEachUsablePinInByteOrderAtMostTheLimit() {
        val usable = (1..6).associate { "k$it" to "x" }
        assertEquals(emptyList<String>(), trustSignerOrder(usable, "k3"))
        assertEquals(listOf("k1", "k2", "k3", "k4").take(MAX_TRUST_SIGNER_ATTEMPTS), trustSignerOrder(usable, "other"))
        assertEquals(MAX_TRUST_SIGNER_ATTEMPTS, trustSignerOrder(usable, null).size)
        assertEquals(listOf("B", "a", "é"), trustSignerOrder(mapOf("é" to "x", "a" to "x", "B" to "x"), null))
    }

    @Test
    fun aRefreshRefusedForItsSignerAsksEachUsablePinForItsOwnSignature() = runBlocking {
        // Pins {ALT} only; the default manifest is signed by PIN (refused); ?signer=ALT is accepted.
        val c = case("trustCases", "pin-revoked-by-other-pin")
        val refused = c["manifestJws"].stringValue!! // signed by ALT, whose key is not a pin here
        val onlyPin = c.toMutableMap().also { it["pinned"] = JsonObject(mapOf(PIN to (c["pinned"] as JsonObject)[PIN]!!)) }.let { JsonObject(it) }
        val seen = ArrayList<String>()
        val store = InMemoryStore("djdl", "dev1")
        store.setToken("pkeyt_held")
        val core = core(store, onlyPin, c["now"].longValue!!, ScriptedTransport { r -> seen += r.url.substringAfter("polaris-trust.jws"); respond(200, refused) })
        core.start()
        assertTrue(!core.refreshTrust())
        assertEquals(listOf("", "?signer=$PIN"), seen)
    }

    // ── B7/B8: the bundle is its own signed record; activation re-derives; floors; re-import ───
    private suspend fun importedCore(store: Store, c: JsonObject): CoreContext {
        val core = core(store, c, c["now"].longValue!!)
        core.start()
        core.importBundle(c["bundleJws"].stringValue!!)
        return core
    }

    @Test
    fun anImportStoresTheBundleVerbatimAndActivationIsReDerivedOnRestart() = runBlocking {
        val c = case("bundleCases", "bundle-valid-full")
        val inner = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        val core = importedCore(inner, c)
        val record = inner.readCache()!!
        assertEquals(c["bundleJws"].stringValue, record.bundle)
        assertTrue(!record.toJson().toString().contains("importedBundle"))
        assertTrue(core.cache().bundle!!.activates)
        assertEquals(LicenseStatus.ok, core.licenseStatus().status)
        // A restart re-verifies the bundle on the reload profile, far past its import window.
        val later = core(inner, c, c["now"].longValue!! + 200L * 86_400)
        later.start()
        assertTrue(later.cache().bundle!!.activates)
        assertTrue(later.licenseStatus().status != LicenseStatus.needsActivation)
    }

    @Test
    fun theOldImportedBundleMarkerIsNeverReadAndGrantsNothing() = runBlocking {
        val c = case("bundleCases", "bundle-valid-full")
        val text = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        // A record with only the marker and the cached documents, as an older SDK wrote it.
        val json = """{"v":3,"docs":{"license":"${c["bundleJws"].stringValue}"},"importedBundle":{"bundleId":"01J","importedAt":1700000000}}"""
        val record = CacheRecord.fromJson(JsonText.parse(json))!!
        assertNull(record.bundle)
        text.writeCache(record)
        val core = core(text, c, c["now"].longValue!!)
        core.start()
        assertNull(core.cache().bundle)
        assertEquals(LicenseStatus.needsActivation, core.licenseStatus().status)
    }

    @Test
    fun aByteIdenticalReImportWritesNothingAndANewerFloorBlocksAnOlderBundle() = runBlocking {
        val c = case("bundleCases", "bundle-valid-full")
        val store = CountingStore(InMemoryStore("djdl", c["deviceId"].stringValue!!))
        val core = importedCore(store, c)
        val writes = store.writes.get()
        val result = core.importBundle(c["bundleJws"].stringValue!!)
        assertEquals(writes, store.writes.get())
        assertEquals(listOf(DocumentSlice.license, DocumentSlice.config), result.imported)
        // Another bundle whose documents are not newer than the cached ones is refused whole.
        val stale = case("bundleCases", "bundle-valid-license-only")
        try {
            core.importBundle(stale["bundleJws"].stringValue!!)
            fail("an inner document that is not newer than the cached one must be refused")
        } catch (e: PolarisException) {
            assertEquals("inner-doc-rejected", e.code)
        }
        assertEquals(writes, store.writes.get())
    }

    @Test
    fun evidenceThatDoesNotVerifyIsNotCarriedThroughAnImport() = runBlocking {
        val c = case("bundleCases", "bundle-valid-full")
        val t = case("trustCases", "pin-revocation-sticky")
        val evidence = map(t["pinRevocations"])
        val pins = map(c["pinned"])
        val inner = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        // The evidence is signed by a key this install does not pin: dropped on load, not carried.
        inner.writeCache(CacheRecord(pinRevocations = evidence))
        val core = CoreContext(
            CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = pins, store = inner, transport = NoNetworkTransport, clock = { c["now"].longValue!! }),
        )
        core.start()
        core.importBundle(c["bundleJws"].stringValue!!)
        assertEquals(emptyMap<String, String>(), inner.readCache()!!.pinRevocations)
    }
}
