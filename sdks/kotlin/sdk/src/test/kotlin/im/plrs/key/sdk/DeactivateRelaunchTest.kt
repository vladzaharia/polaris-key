// @pkey-feature identity.autosignin identity.restore
//
// DB-7: deactivate() sets the explicit sign-out flag a sign-out sets, so after the app relaunches over the
// same state directory the automatic sign-in ladder stays quiet (no restore, no provider call).

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.FileStore
import im.plrs.key.core.TokenSource
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.identity.AutoSignInOptions
import im.plrs.key.identity.AutoSignInReason
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.IdentityClient
import im.plrs.key.identity.PlatformIdentityProvider
import im.plrs.key.identity.PlatformSubjectToken
import im.plrs.key.license.LicenseClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class DeactivateRelaunchTest {
    private val signer = TestSigner()

    private class CountingProvider : PlatformIdentityProvider {
        var calls = 0
        override val kind: ExchangeKind = ExchangeKind.google
        override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            calls++
            return null
        }
        override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            calls++
            return null
        }
        override suspend fun signOutCleanup() {
            // This provider holds no session of its own to clean up.
        }
        override suspend fun credentialRevoked(): Boolean = false
    }

    private fun launch(dir: java.io.File) = CoreContext(
        CoreOptions(
            productSlug = "djdl",
            version = "1.0.0",
            pinnedKeys = signer.trust,
            trustRefresh = false,
            store = FileStore("djdl", dir),
            transport = ScriptedTransport { respond(404) },
            clock = { 1_700_000_000L },
            deviceName = "Test Device",
        ),
    )

    private suspend fun ladder(core: CoreContext): Pair<AutoSignInResult, CountingProvider> {
        val provider = CountingProvider()
        return IdentityClient(core).autoSignIn(AutoSignInOptions(provider = provider)) to provider
    }

    @Test
    fun aLaunchAfterDeactivateDoesNotSignInSilently() = runBlocking {
        val dir = Files.createTempDirectory("pkey-deactivate-ladder").toFile().also { it.deleteOnExit() }
        val first = launch(dir).also { it.start() }
        first.setToken("pkeyt_held", TokenSource.signin, personInitiated = true)
        LicenseClient(first).deactivate()

        val (result, provider) = ladder(launch(dir).also { it.start() })
        assertEquals(AutoSignInReason.SignedOut, (result as AutoSignInResult.NeedsSignIn).reason)
        assertEquals("no provider rung ran", 0, provider.calls)
    }

    @Test
    fun withoutDeactivateTheSameLaunchReachesTheProviderRungs() = runBlocking {
        val dir = Files.createTempDirectory("pkey-no-deactivate").toFile().also { it.deleteOnExit() }
        launch(dir).also { it.start() }.setToken("pkeyt_held", TokenSource.signin, personInitiated = true)
        val (result, _) = ladder(launch(dir).also { it.start() })
        // The control: only the flag differs, and the ladder is not "signed out".
        assertTrue(result !is AutoSignInResult.NeedsSignIn || result.reason != AutoSignInReason.SignedOut)
    }
}
