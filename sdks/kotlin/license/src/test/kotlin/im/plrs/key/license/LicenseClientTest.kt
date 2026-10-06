// @pkey-feature license.entitlements license.channels license.activate license.enroll license.deactivate license.refusals
//
// The licence client over a signed document it verified itself: entitlements, the profile and the
// licence id are read off the VERIFIED licence document only; `entitledChannels()` is the
// Worker's answer (the `channels` entitlement's strings, raw, or `["stable"]`); the activation
// status ladder reads both error envelopes; deactivation wipes locally even when the server
// cannot be reached.

package im.plrs.key.license

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.TokenSource
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LicenseClientTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    private fun core(
        store: InMemoryStore,
        deviceName: String? = "Test Device",
        handler: (PolarisRequest) -> PolarisResponse,
    ): Pair<CoreContext, ScriptedTransport> {
        val transport = ScriptedTransport(handler)
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = store, transport = transport, clock = { now },
                // PX-W13: a fixed device label, so request bodies do not depend on the host name.
                deviceName = deviceName,
            ),
        )
        return core to transport
    }

    /** A client whose licence document carries [entitlements], verified through a sync pass. */
    private fun licensed(entitlements: Map<String, JsonElement>, profile: JsonObject? = null): LicenseClient = runBlocking {
        val store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }
        val doc = signer.licenseDoc("djdl", "dev1", now, entitlements, "lic_42", profile)
        val (core, _) = core(store) { r ->
            when (r.path) {
                "/djdl/license/document" -> respond(200, doc)
                else -> respond(404)
            }
        }
        core.start()
        core.sync()
        LicenseClient(core)
    }

    @Test
    fun entitlementsProfileAndLicenceIdComeOffTheVerifiedDocument() = runBlocking {
        val profile = JsonObject(mapOf("name" to JsonPrimitive("Ada Lovelace"), "firstName" to JsonPrimitive("Ada")))
        val client = licensed(mapOf("polarisVpn" to JsonPrimitive(true), "seats" to JsonPrimitive(3)), profile)
        assertEquals(LicenseStatus.ok, client.status().status)
        assertTrue(client.isLicensed())
        assertEquals(mapOf("polarisVpn" to JsonPrimitive(true), "seats" to JsonPrimitive(3)), client.entitlements())
        assertTrue(client.isEntitled("polarisVpn"))
        assertFalse(client.isEntitled("seats")) // present but not `true`
        assertFalse(client.isEntitled("absent"))
        assertEquals("lic_42", client.licenseId())
        assertEquals("Ada", client.profile()?.firstName)
    }

    @Test
    fun entitledChannelsAreTheGrantsRawOrStable() = runBlocking {
        val granted = JsonArray(listOf("stable", "staging", "pr", 7).map { if (it is Int) JsonPrimitive(it) else JsonPrimitive(it as String) })
        assertEquals(listOf("stable", "staging", "pr"), licensed(mapOf("channels" to granted)).entitledChannels())
        assertEquals(listOf("stable"), licensed(emptyMap()).entitledChannels())
        assertEquals(listOf("stable"), licensed(mapOf("channels" to JsonPrimitive("beta"))).entitledChannels())
    }

    @Test
    fun withoutADocumentNothingIsGranted() = runBlocking {
        val (core, _) = core(InMemoryStore("djdl", "dev1")) { respond(404) }
        core.start()
        val client = LicenseClient(core)
        assertEquals(LicenseStatus.needsActivation, client.status().status)
        assertTrue(client.entitlements().isEmpty())
        assertNull(client.licenseId())
        assertEquals(listOf("stable"), client.entitledChannels())
    }

    private val fingerprint = HardwareFingerprint(mapOf("machineUuid" to "abc"), "hwid")

    private fun activateAgainst(
        response: PolarisResponse,
        options: LicenseClientOptions = LicenseClientOptions(fingerprintSource = { fingerprint }),
        deviceName: String? = "Test Device",
    ) =
        runBlocking {
            val store = InMemoryStore("djdl", "dev1")
            var acquired = 0
            val (core, transport) = core(store, deviceName) { response }
            core.start()
            val result = LicenseClient(core, options) { acquired++ }.activate("pkey_djdl_key")
            Triple(result, transport.requests().single(), Triple(store.getToken(), core.tokenSource(), acquired))
        }

    @Test
    fun activationStoresTheTokenAndRaisesTheEvent() {
        val (result, request, state) = activateAgainst(respond(200, """{"token":"pkeyt_new","schemaVersion":1}"""))
        assertEquals(ActivationResult.Ok("pkeyt_new", 1), result)
        assertEquals("Bearer pkey_djdl_key", request.headers["authorization"])
        assertEquals("application/json", request.headers["content-type"])
        // PX-W13 §8 Q2: the device label rides along on activation.
        assertEquals(
            """{"fingerprint":{"components":{"machineUuid":"abc"},"hwid":"hwid"},"deviceName":"Test Device"}""",
            request.body!!.toString(Charsets.UTF_8),
        )
        assertEquals(Triple("pkeyt_new", TokenSource.activate, 1), state)
        assertFalse(result.toString().contains("pkeyt_new"))
    }

    @Test
    fun anOptedOutFingerprintAndLabelSendNoBody() {
        val (_, request, _) = activateAgainst(
            respond(200, """{"token":"pkeyt_new","schemaVersion":1}"""),
            LicenseClientOptions(fingerprint = false, fingerprintSource = { fingerprint }),
            deviceName = "",
        )
        assertNull(request.body)
        assertNull(request.headers["content-type"])
    }

    @Test
    fun anOptedOutFingerprintSendsTheLabelAlone() {
        val (_, request, _) = activateAgainst(
            respond(200, """{"token":"pkeyt_new","schemaVersion":1}"""),
            LicenseClientOptions(fingerprint = false, fingerprintSource = { fingerprint }),
        )
        assertEquals("""{"deviceName":"Test Device"}""", request.body!!.toString(Charsets.UTF_8))
    }

    @Test
    fun theStatusLadderReadsBothEnvelopes() {
        assertEquals(ActivationResult.FingerprintRequired, activateAgainst(respond(403, """{"error":"fingerprint_required"}""")).first)
        assertEquals(
            ActivationResult.FingerprintRequired,
            activateAgainst(respond(403, """{"error":{"code":"fingerprint_required"}}""")).first,
        )
        assertEquals(ActivationResult.DeviceLimit(3, 2), activateAgainst(respond(403, """{"error":"device_limit","limit":3,"deviceCount":2}""")).first)
        assertEquals(
            ActivationResult.DeviceLimit(5, 5),
            activateAgainst(respond(403, """{"error":{"code":"device_limit","limit":5,"deviceCount":5}}""")).first,
        )
        assertEquals(
            ActivationResult.HardwareMismatch(2, listOf("cpuModel")),
            activateAgainst(respond(409, """{"error":"hardware_mismatch","drift":2,"changed":["cpuModel"]}""")).first,
        )
        assertEquals(
            ActivationResult.HardwareMismatch(4, null),
            activateAgainst(respond(409, """{"error":{"code":"hardware_mismatch","drift":4}}""")).first,
        )
        assertEquals(ActivationResult.Unauthorized, activateAgainst(respond(401)).first)
        assertEquals(ActivationResult.EnrollDisabled, activateAgainst(respond(404)).first)
        assertTrue(activateAgainst(respond(200, "{}")).first is ActivationResult.Error)
        // A failed mint stores nothing and raises nothing.
        assertEquals(Triple(null, null, 0), activateAgainst(respond(401)).third)
    }

    /**
     * The shared activation table (notes/SDK-PARITY-PASS.md §3.1): the mapping goes by the body's
     * code, every refusal carries it, and an unknown 403 is `Refused` with the server's code, never
     * `DeviceLimit`.
     */
    @Test
    fun theActivationTableMapsEveryKindByCode() {
        fun map(status: Int, body: String, headers: Map<String, String> = emptyMap()) =
            LicenseEndpoints.activationResult(PolarisResponse(status, body.toByteArray(), headers))
        assertEquals(ActivationResult.EnrollClaimed, map(403, """{"error":"enroll_claimed","message":"sign in"}"""))
        assertEquals(ActivationResult.LicenseDisabled, map(403, """{"error":"license_disabled"}"""))
        assertEquals(ActivationResult.LicenseExpired, map(403, """{"error":{"code":"license_expired"}}"""))
        assertEquals(ActivationResult.AttestationRequired, map(403, """{"error":{"code":"attestation_required"}}"""))
        assertEquals(ActivationResult.RateLimited(30), map(429, """{"error":"rate_limited"}""", mapOf("retry-after" to "30")))
        assertEquals(ActivationResult.RateLimited(null), map(429, """{"error":"rate_limited"}"""))
        assertEquals(ActivationResult.EnrollDisabled, map(404, """{"error":"enroll_disabled","message":"enrollment is disabled"}"""))
        assertEquals(ActivationResult.Unauthorized, map(401, """{"error":"unauthorized"}"""))
        // Unknown 403s keep the server's code: I-09's additions arrive as a pure addition later.
        assertEquals(ActivationResult.Refused("registration_closed", 403, null), map(403, """{"error":{"code":"registration_closed"}}"""))
        assertEquals(ActivationResult.Refused("license_owned", 403, "sign in"), map(403, """{"error":"license_owned","message":"sign in"}"""))
        assertEquals(ActivationResult.Refused(ErrorCode.badRequest, 400, "missing device id"), map(400, """{"error":"bad_request","message":"missing device id"}"""))
        assertEquals(ActivationResult.Refused(ErrorCode.unknown, 403, null), map(403, "not json"))
        // A 5xx is `server-error`, a transport failure `network`; neither leaks the body as copy.
        val server = map(500, """{"error":"enroll_failed"}""")
        assertTrue(server is ActivationResult.Error && server.code == ErrorCode.serverError && server.status == 500)
        // Every kind but Ok names a registered code.
        for (r in listOf(
            ActivationResult.DeviceLimit(1, 1), ActivationResult.Unauthorized, ActivationResult.FingerprintRequired,
            ActivationResult.HardwareMismatch(null, null), ActivationResult.EnrollDisabled, ActivationResult.EnrollClaimed,
            ActivationResult.LicenseDisabled, ActivationResult.LicenseExpired, ActivationResult.AttestationRequired,
            ActivationResult.RateLimited(null), server,
        )) assertTrue("${r.code}", r.code in im.plrs.key.core.ERROR_CODE_VALUES)
        assertNull(ActivationResult.Ok("pkeyt_x", 1).code)
    }

    @Test
    fun aTransportFailureIsANetworkError() {
        val offline = runBlocking {
            val (core, _) = core(InMemoryStore("djdl", "dev1")) { throw PolarisException(ErrorCode.networkError, "offline") }
            core.start()
            LicenseClient(core, LicenseClientOptions(fingerprint = false)).activate("pkey_x")
        }
        assertEquals(ErrorCode.network, offline.code)
    }

    /** S-19 G11: an install whose gate is not usable is entitled to nothing, whatever its last document said. */
    @Test
    fun isEntitledIsFalseOnceTheGateIsNotUsable() = runBlocking {
        val client = licensed(mapOf("polarisVpn" to JsonPrimitive(true)))
        assertTrue(client.isEntitled("polarisVpn"))
        // Past graceUntil the gate reads expired: nothing is entitled.
        assertEquals(LicenseStatus.expired, client.status(now + 10L * 365 * 86_400).status)
        assertFalse(client.isEntitled("polarisVpn", now + 10L * 365 * 86_400))
        // The raw read stays available for display.
        assertEquals(JsonPrimitive(true), client.entitlementValue("polarisVpn"))
    }

    @Test
    fun isEntitledIsFalseAfterRevocation() = runBlocking {
        val store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }
        val doc = signer.licenseDoc("djdl", "dev1", now, mapOf("polarisVpn" to JsonPrimitive(true)), "lic_42", null)
        var revoked = false
        val (core, _) = core(store) { r ->
            when {
                revoked -> respond(401, """{"error":"unauthorized"}""")
                r.path == "/djdl/license/document" -> respond(200, doc)
                else -> respond(404)
            }
        }
        core.start()
        core.sync()
        val client = LicenseClient(core)
        assertTrue(client.isEntitled("polarisVpn"))
        revoked = true
        core.sync(force = true, reacquire = { _, _ -> null })
        assertEquals(LicenseStatus.revoked, client.status().status)
        assertFalse(client.isEntitled("polarisVpn"))
    }

    @Test
    fun licenseInfoReadsTheEnforcedEntitlements() = runBlocking {
        val profile = JsonObject(mapOf("name" to JsonPrimitive("Ada Lovelace"), "firstName" to JsonPrimitive("Ada")))
        val client = licensed(
            mapOf(
                "license.tier" to JsonPrimitive("pro"), "license.tierLabel" to JsonPrimitive("Pro"),
                "deviceLimit" to JsonPrimitive(3), "channels" to JsonArray(listOf(JsonPrimitive("stable"), JsonPrimitive("beta"))),
            ),
            profile,
        )
        val info = client.licenseInfo()!!
        assertEquals(LicenseInfo("lic_42", "pro", "Pro", 3, null, null, client.profile(), listOf("stable", "beta")), info)
        assertEquals("Ada", info.profile?.firstName)
        val (core, _) = core(InMemoryStore("djdl", "dev1")) { respond(404) }
        core.start()
        assertNull(LicenseClient(core).licenseInfo())
    }

    @Test
    fun deactivationWipesLocallyEvenWhenTheServerIsUnreachable() = runBlocking {
        val store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }
        val (core, transport) = core(store) { throw PolarisException(ErrorCode.networkError, "offline") }
        core.start()
        LicenseClient(core).deactivate()
        assertNull(store.getToken())
        assertEquals("/djdl/license/deauthorize", transport.requests().single().path)
        assertEquals(LicenseStatus.needsActivation, LicenseClient(core).status().status)
    }
}
