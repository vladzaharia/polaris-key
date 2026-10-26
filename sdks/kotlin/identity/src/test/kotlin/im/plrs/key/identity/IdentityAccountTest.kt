// @pkey-feature identity.account
//
// The account on the device, beyond what identity-subject-signout.json pins: each call answers
// `Unavailable` (and sends nothing) when discovery's fragment lacks the endpoint, the subject is
// stored and survives a restart, the pre-sign-out hooks run first and stop a sign-out when one
// throws, `released: false` keeps the token while `released: true` drops it, and openAccount hands
// the published portal URL to the host's opener, never one it built.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentityAccountTest {
    private fun discovery(identity: String) = """{"product":"djdl","services":{"identity":$identity}}"""

    private val withAccount = discovery(
        """{"enabled":true,"account":true,"keyEntryLimit":5,"endpoints":{"subject":"https://key.plrs.im/djdl/identity/subject",""" +
            """"signout":"https://key.plrs.im/djdl/identity/signout","accountPortal":"https://key.plrs.im/#/p/djdl"}}""",
    )

    private class World(val core: CoreContext, val transport: ScriptedTransport, val store: InMemoryStore)

    private fun world(
        discoveryBody: String,
        subject: String = """{"subject":"ps_abc"}""",
        signOut: String = """{"released":false}""",
    ): World {
        val store = InMemoryStore("djdl", "dev1")
        runBlocking { store.setToken("pkeyt_token") }
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discoveryBody)
                "/djdl/identity/subject" -> respond(200, subject)
                "/djdl/identity/signout" -> respond(200, signOut)
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = store, transport = transport, clock = { 1_700_000_000L },
            ),
        )
        runBlocking { core.start() }
        return World(core, transport, store)
    }

    @Test
    fun theFragmentIsReadIntoTypedMembers() = runBlocking {
        val w = world(withAccount)
        w.core.discover()
        val identity = w.core.discoveryDocument()!!.identity!!
        assertTrue(identity.account)
        assertEquals(5L, identity.keyEntryLimit)
        assertEquals("https://key.plrs.im/djdl/identity/subject", identity.subject)
        assertEquals("https://key.plrs.im/#/p/djdl", identity.accountPortal)
    }

    @Test
    fun anOffOrOlderFragmentAnswersUnavailableAndSendsNothing() = runBlocking {
        for (body in listOf(discovery("""{"enabled":false}"""), discovery("""{"enabled":true,"endpoints":{}}"""))) {
            val w = world(body)
            val client = IdentityClient(w.core)
            assertEquals(SubjectResult.Unavailable, client.subject())
            assertEquals(SignOutResult.Unavailable, client.signOut())
            assertEquals(OpenAccountResult.Unavailable, client.openAccount())
            assertTrue(w.transport.requests().none { it.path != "/djdl/.well-known/polaris.json" })
            assertEquals("pkeyt_token", w.store.getToken())
        }
    }

    @Test
    fun theSubjectIsStoredAndForgottenWhenTheServerSaysNull() = runBlocking {
        val seen = mutableListOf<String?>()
        val w = world(withAccount)
        val client = IdentityClient(w.core, onSubject = { seen += it })
        assertEquals(SubjectResult.Subject("ps_abc"), client.subject())
        assertEquals("ps_abc", w.core.storedSubject())
        assertEquals(SubjectResult.Subject("ps_abc"), client.subject())
        assertEquals(listOf<String?>("ps_abc"), seen)
        assertEquals("Bearer pkeyt_token", w.transport.requests().last().headers["authorization"])

        val none = world(withAccount, subject = """{"subject":null}""")
        none.core.setSubject("ps_old")
        assertEquals(SubjectResult.None, IdentityClient(none.core).subject())
        assertNull(none.core.storedSubject())
    }

    @Test
    fun aDeviceWithNoTokenIsNotAskedForASubject() = runBlocking {
        val w = world(withAccount)
        w.core.clearAll()
        assertEquals(SubjectResult.None, IdentityClient(w.core).subject())
        assertTrue(w.transport.requests().none { it.path == "/djdl/identity/subject" })
    }

    @Test
    fun signOutRunsTheHooksFirstThenKeepsOrDropsTheToken() = runBlocking {
        val order = mutableListOf<String>()
        val kept = world(withAccount, signOut = """{"released":false}""")
        kept.core.setSubject("ps_abc")
        val client = IdentityClient(kept.core, onSubject = { order += "subject:$it" }, onSignedOut = { order += "wiped" })
        client.onBeforeSignOut { order += "flush-1" }
        client.onBeforeSignOut { order += "flush-2" }
        assertEquals(SignOutResult.SignedOut(false), client.signOut())
        assertEquals(listOf("flush-1", "flush-2", "subject:null"), order)
        assertEquals("pkeyt_token", kept.store.getToken())
        assertNull(kept.core.storedSubject())

        order.clear()
        val released = world(withAccount, signOut = """{"released":true}""")
        released.core.setSubject("ps_abc")
        val c2 = IdentityClient(released.core, onSubject = { order += "subject:$it" }, onSignedOut = { order += "wiped" })
        assertEquals(SignOutResult.SignedOut(true), c2.signOut())
        assertEquals(listOf("wiped", "subject:null"), order)
        assertNull(released.store.getToken())
        assertNull(released.core.storedSubject())
    }

    @Test
    fun aThrowingHookStopsTheSignOutBeforeAnyRequest() = runBlocking {
        val w = world(withAccount, signOut = """{"released":true}""")
        val client = IdentityClient(w.core)
        client.onBeforeSignOut { throw PolarisException(ErrorCode.syncFailed, "flush failed") }
        try {
            client.signOut()
            fail("expected the hook's failure")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.syncFailed, e.code)
        }
        assertTrue(w.transport.requests().none { it.path == "/djdl/identity/signout" })
        assertEquals("pkeyt_token", w.store.getToken())
    }

    @Test
    fun openAccountHandsThePublishedUrlToTheOpener() = runBlocking {
        val w = world(withAccount)
        val opened = mutableListOf<String>()
        val opening = IdentityClient(w.core, opener = AccountOpener { opened += it; true })
        assertEquals(OpenAccountResult.Opened("https://key.plrs.im/#/p/djdl"), opening.openAccount())
        assertEquals(listOf("https://key.plrs.im/#/p/djdl"), opened)
        assertEquals(OpenAccountResult.NotOpened("https://key.plrs.im/#/p/djdl"), IdentityClient(w.core).openAccount())
        assertEquals(
            OpenAccountResult.NotOpened("https://key.plrs.im/#/p/djdl"),
            IdentityClient(w.core, opener = AccountOpener { throw IllegalStateException("no browser") }).openAccount(),
        )
    }
}
