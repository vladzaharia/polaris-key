// @pkey-feature identity.autosignin identity.restore
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
import im.plrs.key.core.InMemoryPlatformBackupStore
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.Store
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.TokenSource
import im.plrs.key.core.UnavailablePlatformBackupStore
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AutoSignInTest {
    private class DurableMem(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private class FakeProvider(
        var silentToken: String? = "id-token-silent",
        var sheetToken: String? = "id-token-sheet",
        var revoked: Boolean = false,
        override val kind: ExchangeKind = ExchangeKind.google,
    ) : PlatformIdentityProvider {
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
        var providerToken: String? = "id-token-provider"
        var providerCalls = 0
        override suspend fun providerSheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            providerCalls++
            return providerToken?.let { PlatformSubjectToken(it, nonce) }
        }
        override suspend fun signOutCleanup() {
            cleanups++
        }
        override suspend fun credentialRevoked(): Boolean = revoked
    }

    private val grant = "sg_" + "B".repeat(43)
    private val handle = "lh_" + "C".repeat(43)
    private val base = "https://key.plrs.im/djdl/identity"
    private val tokenOk = """{"access_token":"pkeyt_auto","token_type":"Bearer","scope":"profile","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ","issued_token_type":"urn:polaris-key:token-type:device"}"""
    private val consent = """{"status":"confirm","grant":"$grant","expiresIn":300,"consent":{"client":{"appName":"djdl","nameVerified":true},""" +
        """"as":{"provider":"google","email":"a@example.com"},"items":[],"scopeHash":"abc","firstTime":true,"changed":false}}"""
    private val choose =
        """{"status":"choose","grant":"$grant","expiresIn":300,""" +
            """"choices":{"state":"choose","choices":[{"id":"lic_1","state":"free"}]}}"""
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
        exchangeMember: String = """"exchange":{"kinds":["google"],"google":{"serverClientId":"1234-web.apps.googleusercontent.com"}},""",
        signOutBody: String = """{"released":true}""",
        revokedSignOutStatus: Int = 200,
        provenance: TokenProvenance? = if (withLicense) TokenProvenance.signin else null,
        // I-49.11: discovery names `restore` (the member and the endpoint); `script` answers a request first.
        restoreServed: Boolean = false,
        script: ((PolarisRequest) -> PolarisResponse?)? = null,
        backup: PlatformBackupStore? = null,
        now: () -> Long = { 1_700_000_000L },
    ): World {
        runBlocking { store.setToken("pkeyt_old") }
        if (withLicense) {
            runBlocking {
                store.writeCache(
                    CacheRecord(docs = mapOf(DocumentSlice.license to signer.licenseDoc("djdl", deviceId, 1_700_000_000L, licenseId = "lic_cached"))),
                )
            }
        }
        var n = 0
        val transport = ScriptedTransport { r: PolarisRequest ->
            script?.invoke(r) ?: when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(
                    200,
                    """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"account":true,""" +
                        exchangeMember + (if (restoreServed) """"restore":true,""" else "") +
                        """"endpoints":{"nonce":"$base/nonce","token":"$base/token","signout":"$base/signout","subject":"$base/subject",""" +
                        (if (restoreServed) """"restore":"$base/restore",""" else "") +
                        """"choiceComplete":"$base/choice/complete"}}}}""",
                )

                "/djdl/identity/nonce" -> respond(
                    nonceStatus,
                    """{"nonce":"${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"}${n++ % 10}","expiresIn":300}""",
                )

                "/djdl/identity/token" -> respond(tokenStatus, tokenBody)

                "/djdl/identity/signout" -> respond(revokedSignOutStatus, signOutBody)

                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl",
                version = "1.0.0",
                pinnedKeys = signer.trust,
                trustRefresh = false,
                store = store,
                transport = transport,
                clock = now,
            ),
        )
        runBlocking { core.start() }
        if (provenance != null) runBlocking { core.setToken("pkeyt_old", TokenSource.signin, provenance = provenance) }
        val client = IdentityClient(core, deviceKeys = DeviceKeyStore(DurableMem()))
        if (backup != null) client.installPlatformBackup(backup)
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
    fun aPlayGamesCodeIsExchangedAsAPgsSubjectTokenForThePgsClientId() = runBlocking {
        val member = """"exchange":{"kinds":["pgs"],"pgs":{"serverClientId":"5678-pgs.apps.googleusercontent.com"}},"""
        val w = world(exchangeMember = member)
        val p = FakeProvider(silentToken = "4/pgs-code", kind = ExchangeKind.pgs)
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.SignedIn
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", r.subject)
        assertEquals("5678-pgs.apps.googleusercontent.com", p.audience)
        val body = String(w.transport.requests().first { it.path == "/djdl/identity/token" }.body!!)
        assertTrue(body.contains("subject_token_type=urn%3Apolaris-key%3Atoken-type%3Apgs-server-auth-code"))
        assertTrue(body.contains("subject_token=4%2Fpgs-code"))
    }

    @Test
    fun aPgsProviderWhereDiscoveryListsOnlyGoogleEndsUnavailableWithoutAskingForACode() = runBlocking {
        val w = world()
        val p = FakeProvider(kind = ExchangeKind.pgs)
        val r = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.Unavailable
        assertEquals(ErrorCode.platformIdentityUnavailable, r.code)
        assertEquals(ExchangeUnavailableReason.kindNotDeclared, r.reason)
        assertEquals(0, p.silentCalls)
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
        val noLink = world(
            tokenStatus = 403,
            tokenBody = """{"error":"interstitial_required","reason":"no_link","url":"https://key.plrs.im/x",""" +
                """"linkHandle":"$handle","expiresIn":300}""",
        )
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
        val manage = world(
            tokenStatus = 403,
            tokenBody = """{"error":{"code":"device_limit"},"manageUrl":"https://key.plrs.im/manage","view":$view}""",
        )
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
        // The exchange's own reason is carried, not flattened (I-45.9 M3).
        assertEquals(AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable, ExchangeUnavailableReason.notServed), notServed)
        val noKeys = IdentityClient(world().core).autoSignIn(AutoSignInOptions(provider = FakeProvider()))
        assertEquals(AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable, ExchangeUnavailableReason.noDeviceKeys), noKeys)
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
            assertEquals(
                AutoSignInReason.SignedOut,
                (second.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.NeedsSignIn).reason,
            )
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
    fun aRevocationSignOutCleansUpTheOptionsProviderNotTheInstalledOne() = runBlocking {
        val w = world()
        val installed = FakeProvider()
        val mine = FakeProvider(revoked = true)
        w.client.installPlatformIdentity(installed)
        w.client.autoSignIn(AutoSignInOptions(provider = mine))
        assertEquals(1, mine.cleanups)
        assertTrue(w.paths().any { it == "/djdl/identity/signout" })
    }

    @Test
    fun aSignOutBetweenTheCheckAndTheStoreTakesTheTokenBackOut() = runBlocking {
        val w = world()
        val generation = w.core.signOutGeneration()
        var checks = 0
        val outcome = try {
            w.client.exchangeTokens(
                ExchangeKind.google,
                "id-token",
                null,
                w.client.deviceKeyPort()!!,
                mayStore = {
                    val ok = w.core.signOutGeneration() == generation
                    // A sign-out lands right after the first check, before the token is stored.
                    if (checks++ == 0) {
                        w.core.bumpSignOutGeneration()
                        w.core.setExplicitSignOut(true)
                        w.core.setTokenProvenance(TokenProvenance.key)
                    }
                    ok
                },
            )
        } catch (e: SignedOutDuringExchange) {
            null
        }
        assertNull("the exchange must end as signed out", outcome)
        assertEquals(2, checks)
        assertNull(w.core.token())
        assertTrue(w.core.tokenProvenance() != TokenProvenance.signin)
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
        val fresh =
            CoreContext(
                CoreOptions(
                    productSlug = "djdl",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = store,
                    transport = w.transport,
                    clock = {
                        1_700_000_000L
                    },
                ),
            )
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
            val collector = kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.Unconfined) {
                w.core.stateWarnings.collect {
                    warnings +=
                        it
                }
            }
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
    fun theProviderRowClearsTheSignOutFlagAndTheLadderNeverDoes() = runBlocking {
        val w = world()
        val p = FakeProvider()
        w.client.installPlatformIdentity(p)
        assertTrue(w.client.hasPlatformProvider)
        w.core.setExplicitSignOut(true)
        // The ladder stays quiet while signed out.
        assertTrue(w.client.autoSignIn(AutoSignInOptions(prompt = AutoSignInPrompt.OPTIONAL)) is AutoSignInResult.NeedsSignIn)
        assertTrue(w.core.explicitSignOut())
        // The person pressed the provider row: the explicit sheet runs and the flag clears.
        val r = w.client.signInWithProvider() as AutoSignInResult.SignedIn
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", r.subject)
        assertEquals(1, p.providerCalls)
        assertEquals(0, p.sheetCalls)
        assertFalse(w.core.explicitSignOut())
    }

    @Test
    fun aDismissedProviderRowIsNeedsSignInAndNeverThrows() = runBlocking {
        val w = world()
        val p = FakeProvider().also { it.providerToken = null }
        w.client.installPlatformIdentity(p)
        val r = w.client.signInWithProvider() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, r.reason)
        // No provider installed (the JVM desktop): the same answer.
        val bare = world().client
        assertFalse(bare.hasPlatformProvider)
        assertTrue(bare.signInWithProvider() is AutoSignInResult.NeedsSignIn)
    }

    @Test
    fun nothingSecretReachesAToString() {
        assertFalse(PlatformSubjectToken("secret-token", "n").toString().contains("secret-token"))
        assertFalse(AutoSignInResult.NeedsSignIn(handle, AutoSignInReason.NoLink).toString().contains(handle))
    }

    // ── Rung 2: silent restore (I-49.11, WIRE-CONTRACT-V5 section 12.11.8) ────────────────────────

    private val rid1 = "rk_" + "a".repeat(22)
    private val rsecret1 = "rs_" + "b".repeat(43)
    private val rid2 = "rk_" + "c".repeat(22)
    private val rsecret2 = "rs_" + "d".repeat(43)
    private val rid3 = "rk_" + "e".repeat(22)
    private val rsecret3 = "rs_" + "f".repeat(43)
    private val restoreKey = PlatformBackupStore.restoreKey("djdl")
    private fun item(id: String, secret: String) = RestoreItem(id, secret).encode()
    private fun enrolled(id: String, secret: String) = """{"restoreId":"$id","secret":"$secret"}"""
    private val invalidGrant = """{"error":"invalid_grant"}"""

    /** A scripted Worker for the restore routes: each is a mutable answer; a null body means a network failure. */
    private class Restore {
        var grantStatus = 200
        var grantBody: String? = null
        var enrolStatus = 201
        var enrolBody: String? = null
        var deleteStatus = 204
        var deleteFails = false
        val log = ArrayList<String>()
        fun script(complete: String): (PolarisRequest) -> PolarisResponse? = { r ->
            val form = r.body?.let { String(it, Charsets.UTF_8) }
            when {
                r.path == "/djdl/identity/token" && form?.contains("grant-type%3Arestore") == true -> {
                    log += "grant"
                    grantBody?.let { respond(grantStatus, it) } ?: throw java.io.IOException("offline")
                }

                r.path == "/djdl/identity/restore" && r.method == "POST" -> {
                    log += "enrol:" + (form ?: "")
                    respond(enrolStatus, enrolBody ?: "")
                }

                r.path == "/djdl/identity/restore" && r.method == "DELETE" -> {
                    log += "delete"
                    if (deleteFails) throw java.io.IOException("offline")
                    respond(deleteStatus)
                }

                r.path == "/djdl/identity/choice/complete" -> {
                    log += "complete"
                    respond(200, complete)
                }

                else -> null
            }
        }
    }

    private fun restoreWorld(
        r: Restore,
        backup: PlatformBackupStore? = InMemoryPlatformBackupStore(cloud = true),
        withLicense: Boolean = false,
        served: Boolean = true,
        now: () -> Long = { 1_700_000_000L },
    ) = world(
        withLicense = withLicense,
        restoreServed = served,
        script = r.script(tokenOk),
        backup = backup,
        now = now,
        signOutBody = """{"released":false}""",
    )

    private suspend fun readItem(b: PlatformBackupStore): RestoreItem? = (b.get(restoreKey) as? PlatformBackupRead.Found)?.let {
        RestoreItem.decode(it.bytes)
    }

    @Test
    fun rungTwoRedeemsTheItemThenEnrolsAndWritesTheNewItemWithoutAskingTheProvider() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore(cloud = true)
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        val p = FakeProvider()
        val res = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.SignedIn
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", res.subject)
        assertEquals(0, p.silentCalls)
        assertEquals("pkeyt_auto", w.store.getToken())
        assertEquals(TokenProvenance.signin, w.core.tokenProvenance())
        // The consumed key's id is sent on the enrol (the Worker does not know it, so it answers a new key).
        assertEquals(listOf("grant", """enrol:{"restoreId":"$rid1"}"""), r.log)
        val kept = readItem(backup)!!
        assertEquals(rid2, kept.restoreId)
        assertEquals(rsecret2, kept.secret)
        val grant = String(w.transport.requests().first { it.path == "/djdl/identity/token" }.body!!, Charsets.UTF_8)
        for (field in listOf("restore_id=$rid1", "restore_secret=$rsecret1", "client_id=djdl", "device_key=", "agree_key=", "proof=")) {
            assertTrue(field, grant.contains(field))
        }
    }

    @Test
    fun theRestoreProofCoversTheIdAndTheDeviceKeyAndHashesTheSecret() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        w.client.autoSignIn()
        val form = String(w.transport.requests().first { it.path == "/djdl/identity/token" }.body!!, Charsets.UTF_8)
            .split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        val proof = im.plrs.key.core.DeviceProof(
            im.plrs.key.core.DeviceProofFields("restore", "djdl", deviceId, "$rid1.${form["device_key"]}", IdentityExchange.tokenHash(rsecret1)),
            form["device_key"]!!,
            form["proof"]!!,
        )
        assertTrue(im.plrs.key.core.DeviceProofs.verify(proof))
        assertEquals("urn:polaris-key:grant-type:restore", form["grant_type"])
    }

    @Test
    fun noBackupStoreMeansRungTwoIsSkippedAndNothingIsEnrolled() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val w = restoreWorld(r, backup = null)
        val res = w.client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.NoCredential, res.reason)
        assertTrue(r.log.isEmpty())
    }

    @Test
    fun discoveryWithoutRestoreSkipsTheRungAndLeavesTheItem() = runBlocking {
        val r = Restore().apply { grantBody = tokenOk }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, served = false)
        assertTrue(w.client.autoSignIn() is AutoSignInResult.NeedsSignIn)
        assertTrue(r.log.isEmpty())
        assertNotNull(readItem(backup))
    }

    @Test
    fun anExplicitSignOutSilencesRungTwoAndASignInClearsIt() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        w.core.setExplicitSignOut(true)
        val res = w.client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, res.reason)
        assertTrue(r.log.isEmpty())
        // Nothing enrols while signed out, even for a sign-in the ladder did not start.
        w.client.enrolRestoreIfDue(force = true)
        assertTrue(r.log.isEmpty())
    }

    @Test
    fun invalidGrantDeletesTheItemAndFallsToRungThree() = runBlocking {
        val r = Restore().apply {
            grantStatus = 400
            grantBody = invalidGrant
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        val p = FakeProvider()
        val res = w.client.autoSignIn(AutoSignInOptions(provider = p))
        assertTrue(res is AutoSignInResult.SignedIn)
        assertEquals(1, p.silentCalls)
        // The dead item is gone, and the rung-three sign-in enrolled a fresh key in its place.
        assertEquals(rid2, readItem(backup)!!.restoreId)
        assertEquals("grant", r.log.first())
    }

    @Test
    fun aRateLimitANetworkFailureAndAnUnavailableStoreLeaveTheItem() = runBlocking {
        for (case in listOf("429", "503", "offline")) {
            val r = Restore()
            when (case) {
                "429" -> {
                    r.grantStatus = 429
                    r.grantBody = """{"error":"rate_limited","retryAfter":60}"""
                }

                "503" -> {
                    r.grantStatus = 503
                    r.grantBody = """{"error":"unavailable"}"""
                }

                else -> r.grantBody = null
            }
            val backup = InMemoryPlatformBackupStore()
            backup.set(restoreKey, item(rid1, rsecret1))
            val w = restoreWorld(r, backup)
            val p = FakeProvider(silentToken = null)
            val res = w.client.autoSignIn(AutoSignInOptions(provider = p)) as AutoSignInResult.NeedsSignIn
            assertEquals(case, AutoSignInReason.NoCredential, res.reason)
            assertEquals(case, rid1, readItem(backup)!!.restoreId)
            assertEquals(case, 1, p.silentCalls)
        }
        // A store that cannot be read: the ladder goes straight on.
        val r = Restore()
        val w = restoreWorld(r, UnavailablePlatformBackupStore())
        val p = FakeProvider(silentToken = null)
        assertTrue(w.client.autoSignIn(AutoSignInOptions(provider = p)) is AutoSignInResult.NeedsSignIn)
        assertTrue(r.log.isEmpty())
        assertEquals(1, p.silentCalls)
    }

    @Test
    fun aUsedKeyThatIsThenRefusedFallsToRungThree() = runBlocking {
        val r = Restore().apply {
            grantStatus = 409
            grantBody = """{"error":"device_limit"}"""
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        val p = FakeProvider(silentToken = null)
        assertTrue(w.client.autoSignIn(AutoSignInOptions(provider = p)) is AutoSignInResult.NeedsSignIn)
        assertEquals(1, p.silentCalls)
    }

    @Test
    fun aConfirmAnswerIsReturnedAndEnrolmentFollowsComplete() = runBlocking {
        val r = Restore().apply {
            grantBody = consent
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup)
        val c = w.client.autoSignIn() as AutoSignInResult.Confirm
        assertNull(w.store.getToken().takeIf { it != "pkeyt_old" })
        assertEquals(listOf("grant"), r.log)
        w.client.choice.complete(c.pending.grant, null)
        assertEquals(listOf("grant", "complete", """enrol:{"restoreId":"$rid1"}"""), r.log)
        assertEquals(rid2, readItem(backup)!!.restoreId)
    }

    @Test
    fun optingOutDeletesTheItemSendsDeleteAndNeverEnrols() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, withLicense = true)
        val p = FakeProvider(silentToken = null)
        assertTrue(w.client.autoSignIn(AutoSignInOptions(provider = p, restore = false)) is AutoSignInResult.SignedIn)
        assertEquals(listOf("delete"), r.log)
        assertNull(readItem(backup))
        // The next launch has nothing left to remove: no further call.
        w.client.autoSignIn(AutoSignInOptions(provider = p, restore = false))
        assertEquals(listOf("delete"), r.log)
        // And a sign-in under the option never enrols.
        w.client.enrolRestoreIfDue(force = true)
        assertEquals(listOf("delete"), r.log)
    }

    @Test
    fun theClientLevelOptOutIsTheSameAsTheCallLevelOne() = runBlocking {
        val r = Restore().apply {
            grantBody = tokenOk
            enrolBody = enrolled(rid2, rsecret2)
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, withLicense = true)
        w.client.installPlatformBackup(backup, restore = false)
        w.client.autoSignIn()
        assertEquals(listOf("delete"), r.log)
        assertNull(readItem(backup))
    }

    @Test
    fun signOutDeletesTheItemAndSendsDeleteWhateverTheAnswer() = runBlocking {
        val r = Restore().apply { deleteStatus = 500 }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, withLicense = true)
        w.client.signOut()
        assertEquals(listOf("delete"), r.log)
        assertNull(readItem(backup))
        assertTrue(w.core.explicitSignOut())
    }

    @Test
    fun aDeleteThatCannotBeDeliveredIsQueuedAndRetriedFirstAtTheNextLaunch() = runBlocking {
        val r = Restore().apply { deleteFails = true }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, withLicense = true)
        w.client.signOut()
        assertEquals(listOf("delete"), r.log)
        assertNull(readItem(backup))
        assertTrue(w.core.restoreDeletePending())
        // Next launch: the queued revocation is the first call, ahead of any other.
        r.deleteFails = false
        val before = w.transport.requests().size
        w.client.autoSignIn()
        assertEquals(listOf("delete", "delete"), r.log)
        assertFalse(w.core.restoreDeletePending())
        assertEquals("DELETE", w.transport.requests()[before].method)
        // It is sent once.
        w.client.autoSignIn()
        assertEquals(2, r.log.size)
    }

    @Test
    fun aSignInCompletedByTheProviderRowEnrolsAndWritesTheItem() = runBlocking {
        val r = Restore().apply { enrolBody = enrolled(rid2, rsecret2) }
        val backup = InMemoryPlatformBackupStore()
        val w = restoreWorld(r, backup)
        w.client.installPlatformIdentity(FakeProvider())
        assertTrue(w.client.signInWithProvider() is AutoSignInResult.SignedIn)
        assertEquals(listOf("enrol:{}"), r.log)
        assertEquals(rid2, readItem(backup)!!.restoreId)
        assertEquals(1_700_000_000L, w.core.restoreCheckedAt())
    }

    @Test
    fun theStoredSessionChecksOnceADayAndRotatesWhenTheWorkerSaysSo() = runBlocking {
        var clock = 1_700_000_000L
        val r = Restore().apply {
            enrolStatus = 200
            enrolBody = """{"status":"current"}"""
        }
        val backup = InMemoryPlatformBackupStore()
        backup.set(restoreKey, item(rid1, rsecret1))
        val w = restoreWorld(r, backup, withLicense = true, now = { clock })
        // First launch: never checked, so it checks (the held id is this device's: current, nothing written).
        assertTrue(w.client.autoSignIn() is AutoSignInResult.SignedIn)
        assertEquals(listOf("""enrol:{"restoreId":"$rid1"}"""), r.log)
        assertEquals(rid1, readItem(backup)!!.restoreId)
        // Within 24 h: rung 1 is silent.
        clock += 86_399
        w.client.autoSignIn()
        assertEquals(1, r.log.size)
        // After 24 h: checked again; the Worker rotates (a key older than 90 days): the new item is written.
        clock += 2
        r.enrolStatus = 201
        r.enrolBody = enrolled(rid3, rsecret3)
        w.client.autoSignIn()
        assertEquals(2, r.log.size)
        assertEquals(rid3, readItem(backup)!!.restoreId)
    }

    @Test
    fun noKeyIsEnrolledWhereTheBackupCannotKeepIt() = runBlocking {
        val r = Restore().apply { enrolBody = enrolled(rid2, rsecret2) }
        val w = restoreWorld(r, UnavailablePlatformBackupStore(), withLicense = true)
        assertTrue(w.client.autoSignIn() is AutoSignInResult.SignedIn)
        assertTrue(r.log.isEmpty())
    }

    @Test
    fun aWorkerRefusalOfTheEnrolLeavesTheItemAndTheNextLaunchTriesAgain() = runBlocking {
        val r = Restore().apply {
            enrolStatus = 403
            enrolBody = """{"error":"account_required"}"""
        }
        val backup = InMemoryPlatformBackupStore()
        val w = restoreWorld(r, backup, withLicense = true)
        assertTrue(w.client.autoSignIn() is AutoSignInResult.SignedIn)
        assertNull(readItem(backup))
        assertNull(w.core.restoreCheckedAt())
        w.client.autoSignIn()
        assertEquals(2, r.log.size)
    }

    @Test
    fun theSecretNeverReachesAToString() {
        val i = RestoreItem(rid1, rsecret1)
        assertFalse(i.toString().contains(rsecret1))
        assertFalse(RestoreEnrolResult.Enrolled(rid2, rsecret2).toString().contains(rsecret2))
        assertNull(RestoreItem.decode("""{"v":2,"restoreId":"$rid1","secret":"$rsecret1"}""".toByteArray()))
        assertNull(RestoreItem.decode("""{"v":1,"restoreId":"x","secret":"$rsecret1"}""".toByteArray()))
        assertEquals(rid1, RestoreItem.decode(i.encode())!!.restoreId)
    }

    @Test
    fun theRestoreStateLivesInTheNoBackupStateDirectory() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-restore").toFile()
        try {
            val store = FileStore("djdl", dir)
            val w = world(store = store, withLicense = true)
            w.core.setRestoreCheckedAt(42L)
            w.core.setRestoreDeletePending(true)
            assertEquals("42", File(dir, "restore-checked").readText())
            assertEquals("1", File(dir, "restore-delete-pending").readText())
            assertTrue(w.core.restoreDeletePending())
            w.core.setRestoreDeletePending(false)
            assertFalse(w.core.restoreDeletePending())
        } finally {
            dir.deleteRecursively()
        }
    }
}
