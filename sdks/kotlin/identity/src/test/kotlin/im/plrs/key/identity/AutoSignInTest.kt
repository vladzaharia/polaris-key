// @pkey-feature identity.autosignin
//
// The Kotlin automatic sign-in ladder (I-45.2) against a scripted Worker and a fake platform provider:
// rung 1 (a stored session, no network), the JVM desktop (no provider: rung 1, then NeedsSignIn), rung 3
// (silent), rung 4 (the sheet, only with prompt OPTIONAL), every result kind, the explicit-sign-out flag
// (set by signOut, persisted, cleared by an explicit sign-in, silencing rungs 3 and 4), a revoked
// credential, and no secret in a toString.

package im.plrs.key.identity

import im.plrs.key.core.CacheRecord
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.Store
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.TokenSource
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoSignInTest {
    private class DurableMem(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private class FakeProvider(
        var silentToken: String? = "id-token-silent",
        var sheetToken: String? = "id-token-sheet",
        var revoked: Boolean = false,
    ) : PlatformIdentityProvider {
        override val kind = ExchangeKind.google
        var silentCalls = 0
        var sheetCalls = 0
        var cleanups = 0
        var audience: String? = null
        override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            silentCalls++
            audience = serverClientId
            return silentToken?.let { PlatformSubjectToken(it, nonce) }
        }
        override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            sheetCalls++
            return sheetToken?.let { PlatformSubjectToken(it, nonce) }
        }
        override suspend fun signOutCleanup() { cleanups++ }
        override suspend fun credentialRevoked(): Boolean = revoked
    }

    private val grant = "sg_" + "B".repeat(43)
    private val handle = "lh_" + "C".repeat(43)
    private val base = "https://key.plrs.im/djdl/identity"
    private val tokenOk = """{"access_token":"pkeyt_auto","token_type":"Bearer","scope":"profile","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ","issued_token_type":"urn:polaris-key:token-type:device"}"""
    private val consent = """{"status":"confirm","grant":"$grant","expiresIn":300,"consent":{"client":{"appName":"djdl","nameVerified":true},""" +
        """"as":{"provider":"google","email":"a@example.com"},"items":[],"scopeHash":"abc","firstTime":true,"changed":false}}"""
    private val choose = """{"status":"choose","grant":"$grant","expiresIn":300,"choices":{"state":"choose","choices":[{"id":"lic_1","state":"free"}]}}"""
    private val view = """{"state":"choose","choices":[{"id":"lic_1","state":"free"}]}"""

    private val signer = TestSigner()
    private val deviceId = "DEVICE00000000000000000000000001"

    private class World(val client: IdentityClient, val transport: ScriptedTransport, val store: Store, val core: CoreContext)

    private fun world(
        tokenStatus: Int = 200,
        tokenBody: String = tokenOk,
        nonceStatus: Int = 200,
        withLicense: Boolean = false,
        store: Store = InMemoryStore("djdl", deviceId),
        signOutBody: String = """{"released":true}""",
        revokedSignOutStatus: Int = 200,
        provenance: TokenProvenance? = if (withLicense) TokenProvenance.signin else null,
    ): World {
        runBlocking { store.setToken("pkeyt_old") }
        if (withLicense) runBlocking {
            store.writeCache(CacheRecord(docs = mapOf(DocumentSlice.license to signer.licenseDoc("djdl", deviceId, 1_700_000_000L, licenseId = "lic_cached"))))
        }
        var n = 0
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(
                    200,
                    """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"account":true,""" +
                        """"exchange":{"kinds":["google"],"google":{"serverClientId":"1234-web.apps.googleusercontent.com"}},""" +
                        """"endpoints":{"nonce":"$base/nonce","token":"$base/token","signout":"$base/signout","subject":"$base/subject"}}}}""",
                )
                "/djdl/identity/nonce" -> respond(nonceStatus, """{"nonce":"${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"}${n++ % 10}","expiresIn":300}""")
                "/djdl/identity/token" -> respond(tokenStatus, tokenBody)
                "/djdl/identity/signout" -> respond(revokedSignOutStatus, signOutBody)
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = store, transport = transport, clock = { 1_700_000_000L },
            ),
        )
        runBlocking { core.start() }
        if (provenance != null) runBlocking { core.setToken("pkeyt_old", TokenSource.signin, provenance = provenance) }
        val client = IdentityClient(core, deviceKeys = DeviceKeyStore(DurableMem()))
        return World(client, transport, store, core)
    }

    private suspend fun World.paths() = transport.requests().map { it.path }

    @Test
    fun rungOneIsAStoredSessionWithNoNetworkAndNoProviderCall() = runBlocking {
        val w = world(withLicense = true)
        val p = FakeProvider()
        w.client.installPlatformIdentity(p)
        val r = w.client.autoSignIn() as AutoSignInResult.SignedIn
        assertEquals("lic_cached", r.licenseId)
        assertEquals(0, p.silentCalls)
        assertTrue(w.paths().isEmpty())
    }

    @Test
    fun theJvmDesktopHasNoProviderSoRungOneThenNeedsSignIn() = runBlocking {
        val w = world()
        val r = w.client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, r.reason)
        assertNull(r.linkHandle)
        assertTrue(w.paths().isEmpty())
    }

    @Test
    fun rungThreeExchangesTheSilentTokenOverAFreshNonceAndStoresASession() = runBlocking {
        val w = world()
        val p = FakeProvider()
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.SignedIn
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", r.subject)
        assertEquals(1, p.silentCalls)
        assertEquals(0, p.sheetCalls)
        assertEquals("1234-web.apps.googleusercontent.com", p.audience)
        assertEquals("pkeyt_auto", w.store.getToken())
        assertEquals(listOf("/djdl/identity/nonce", "/djdl/identity/token"), w.paths().filter { it.startsWith("/djdl/identity") })
    }

    @Test
    fun promptDefaultsToNeverSoTheSheetNeverRuns() = runBlocking {
        val w = world()
        val p = FakeProvider(silentToken = null)
        assertEquals(AutoSignInPrompt.NEVER, AutoSignInOptions().prompt)
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, r.reason)
        assertEquals(1, p.silentCalls)
        assertEquals(0, p.sheetCalls)
    }

    @Test
    fun promptOptionalRunsTheSheetOnceAfterTheSilentRungFindsNothing() = runBlocking {
        val w = world()
        val p = FakeProvider(silentToken = null)
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p, prompt = AutoSignInPrompt.OPTIONAL))
        assertTrue(r is AutoSignInResult.SignedIn)
        assertEquals(1, p.silentCalls)
        assertEquals(1, p.sheetCalls)
    }

    @Test
    fun aDismissedSheetIsNoCredential() = runBlocking {
        val w = world()
        val p = FakeProvider(silentToken = null, sheetToken = null)
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p, prompt = AutoSignInPrompt.OPTIONAL)) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, r.reason)
    }

    @Test
    fun aThrowingProviderReadsAsNothingAndTheLadderMovesOn() = runBlocking {
        val w = world()
        val p = object : PlatformIdentityProvider by FakeProvider() {
            override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? = error("boom")
        }
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, r.reason)
    }

    @Test
    fun confirmAndChooseCarryTheirPendingStateAndStoreNothing() = runBlocking {
        val c = world(tokenBody = consent).client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.Confirm
        assertEquals(grant, c.pending.grant)
        assertFalse(c.toString().contains(grant))
        val w = world(tokenBody = choose)
        val ch = w.client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.Choose
        assertEquals(grant, ch.pending.grant)
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun noLinkAndTermsAreNeedsSignInAndOnlyNoLinkCarriesTheHandle() = runBlocking {
        val noLink = world(tokenStatus = 403, tokenBody = """{"error":"interstitial_required","reason":"no_link","url":"https://key.plrs.im/x","linkHandle":"$handle","expiresIn":300}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoLink, noLink.reason)
        assertEquals(handle, noLink.linkHandle)
        assertFalse(noLink.toString().contains(handle))
        val terms = world(tokenStatus = 403, tokenBody = """{"error":"interstitial_required","reason":"terms","url":"https://key.plrs.im/x"}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.Terms, terms.reason)
        assertNull(terms.linkHandle)
    }

    @Test
    fun deviceLimitCarriesTheChoiceViewWhenSent() = runBlocking {
        val withView = world(tokenStatus = 403, tokenBody = """{"error":{"code":"device_limit"},"view":$view}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.DeviceLimit
        assertEquals(listOf("lic_1"), withView.view!!.licenseIds)
        val without = world(tokenStatus = 403, tokenBody = """{"error":{"code":"device_limit"}}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.DeviceLimit
        assertNull(without.view)
        val manage = world(tokenStatus = 403, tokenBody = """{"error":{"code":"device_limit"},"manageUrl":"https://key.plrs.im/manage","view":$view}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider())) as AutoSignInResult.DeviceLimit
        assertEquals("https://key.plrs.im/manage", manage.manageUrl)
        assertFalse(withView.view.toString().contains("lic_1"))
    }

    @Test
    fun refusalsAreResultsNeverThrows() = runBlocking {
        val refused = world(tokenStatus = 400, tokenBody = """{"error":"invalid_grant"}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider()))
        assertEquals(AutoSignInResult.Unavailable("invalid_grant"), refused)
        val limited = world(tokenStatus = 429, tokenBody = """{"error":"rate_limited"}""")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider()))
        assertEquals(AutoSignInResult.Unavailable("rate_limited"), limited)
        val server = world(tokenStatus = 500, tokenBody = "{}")
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider()))
        assertEquals(AutoSignInResult.Unavailable(ErrorCode.serverError), server)
        val notServed = world(nonceStatus = 404)
            .client.autoSignIn(AutoSignInOptions(provider = FakeProvider()))
        assertEquals(AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable), notServed)
    }

    @Test
    fun signOutSetsTheFlagRunsCleanupAndSilencesRungsThreeAndFour() = runBlocking {
        val w = world()
        val p = FakeProvider()
        w.client.installPlatformIdentity(p)
        assertFalse(w.core.explicitSignOut())
        w.client.signOut()
        assertTrue(w.core.explicitSignOut())
        assertEquals(1, p.cleanups)
        val r = w.client.autoSignIn(AutoSignInOptions(prompt = AutoSignInPrompt.OPTIONAL)) as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, r.reason)
        assertEquals(0, p.silentCalls)
        assertEquals(0, p.sheetCalls)
    }

    @Test
    fun aRefusedSignOutDoesNotSetTheFlag() = runBlocking {
        val w = world(revokedSignOutStatus = 403)
        w.client.installPlatformIdentity(FakeProvider())
        runCatching { w.client.signOut() }
        assertFalse(w.core.explicitSignOut())
    }

    @Test
    fun theFlagPersistsAcrossAClientAndAnExplicitSignInClearsIt() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-auto").toFile()
        try {
            val first = world(store = FileStore("djdl", dir))
            first.core.setExplicitSignOut(true)
            val second = world(store = FileStore("djdl", dir))
            assertTrue(second.core.explicitSignOut())
            val p = FakeProvider()
            assertEquals(AutoSignInReason.SignedOut, (second.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.NeedsSignIn).reason)
            assertEquals(0, p.silentCalls)
            // A token from an explicit sign-in ends it; an activation token does not.
            second.core.setToken("pkeyt_act", TokenSource.activate)
            assertTrue(second.core.explicitSignOut())
            // A silent sign-in token does not clear it either; only the person's own does.
            second.core.setToken("pkeyt_silent", TokenSource.signin)
            assertTrue(second.core.explicitSignOut())
            second.core.setToken("pkeyt_in", TokenSource.signin, personInitiated = true)
            assertFalse(second.core.explicitSignOut())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aRevokedCredentialSignsTheDeviceOutThroughSignOut() = runBlocking {
        val w = world()
        val p = FakeProvider(revoked = true)
        w.client.installPlatformIdentity(p)
        val r = w.client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, r.reason)
        assertTrue(w.paths().any { it == "/djdl/identity/signout" })
        assertEquals(1, p.cleanups)
        assertEquals(0, p.silentCalls)
    }

    @Test
    fun aRevokedCredentialWithNoSessionSetsOnlyTheLocalState() = runBlocking {
        val store = InMemoryStore("djdl", deviceId)
        val w = world(store = store)
        store.clearToken()
        val core = w.core
        val p = FakeProvider(revoked = true)
        w.client.installPlatformIdentity(p)
        // Reload with no token held: restart the core's view of the store.
        val fresh = CoreContext(CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false, store = store, transport = w.transport, clock = { 1_700_000_000L }))
        fresh.start()
        val client = IdentityClient(fresh, deviceKeys = DeviceKeyStore(DurableMem()))
        client.installPlatformIdentity(p)
        assertNotNull(core)
        val r = client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, r.reason)
        assertTrue(fresh.explicitSignOut())
        assertFalse(w.paths().any { it == "/djdl/identity/signout" })
    }

    @Test
    fun aSignOutWhileTheProviderIsSuspendedStopsTheLadderStoringAToken() = runBlocking {
        val w = world()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val p = object : PlatformIdentityProvider by FakeProvider() {
            override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? {
                entered.complete(Unit)
                gate.await()
                return PlatformSubjectToken("id-token", nonce)
            }
        }
        val job = kotlinx.coroutines.GlobalScope.async { w.client.autoSignIn(AutoSignInOptions(provider = p)) }
        entered.await()
        w.client.signOut()
        gate.complete(Unit)
        val r = job.await() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, r.reason)
        assertTrue(w.core.explicitSignOut())
        assertFalse(w.paths().contains("/djdl/identity/token"))
        assertNull(w.store.getToken())
    }

    @Test
    fun aLadderExchangeNeverClearsTheFlagButAPersonInitiatedOneDoes() = runBlocking {
        val w = world()
        w.core.setExplicitSignOut(true)
        val nonce = (w.client.exchangeNonce(ExchangeKind.google) as ExchangeNonceResult.Issued).nonce
        w.client.exchange(ExchangeKind.google, "tok", nonce)
        assertTrue(w.core.explicitSignOut())
        val nonce2 = (w.client.exchangeNonce(ExchangeKind.google) as ExchangeNonceResult.Issued).nonce
        w.client.exchange(ExchangeKind.google, "tok", nonce2, personInitiated = true)
        assertFalse(w.core.explicitSignOut())
    }

    @Test
    fun theFlagFailsClosedAndAFailedWriteNeverStopsSignOut() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-auto2").toFile()
        try {
            val w = world(store = FileStore("djdl", dir), withLicense = true)
            val flag = File(dir, "explicit-sign-out")
            // An unreadable slot (a directory where the file should be) reads as signed out.
            flag.mkdirs()
            assertTrue(w.core.explicitSignOut())
            val warnings = mutableListOf<String>()
            val collector = kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.Unconfined) { w.core.stateWarnings.collect { warnings += it } }
            // The write fails (the path is a directory) but the sign-out still clears everything.
            assertEquals(SignOutResult.SignedOut(true), w.client.signOut())
            assertNull(w.store.getToken())
            assertTrue(w.core.explicitSignOut())
            assertTrue(warnings.isNotEmpty())
            collector.cancel()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun onlyASigninTokenIsRungOne() = runBlocking {
        // A key-only device (activation) with a cached licence is not signed in.
        val keyOnly = world(withLicense = true, provenance = TokenProvenance.key)
        val p = FakeProvider(silentToken = null)
        assertTrue(keyOnly.client.autoSignIn(AutoSignInOptions(provider = p)) is AutoSignInResult.NeedsSignIn)
        assertEquals(1, p.silentCalls)
        // released:false keeps the token but demotes it.
        val w = world(withLicense = true, signOutBody = """{"released":false}""")
        assertTrue(w.client.autoSignIn() is AutoSignInResult.SignedIn)
        w.client.signOut()
        assertNotNull(w.store.getToken())
        assertEquals(TokenProvenance.key, w.core.tokenProvenance())
        w.core.setExplicitSignOut(false)
        assertTrue(w.client.autoSignIn() is AutoSignInResult.NeedsSignIn)
    }

    @Test
    fun nothingSecretReachesAToString() {
        assertFalse(PlatformSubjectToken("secret-token", "n").toString().contains("secret-token"))
        assertFalse(AutoSignInResult.NeedsSignIn(handle, AutoSignInReason.NoLink).toString().contains(handle))
    }
}
