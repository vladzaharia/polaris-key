// @pkey-feature identity.link
//
// The link offer through the umbrella client and its Java futures: a redirect sign-in this device started opens it,
// the futures return what the suspend API returns, and a decline is kept for the account.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import im.plrs.key.identity.ConformanceReplayOnly
import im.plrs.key.identity.LinkAcceptResult
import im.plrs.key.identity.LinkOfferResult
import im.plrs.key.identity.RedirectEntropy
import im.plrs.key.identity.SignInChannel
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.redirectAcquisitionSync
import im.plrs.key.identity.redirectEntropy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

@OptIn(ConformanceReplayOnly::class)
class LinkFacadeTest {
    private class Durable(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private val base = "https://key.plrs.im/djdl/identity"
    private val handle = "lh_" + "C".repeat(43)
    private val state = "tidewater-state-0123456789"
    private val verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private val discovery = """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"$base",""" +
        """"endpoints":{"authorize":"$base/authorize","token":"$base/token","link":"$base/link"}}}}"""
    private val token = """{"access_token":"pkeyt_signed","token_type":"Bearer","scope":"profile email","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ"}"""

    @Test
    fun aRedirectSignInOpensTheOfferAndTheFuturesAnswerLikeTheSuspendApi() = runBlocking {
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery)

                "/djdl/identity/token" -> respond(200, token)

                "/djdl/identity/link" ->
                    if (r.method ==
                        "GET"
                    ) {
                        respond(200, """{"offer":[{"kind":"google","reach":null}]}""")
                    } else {
                        respond(200, """{"linked":{"kind":"google","reach":"global"}}""")
                    }

                else -> respond(404)
            }
        }
        val options = PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = "djdl",
                version = "1.0.0",
                pinnedKeys = emptyMap(),
                trustRefresh = false,
                store = InMemoryStore("djdl", "DEVICE00000000000000000000000001"),
                transport = transport,
                expectedServices = listOf(ServiceSlug.identity),
                clock = { 1_700_000_000L },
            ),
        )
        val client = PolarisKeyClient.create(options)
        client.useDeviceKeys(DeviceKeyStore(Durable()))
        client.identity.redirectAcquisitionSync = false
        val pk = PolarisKeyFutures(client)
        // Before any sign-in: nothing to offer, nothing sent.
        assertEquals(LinkOfferResult.Unavailable, pk.linkOffer().get(10, TimeUnit.SECONDS))
        client.identity.redirectEntropy = RedirectEntropy(state, verifier)
        val session = client.identity.signIn.start(
            SignInOptions(channel = SignInChannel.Redirect, redirectUri = "https://app.example/auth/callback"),
        )
        val out = session.complete("https://app.example/auth/callback?code=abc&state=$state&iss=${java.net.URLEncoder.encode(base, "UTF-8")}")
        assertTrue((out as SignInOutcome.SignedIn).sameDevice)
        assertTrue(client.identity.link.pending)
        val offer = pk.linkOffer().get(10, TimeUnit.SECONDS) as LinkOfferResult.Ok
        assertEquals("google", offer.kinds.single().kind)
        assertEquals(LinkAcceptResult.Linked("google", "global"), pk.linkAccept(handle).get(10, TimeUnit.SECONDS))
        pk.linkDecline().get(10, TimeUnit.SECONDS)
        assertFalse(client.identity.link.pending)
        assertEquals(LinkOfferResult.Unavailable, pk.linkOffer().get(10, TimeUnit.SECONDS))
        client.close()
    }
}
