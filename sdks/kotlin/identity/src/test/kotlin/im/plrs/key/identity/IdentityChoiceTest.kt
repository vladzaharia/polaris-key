// @pkey-feature identity.choice
//
// `identity.choice.*` beyond what the choice-* transcripts pin (I-10b.19): the typed N/A with no request
// when discovery names no endpoint, a refusal is a result that keeps the device token, `Keep` says
// attachable, the retry data and the fresh view ride a refusal, no bearer is sent, and the grant never
// shows in a thrown error or in `toString`.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentityChoiceTest {
    private val grant = "sg_" + "A".repeat(43)
    private val base = "https://key.plrs.im/djdl/identity/choice"
    private val all = """"choiceLicenses":"$base/licenses","choiceDevices":"$base/devices","choiceComplete":"$base/complete","choiceCancel":"$base/cancel""""
    private fun discovery(endpoints: String) = """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"endpoints":{$endpoints}}}}"""
    private val view = """{"state":"choose","choices":[{"id":"lic_1","state":"ok"}],"keep":false,"preselected":null,"create":null,"getLicense":null}"""
    private val tokenOk = """{"access_token":"pkeyt_chosen","token_type":"Bearer","scope":"profile email","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":{"id":"lic_1"},"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ","keyEntries":{"used":1,"limit":10}}"""

    private class World(val client: IdentityClient, val transport: ScriptedTransport, val store: InMemoryStore, val core: CoreContext)

    private fun world(endpoints: String = all, status: Int = 200, body: String = "{}", headers: Map<String, String> = emptyMap()): World {
        val store = InMemoryStore("djdl", "dev1")
        runBlocking { store.setToken("pkeyt_old") }
        val transport = ScriptedTransport { r: PolarisRequest ->
            when {
                r.path == "/djdl/.well-known/polaris.json" -> respond(200, discovery(endpoints))
                r.path.startsWith("/djdl/identity/choice/") -> respond(status, body, headers)
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
        return World(IdentityClient(core, onAcquired = null), transport, store, core)
    }

    @Test
    fun withoutAnEndpointEachCallIsTheTypedNaAndDialsNothingPastDiscovery() = runBlocking {
        val w = world(endpoints = """"choiceLicenses":"$base/licenses"""")
        val calls: List<suspend () -> Any?> = listOf(
            { w.client.choice.devices(grant, "lic_1") },
            { w.client.choice.complete(grant, LicenseChoice.Keep) },
            { w.client.choice.cancel(grant) },
        )
        for (call in calls) {
            try {
                call()
                fail("expected service-unavailable")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.serviceUnavailable, e.code)
                assertEquals(Feature.identityChoice, e.unsupported?.feature)
                assertFalse(e.message!!.contains(grant))
            }
        }
        assertTrue(w.transport.requests().none { it.path.contains("/choice/") })
    }

    @Test
    fun completeStoresTheTokenAndSaysAttachableAfterKeepOnly() = runBlocking {
        val seen = mutableListOf<String?>()
        val w = world(body = tokenOk)
        val client = IdentityClient(w.core, onSubject = { seen += it })
        val kept = client.choice.complete(grant, LicenseChoice.Keep) as ChoiceResult.Ok
        assertEquals(ChoiceCompleted("lic_1", "ps_QQMMVm-ciTWvmWEIfhAVgQ", "profile email", ChoiceKeyEntries(1, 10), attachable = true), kept.value)
        assertEquals("pkeyt_chosen", w.store.getToken())
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", w.core.storedSubject())
        assertEquals(listOf<String?>("ps_QQMMVm-ciTWvmWEIfhAVgQ"), seen)
        val picked = client.choice.complete(grant, LicenseChoice.License("lic_1")) as ChoiceResult.Ok
        assertFalse(picked.value.attachable)
    }

    @Test
    fun noBearerIsSentAndTheGrantRidesTheBodyOnly() = runBlocking {
        val w = world(body = tokenOk)
        w.client.choice.complete(grant, LicenseChoice.License("lic_1", "OTHER"))
        val sent = w.transport.requests().last { it.path.endsWith("/choice/complete") }
        assertNull(sent.headers.entries.firstOrNull { it.key.equals("authorization", ignoreCase = true) })
        assertEquals(
            """{"grant":"$grant","choice":{"kind":"license","licenseId":"lic_1","replaceDeviceId":"OTHER"}}""",
            String(sent.body!!),
        )
        assertFalse(sent.path.contains(grant))
    }

    @Test
    fun keepSendsTheDevicesBearerAndNoOtherChoiceDoes() = runBlocking {
        val w = world(body = tokenOk)
        w.client.choice.complete(grant, LicenseChoice.Keep)
        val kept = w.transport.requests().last { it.path.endsWith("/choice/complete") }
        assertEquals("Bearer pkeyt_old", kept.headers.entries.first { it.key.equals("authorization", ignoreCase = true) }.value)
    }

    @Test
    fun deviceLimitIsAResultWithTheFreshViewAndTheManageLinkAndTheTokenStays() = runBlocking {
        val w = world(
            status = 403,
            body = """{"error":{"code":"device_limit"},"limit":1,"deviceCount":1,"manageUrl":"https://key.plrs.im/manage","view":$view}""",
        )
        val r = w.client.choice.complete(grant, LicenseChoice.License("lic_1")) as ChoiceResult.Refused
        assertEquals("device_limit", r.code)
        assertEquals(403, r.httpStatus)
        assertEquals("https://key.plrs.im/manage", r.manageUrl)
        assertEquals(listOf("lic_1"), r.view!!.licenseIds)
        assertEquals("pkeyt_old", w.store.getToken())
        assertNull(w.core.storedSubject())
    }

    @Test
    fun rateLimitedCarriesTheWaitFromTheBodyOrTheHeader() = runBlocking {
        val body = world(status = 429, body = """{"error":{"code":"rate_limited"},"retryAfter":4.2}""")
        assertEquals(5, (body.client.choice.licenses(grant) as ChoiceResult.Refused).retryAfterSeconds)
        val header = world(status = 429, body = """{"error":{"code":"rate_limited"}}""", headers = mapOf("retry-after" to "7"))
        assertEquals(7, (header.client.choice.cancel(grant) as ChoiceResult.Refused).retryAfterSeconds)
    }

    @Test
    fun keyEntryLimitAndLicenseOwnedCarryTheirLinks() = runBlocking {
        val limit = world(status = 403, body = """{"error":"key_entry_limit","manageUrl":"https://key.plrs.im/m","keyEntries":{"used":10,"limit":10}}""")
        val l = limit.client.choice.complete(grant, LicenseChoice.Key("pkey_djdl_x")) as ChoiceResult.Refused
        assertEquals("key_entry_limit", l.code)
        assertEquals(ChoiceKeyEntries(10, 10), l.keyEntries)
        assertEquals("https://key.plrs.im/m", l.manageUrl)
        val owned = world(status = 409, body = """{"error":"license_owned","signInUrl":"https://key.plrs.im/signin"}""")
        val o = owned.client.choice.complete(grant, LicenseChoice.Key("pkey_djdl_x")) as ChoiceResult.Refused
        assertEquals("https://key.plrs.im/signin", o.signInUrl)
    }

    @Test
    fun aServerFailureThrowsAndNeverShowsTheGrant() = runBlocking {
        val w = world(status = 502, body = "bad gateway")
        try {
            w.client.choice.complete(grant, LicenseChoice.Keep)
            fail("expected server-error")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serverError, e.code)
            assertFalse(e.toString().contains(grant))
        }
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun theKeyAndTheGrantAreRedactedInToString() {
        assertFalse(LicenseChoice.Key("pkey_djdl_secret").toString().contains("secret"))
        val choose = SignInOutcome.Choose(grant, 300.0, kotlinx.serialization.json.JsonObject(emptyMap()))
        assertFalse(choose.toString().contains(grant))
    }
}
