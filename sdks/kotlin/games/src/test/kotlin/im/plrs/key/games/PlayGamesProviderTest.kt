// @pkey-feature identity.pgs
//
// PlayGamesProvider against a fake Play Games client (I-45.5): the launch rungs never start Play
// Games' sign-in, the provider row does, the code leaves only through the token, and nothing prints it.
package im.plrs.key.games

import im.plrs.key.identity.ExchangeKind
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PlayGamesProviderTest {
    private val nonce = "n".repeat(43)
    private val code = "4/fake-server-auth-code"

    private class Fake(var authenticated: Boolean, val signInWorks: Boolean = true, val refuse: Boolean = false) : PlayGamesClient {
        var signIns = 0
        val audiences = mutableListOf<String>()
        override suspend fun isAuthenticated() = authenticated
        override suspend fun signIn(): Boolean {
            signIns++
            if (signInWorks) authenticated = true
            return authenticated
        }
        override suspend fun requestServerSideAccess(serverClientId: String): String {
            audiences += serverClientId
            check(!refuse) { "refused" }
            return "4/fake-server-auth-code"
        }
    }

    @Test
    fun kindIsPgs() = assertEquals(ExchangeKind.pgs, PlayGamesProvider(Fake(true)).kind)

    @Test
    fun aSignedInPlayerGivesTheCodeForDiscoverysClientId() = runBlocking {
        val fake = Fake(true)
        val token = assertNotNull(PlayGamesProvider(fake).silent(nonce, "web.apps.googleusercontent.com"))
        assertEquals(code, token.token)
        assertEquals(nonce, token.nonce)
        assertEquals(listOf("web.apps.googleusercontent.com"), fake.audiences)
        assertEquals(0, fake.signIns)
    }

    @Test
    fun launchNeverStartsPlayGamesSignIn() = runBlocking {
        val fake = Fake(false)
        val p = PlayGamesProvider(fake)
        assertNull(p.silent(nonce, "web"))
        assertNull(p.sheet(nonce, "web"))
        assertEquals(0, fake.signIns)
        assertTrue(fake.audiences.isEmpty())
    }

    @Test
    fun theProviderRowSignsInFirst() = runBlocking {
        val fake = Fake(false)
        val token = PlayGamesProvider(fake).providerSheet(nonce, "web")
        assertNotNull(token)
        assertEquals(1, fake.signIns)
    }

    @Test
    fun aRefusedSignInIsNoToken() = runBlocking {
        val fake = Fake(false, signInWorks = false)
        assertNull(PlayGamesProvider(fake).providerSheet(nonce, "web"))
        assertTrue(fake.audiences.isEmpty())
    }

    @Test
    fun noClientIdIsNoToken() = runBlocking {
        val fake = Fake(true)
        assertNull(PlayGamesProvider(fake).silent(nonce, null))
        PlayGamesProvider(fake, "fb").silent(nonce, null)
        assertEquals("fb", fake.audiences.single())
    }

    @Test
    fun aPlayGamesFailureIsNoTokenAndNeverEscapes() = runBlocking {
        assertNull(PlayGamesProvider(Fake(true, refuse = true)).silent(nonce, "web"))
    }

    @Test
    fun theCodeIsNotInThePrintedToken() = runBlocking {
        val token = assertNotNull(PlayGamesProvider(Fake(true)).silent(nonce, "web"))
        assertFalse(token.toString().contains(code))
        assertFalse(token.toString().contains("fake-server"))
    }
}
