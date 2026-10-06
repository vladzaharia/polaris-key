// @pkey-feature update.check update.decide update.driver
//
// The update client's own surface (P6-08): `check()` (`GET /<p>/update/version`, the token when held,
// a 403's wire code, `updateAvailable` by Core's Semver), the options refusals (`invalid-options`
// for a pkd1- kid, a release key that is also a trust pin, a method, platform or outlet outside the
// vocabularies), `not-configured` without pinned release keys, `service-unavailable` without the
// Update service, the build URL from discovery, and the JVM install driver's typed `runtime` N/A.
// The signed decision end to end is the transcripts' (TranscriptTest).

package im.plrs.key.update

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UpdateClientTest {
    private val product = TestSigner("pkey-test-prod")
    private val release = TestSigner("djdl-release")

    private fun core(transport: ScriptedTransport, services: List<ServiceSlug> = listOf(ServiceSlug.release, ServiceSlug.distribution, ServiceSlug.update)) = CoreContext(
        CoreOptions(
            baseUrl = "https://key.plrs.im", productSlug = "djdl", version = "1.2.0", pinnedKeys = product.trust,
            store = InMemoryStore("djdl"), transport = transport, expectedServices = services, trustRefresh = false,
        ),
    )

    private suspend fun refused(code: String, body: suspend () -> Unit) {
        try {
            body()
        } catch (e: PolarisException) {
            assertEquals(e.message, code, e.code)
            return
        }
        fail("expected $code")
    }

    @Test
    fun checkReadsTheNewestBuild() = runBlocking {
        val transport = ScriptedTransport {
            if (it.path == "/djdl/update/version") ScriptedTransport.respond(200, """{"version":"1.3.0","tag":"v1.3.0","url":"https://example.com/1.3.0"}""")
            else ScriptedTransport.respond(404)
        }
        val c = core(transport)
        c.start()
        c.setToken("pkeyt_abc")
        val v = UpdateClient(c).check(channel = "beta")
        assertEquals("1.3.0", v.version)
        assertTrue(v.updateAvailable)
        val req = transport.requests().single()
        assertTrue(req.url.endsWith("/djdl/update/version?channel=beta"))
        assertEquals("Bearer pkeyt_abc", req.headers["authorization"])
    }

    @Test
    fun checkReportsA403sCodeAndRefusesWithoutTheUpdateService() = runBlocking {
        val forbidden = core(ScriptedTransport { ScriptedTransport.respond(403, """{"error":{"code":"channel_not_allowed"}}""") })
        forbidden.start()
        refused("channel_not_allowed") { UpdateClient(forbidden).check() }
        val noUpdate = core(ScriptedTransport { fail("no request may be made"); ScriptedTransport.respond(500) }, services = listOf(ServiceSlug.release))
        noUpdate.start()
        refused(ErrorCode.serviceUnavailable) { UpdateClient(noUpdate).check() }
    }

    @Test
    fun optionsAreValidatedAtConstruction() = runBlocking {
        val c = core(ScriptedTransport { ScriptedTransport.respond(404) })
        refused(ErrorCode.invalidOptions) { UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = mapOf("pkd1-" + "a".repeat(64) to release.publicKey))) }
        refused(ErrorCode.invalidOptions) { UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = mapOf("release" to product.publicKey))) }
        refused(ErrorCode.invalidOptions) { UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, methods = listOf("teleport"))) }
        refused(ErrorCode.invalidOptions) { UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, platform = "amiga")) }
        refused(ErrorCode.invalidOptions) { UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, outlet = HostOutlet.Kind("epic"))) }
        val ok = UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, outlet = HostOutlet.Kind("play"), platform = "android", arch = "arm64"))
        assertEquals("play", ok.outlet()?.kind)
        assertNull(ok.detected())
    }

    @Test
    fun decideNeedsPinnedReleaseKeys() = runBlocking {
        val c = core(ScriptedTransport { ScriptedTransport.respond(404) })
        c.start()
        refused(ErrorCode.notConfigured) { UpdateClient(c).decide() }
        refused(ErrorCode.notConfigured) { UpdateClient(c).releaseRecord("0".repeat(64)) }
    }

    @Test
    fun detectionFallsToTheStampWithoutSignals() = runBlocking {
        val c = core(ScriptedTransport { ScriptedTransport.respond(404) })
        val u = UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, stamp = im.plrs.key.core.OutletStamp("direct", "direct")))
        assertEquals("direct", u.outlet()?.kind)
        val none = UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust))
        assertEquals("unknown", none.outlet()?.kind)
    }

    @Test
    fun theDefaultDriverIsTheDesktopDriverOnTheJvm() = runBlocking {
        val c = core(ScriptedTransport { ScriptedTransport.respond(404) })
        val check = UpdateCheck("stable", UpdateDecision.None("up-to-date", false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        // UK-40: left at the default marker, a JVM desktop installs through DesktopInstallDriver.
        assertEquals(InstallResult.NothingToInstall, UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust)).install(check))
        // The marker itself, called directly (an Android build without :android), is the typed N/A.
        try {
            JvmInstallDriver.install(check)
            fail("the marker installs nothing")
        } catch (e: UnsupportedException) {
            assertEquals(UnsupportedReason.runtime, e.unsupported.reason)
            assertEquals("update.driver", e.unsupported.feature)
        }
        // A host-supplied driver (Android's are P6-12's) is called.
        var called = false
        val driven = UpdateClient(c, UpdateClientOptions(pinnedReleaseKeys = release.trust, installDriver = { called = true; InstallResult.Started }))
        assertEquals(InstallResult.Started, driven.install(check))
        assertTrue(called)
        assertFalse(called.not())
    }
}
