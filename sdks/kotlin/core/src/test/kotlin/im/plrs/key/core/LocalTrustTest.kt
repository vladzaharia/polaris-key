// @pkey-feature core.cache core.sync license.gate
//
// No UNSIGNED input may loosen the gate.
//
//   - a hard 401 deletes the document it answered for and a 403 build block deletes the
//          licence document, in the write that sets the (display-only) hint; so clearing the hint
//          in the plain-JSON record hands back no usable document
//   - the licence gate is the build's own declaration OR discovery's: unsigned discovery can
//          switch it on, never off
//   - a stored device id that disagrees with the platform anchor is discarded with the token
//          and the grant slices; the update slices stay; anchor probes run by absolute path
//   - the trust manifest is verified at the effective clock

package im.plrs.key.core

import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalTrustTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val licenseJws = signer.licenseDoc("djdl", "dev1", now)

    private fun core(
        store: Store,
        expected: List<ServiceSlug>? = null,
        handler: (im.plrs.key.core.PolarisRequest) -> PolarisResponse,
    ) = CoreContext(
        CoreOptions(
            productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
            store = store, transport = ScriptedTransport(handler), clock = { now }, expectedServices = expected,
        ),
    )

    /** A store holding a token and a verified licence document with its ETag. */
    private suspend fun seeded(): InMemoryStore {
        val store = InMemoryStore("djdl", "dev1")
        store.setToken("pkeyt_held")
        store.writeCache(
            CacheRecord(
                docs = mapOf(DocumentSlice.license to licenseJws),
                etags = mapOf(DocumentSlice.license to "\"e1\""),
            ),
        )
        return store
    }

    /** What an attacker with write access to the plain-JSON record does: clears both hints. */
    private fun withoutHints(r: CacheRecord) = r.copy(lastSyncUnauthorized = null, blocked = null)

    private suspend fun reloadedStatus(store: Store, record: CacheRecord): LicenseStatus {
        store.writeCache(record)
        val fresh = core(store) { respond(404) }
        fresh.start()
        return fresh.licenseStatus().status
    }

    @Test
    fun aHard401DeletesTheDocumentItAnsweredFor() = runBlocking {
        val store = seeded()
        val core = core(store) { r -> if (r.path == "/djdl/license/document") respond(401) else respond(404) }
        core.start()
        assertEquals(LicenseStatus.ok, core.licenseStatus().status)

        val result = core.sync()
        assertTrue(result.unauthorized)
        // The gate still reports the revocation, and nothing grants.
        assertEquals(LicenseStatus.revoked, core.licenseStatus().status)
        assertNull(core.cache().license)
        val written = store.readCache()!!
        assertTrue(written.lastSyncUnauthorized == true)
        assertNull(written.docs[DocumentSlice.license])
        assertNull(written.etags[DocumentSlice.license])
        // Deleting the hint from the record yields needs-activation, never a usable document.
        assertEquals(LicenseStatus.needsActivation, reloadedStatus(store, withoutHints(written)))
    }

    @Test
    fun a403BuildBlockDeletesTheLicenceDocument() = runBlocking {
        val store = seeded()
        val body = """{"error":{"code":"version_blocked","reason":"version-too-old"},"allowedRange":{"min":"2.0.0"}}"""
        val core = core(store) { r -> if (r.path == "/djdl/license/document") respond(403, body) else respond(404) }
        core.start()

        val result = core.sync()
        assertTrue(result.blocked)
        assertEquals(LicenseStatus.versionTooOld, core.licenseStatus().status)
        val written = store.readCache()!!
        assertNotNull(written.blocked)
        assertNull(written.docs[DocumentSlice.license])
        assertNull(written.etags[DocumentSlice.license])
        assertEquals(LicenseStatus.needsActivation, reloadedStatus(store, withoutHints(written)))
    }

    private fun discovery(licenseEnabled: Boolean) =
        """{"product":"djdl","services":{"license":{"enabled":$licenseEnabled},"config":{"enabled":true}}}"""

    @Test
    fun unsignedDiscoveryCannotSwitchTheLicenceGateOff() = runBlocking {
        val store = seeded()
        val core = core(store) { r -> if (r.path.endsWith("/polaris.json")) respond(200, discovery(false)) else respond(404) }
        core.start()
        assertEquals(LicenseStatus.ok, core.licenseStatus().status)
        core.discover()
        // Sub-client availability follows discovery (D-21) ...
        assertEquals(false, core.enabled(ServiceSlug.license))
        // ... the gate does not.
        assertEquals(LicenseStatus.ok, core.licenseStatus().status)
        assertTrue(core.licenseGateEnabled())
    }

    @Test
    fun aConfigOnlyBuildDeclaresItsGateOffAndDiscoveryCanSwitchItOn() = runBlocking {
        val store = seeded()
        val core = core(store, expected = listOf(ServiceSlug.config)) { r ->
            if (r.path.endsWith("/polaris.json")) respond(200, discovery(true)) else respond(404)
        }
        core.start()
        assertEquals(LicenseStatus.notApplicable, core.licenseStatus().status)
        core.discover()
        assertNotNull(core.discoveryDocument())
        assertEquals(LicenseStatus.ok, core.licenseStatus().status)
    }

    // ── device binding ───────────────────────────────────────────────────────────────────────

    /** A desktop-style store whose anchor-derived id is [anchored]; the stored id starts as [stored]. */
    private class AnchoredStore(private val inner: InMemoryStore, stored: String, private val anchored: String?) : Store by inner {
        var id = stored
        override suspend fun getDeviceId(): String = id
        override suspend fun anchoredDeviceId(): String? = anchored
        override suspend fun replaceDeviceId(id: String) {
            this.id = id
        }
    }

    @Test
    fun aStoredIdThatDisagreesWithTheAnchorIsDiscardedWithTheGrant() = runBlocking {
        val inner = InMemoryStore("djdl", "unused")
        inner.setToken("pkeyt_copied")
        inner.writeCache(
            CacheRecord(
                trustJws = "t.t.t",
                docs = mapOf(DocumentSlice.license to licenseJws),
                etags = mapOf(DocumentSlice.license to "\"e1\""),
                feeds = mapOf("stable" to "f.f.f"),
                releaseRecords = mapOf("ab" to "r.r.r"),
                lastSyncUnauthorized = true,
            ),
        )
        val store = AnchoredStore(inner, stored = "dev1", anchored = "ANCHOREDDEVICEID000000000000000A")
        val core = core(store) { respond(404) }
        core.start()

        assertEquals("ANCHOREDDEVICEID000000000000000A", core.deviceId())
        assertEquals("ANCHOREDDEVICEID000000000000000A", store.id)
        assertNull(core.token())
        assertNull(inner.getToken())
        assertNull(core.cache().license)
        assertEquals(LicenseStatus.needsActivation, core.licenseStatus().status)
        val kept = inner.readCache()!!
        assertTrue(kept.docs.isEmpty())
        assertNull(kept.trustJws)
        // The update slices survive: a floor a deactivation could reset could be rolled back.
        assertEquals(mapOf("stable" to "f.f.f"), kept.feeds)
        assertEquals(mapOf("ab" to "r.r.r"), kept.releaseRecords)
    }

    @Test
    fun aMatchingOrAbsentAnchorKeepsTheStoredIdAndToken() = runBlocking {
        for (anchored in listOf("dev1", null)) {
            val inner = seeded()
            val store = AnchoredStore(inner, stored = "dev1", anchored = anchored)
            val core = core(store) { respond(404) }
            core.start()
            assertEquals("dev1", core.deviceId())
            assertEquals("pkeyt_held", core.token())
            assertEquals(LicenseStatus.ok, core.licenseStatus().status)
        }
    }

    @Test
    fun anchorProbesRunByAbsolutePath() {
        val ran = ArrayList<List<String>>()
        val mac = DeviceId.anchor(os = "Mac OS X", run = { ran += it; "    | \"IOPlatformUUID\" = \"AAAA-BBBB\"\n" })
        assertEquals("AAAA-BBBB", mac)
        assertEquals("/usr/sbin/ioreg", ran.single().first())

        ran.clear()
        val win = DeviceId.anchor(
            os = "Windows 11", systemRoot = "C:\\Windows",
            run = { ran += it; "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    1234-abcd\n" },
        )
        assertEquals("1234-abcd", win)
        assertEquals("C:\\Windows\\System32\\reg.exe", ran.single().first())

        // No SystemRoot: no probe by a bare name through PATH.
        ran.clear()
        assertNull(DeviceId.anchor(os = "Windows 11", systemRoot = null, run = { ran += it; "x" }))
        assertTrue(ran.isEmpty())
    }

    // ── effective clock ──────────────────────────────────────────────────────────────────────

    private fun trustManifest(issuedAt: Long, expiresAt: Long): String = signer.sign(
        "pkey-trust+jws",
        buildJsonObject {
            put("schemaVersion", 1)
            put("aud", "djdl")
            put("iss", "key.plrs.im")
            put("issuedAt", issuedAt)
            put("expiresAt", expiresAt)
            put("jwksUrl", "https://key.plrs.im/djdl/.well-known/jwks.json")
            put("cacheSeconds", 300)
            putJsonArray("keys") {
                add(
                    buildJsonObject {
                        put("kid", signer.kid)
                        put("alg", "EdDSA")
                        put("kty", "OKP")
                        put("crv", "Ed25519")
                        put("publicKey", signer.publicKey)
                        put("status", "active")
                    },
                )
            }
        },
    )

    @Test
    fun theTrustManifestIsVerifiedAtTheEffectiveClock() = runBlocking {
        // A licence issued 30 days ahead of a system clock that was wound back raises the floor; a
        // trust manifest that expired before that floor must not verify against the bare system clock.
        val future = now + 30 * 86_400
        val store = InMemoryStore("djdl", "dev1")
        store.setToken("pkeyt_held")
        store.writeCache(CacheRecord(docs = mapOf(DocumentSlice.license to signer.licenseDoc("djdl", "dev1", future))))
        val manifest = trustManifest(issuedAt = now, expiresAt = now + 300)
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = true,
                store = store, clock = { now },
                transport = ScriptedTransport { r ->
                    if (r.path.endsWith("polaris-trust.jws")) respond(200, manifest) else respond(404)
                },
            ),
        )
        core.start()
        assertEquals(future, core.highWaterMark())
        assertEquals(false, core.refreshTrust())
    }
}
