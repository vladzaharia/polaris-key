// @pkey-feature identity.devicecode.choice
//
// UK-42.22 (WIRE-CONTRACT-V5 section 12.10): the device-code start sends the four members only when the discovery
// gate passes (`deviceChoice` and the four `choice*` routes), and a poll `choose` settles the session as the
// redirect's `SignInOutcome.Choose`; one nobody asked for is a refused sign-in. The wire conversation is the
// transcript `holders-add-to-account-device`'s.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DeviceChoiceTest {
    private val api = "https://key.example/djdl"
    private val grant = "sg_" + "a".repeat(43)
    private val chooseBody =
        """{"status":"choose","grant":"$grant","expiresIn":300,"choices":""" +
            """{"state":"choose","choices":[],"keep":true,"preselected":null,"create":null,"getLicense":null}}"""

    private fun discovery(deviceChoice: Boolean, routes: Boolean): String {
        val member = if (deviceChoice) ""","deviceChoice":true""" else ""
        val r = if (routes) {
            listOf("licenses", "devices", "complete", "cancel").joinToString("") {
                ""","choice${it.replaceFirstChar { c -> c.uppercase() }}":"$api/identity/choice/$it""""
            }
        } else {
            ""
        }
        return """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"$api/identity"$member,""" +
            """"endpoints":{"authorize":"$api/identity/authorize","token":"$api/identity/token"$r}}}}"""
    }

    private fun world(deviceChoice: Boolean = true, routes: Boolean = true): Pair<IdentityClient, ScriptedTransport> {
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery(deviceChoice, routes))

                "/djdl/identity/auth/device/start" -> respond(
                    200,
                    """{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d",""" +
                        """"verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}""",
                )

                "/djdl/identity/auth/device/poll" -> respond(200, chooseBody)

                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = InMemoryStore("djdl", "dev"), transport = transport, clock = {
                    1_700_000_000L
                }, expectedServices = listOf(ServiceSlug.identity),
            ),
        )
        runBlocking { core.start() }
        return IdentityClient(core) to transport
    }

    private suspend fun sent(t: ScriptedTransport) = Json.parseToJsonElement(
        String(t.requests().first { it.path == "/djdl/identity/auth/device/start" }.body!!, Charsets.UTF_8),
    ).jsonObject

    @Test
    fun theGatePassingSendsTheFourMembersAndAChoosePollSettlesTheLicenceChoice() = runBlocking {
        val (client, transport) = world()
        val session = client.signIn.start(
            SignInOptions(loginHint = "ada@example.com", nameHint = "Ada", purpose = SignInPurpose.Attach, licenseChoice = "app"),
        )
        val body = sent(transport)
        assertEquals("app", body["licenseChoice"]!!.jsonPrimitive.content)
        assertEquals("attach", body["purpose"]!!.jsonPrimitive.content)
        assertEquals("ada@example.com", body["loginHint"]!!.jsonPrimitive.content)
        assertEquals("Ada", body["nameHint"]!!.jsonPrimitive.content)
        val outcome = session.wait(once = true)
        assertTrue(outcome is SignInOutcome.Choose)
        outcome as SignInOutcome.Choose
        assertEquals(grant, outcome.grant)
        assertEquals(300.0, outcome.expiresIn, 0.0)
        assertFalse(outcome.toString().contains(grant))
    }

    @Test
    fun withoutTheDiscoveryGateTheStartSendsNoLicenceChoiceButTheHintsRide() = runBlocking {
        for ((gate, routes) in listOf(false to true, true to false)) {
            val (client, transport) = world(deviceChoice = gate, routes = routes)
            client.signIn.start(SignInOptions(purpose = SignInPurpose.SignIn, licenseChoice = "app"))
            val body = sent(transport)
            assertNull("gate=$gate routes=$routes", body["licenseChoice"])
            assertEquals("signin", body["purpose"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun aChoosePollThatWasNotAskedForIsAFailedSignIn() = runBlocking {
        val (client, _) = world()
        val session = client.signIn.start()
        try {
            session.wait(once = true)
            fail("accepted a choose nobody asked for")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
    }
}
