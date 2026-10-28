// @pkey-feature connect.relay
//
// `client.connect.relayTicket()` and the peer-source plumbing around it (CC-12.4; WIRE-CONTRACT-V5
// section 15.7, plans CC-01 G11, G12, G13, G20): the grant checks (shape, `wss:` and the Worker's own
// host, the protocol), the typed refusals with their registered codes, `retryAfter` and `scope`, a new
// ticket every call, no ticket in any string, and `adoptRing` with `keysStale`. The recorded refusals
// replay in :conformance (TranscriptTest, connect-relay-ticket and connect-relay-quota).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.ERROR_CODE_VALUES
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.jsonInt
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConnectRelayTicketTest {
    private val deviceId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val signer = TestSigner()
    private val now = 1_700_000_000L
    private val home = "key.plrs.im"
    private var counter = 0
    private var ticketStatus = 200
    private var ticketBody: String? = null
    private var ticketHeaders: Map<String, String> = emptyMap()
    private var ticketCalls = 0
    private var authSeen: String? = null
    private var epoch = 1L
    private var others: List<Triple<String, String, String>> = emptyList()
    private var discKeys: List<String> = listOf(b64(1), b64(2))

    private fun b64(seed: Int) = Base64Url.encode(ByteArray(32) { (seed + it).toByte() })

    private fun newTicket(): String = "pkeyrt_" + "%032d".format(++counter).replace('0', 'A')

    private fun okBody(url: String = "wss://$home/djdl/connect/relay", protocol: String = RELAY_PROTOCOL, ticket: String = newTicket()): String =
        """{"ticket":"$ticket","url":"$url","protocol":"$protocol","expiresAt":${now + 60}}"""

    private fun ring(devs: List<Triple<String, String, String>>, epoch: Long, subject: String = sub): String = signer.sign(
        "pkey-ring+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"),
                "aud" to JsonPrimitive("djdl"),
                "sub" to JsonPrimitive(subject),
                "epoch" to jsonInt(epoch),
                "issuedAt" to jsonInt(now),
                "expiresAt" to jsonInt(now + 604_800),
                "devices" to JsonArray(
                    devs.sortedBy { it.first }.map {
                        JsonObject(
                            mapOf(
                                "deviceId" to JsonPrimitive(it.first),
                                "signKey" to JsonPrimitive(it.second),
                                "agreeKey" to JsonPrimitive(it.third),
                            ),
                        )
                    },
                ),
            ),
        ),
    )

    private fun handle(r: PolarisRequest, port: DeviceKeyPort): PolarisResponse = when {
        r.path.endsWith("/.well-known/polaris.json") ->
            respond(200, """{"product":"djdl","services":{"connect":{"enabled":true,"endpoints":{"identity":"x"}}}}""")

        r.path.endsWith("/devices/keys") -> respond(200, """{"keySeq":1}""")

        r.path.endsWith("/connect/relay/ticket") -> {
            ticketCalls++
            authSeen = r.headers.entries.firstOrNull { it.key.equals("authorization", true) }?.value
            if (ticketStatus == 200) respond(200, ticketBody ?: okBody()) else respond(ticketStatus, ticketBody ?: "", ticketHeaders)
        }

        r.path.endsWith("/connect/identity") -> runBlocking {
            val mine = port.ensure()
            val all = others + Triple(deviceId, mine.signKey, mine.agreeKey)
            val cert = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                        "deviceId" to JsonPrimitive(deviceId), "signKey" to JsonPrimitive(mine.signKey), "agreeKey" to JsonPrimitive(mine.agreeKey),
                        "ringEpoch" to jsonInt(epoch), "issuedAt" to jsonInt(now), "expiresAt" to jsonInt(now + 604_800),
                    ),
                ),
            )
            respond(
                200,
                JsonObject(
                    mapOf(
                        "ring" to JsonPrimitive(ring(all, epoch)),
                        "certificate" to JsonPrimitive(cert),
                        "discKeys" to JsonArray(discKeys.map { JsonPrimitive(it) }),
                    ),
                ).toString(),
            )
        }

        else -> respond(404, "")
    }

    private class Rig(val client: PolarisKeyClient, val port: DeviceKeyPort)

    private fun rig(token: String? = "pkeyt_held", baseUrl: String = "https://$home"): Rig = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val store = InMemoryStore("djdl", deviceId)
        token?.let { store.setToken(it) }
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", baseUrl = baseUrl, pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, transport = ScriptedTransport { handle(it, port) }, clock = { now }, deviceName = "Test Device",
                ),
                license = LicenseClientOptions(fingerprint = false),
                connect = ConnectOptions(deviceKeys = port, allowEphemeralKeys = true),
            ),
        )
        Rig(client, port)
    }

    private inline fun relayRefusal(reason: RelayErrorReason, block: () -> Unit): RelayException {
        try {
            block()
        } catch (e: RelayException) {
            assertEquals(reason, e.reason)
            assertEquals(reason.code, e.code)
            return e
        }
        fail("expected relay $reason")
        error("unreachable")
    }

    @Test
    fun grantsATicketBoundToTheWorkersHostAndNeverRepeatsOne() = runBlocking {
        val r = rig()
        val a = r.client.connect.relayTicket()
        val b = r.client.connect.relayTicket()
        assertEquals("wss://$home/djdl/connect/relay", a.url)
        assertEquals(RELAY_PROTOCOL, a.protocol)
        assertEquals(now + 60, a.expiresAt)
        assertNotEquals(a.ticket, b.ticket)
        assertEquals("Bearer pkeyt_held", authSeen)
        assertEquals(2, ticketCalls)
    }

    @Test
    fun noTicketAppearsInAnyStringOrError() = runBlocking {
        val r = rig()
        val g = r.client.connect.relayTicket()
        assertFalse(g.toString().contains(g.ticket))
        ticketBody = okBody(url = "ws://$home/x", ticket = g.ticket)
        val e = relayRefusal(RelayErrorReason.ticket_invalid) { runBlocking { r.client.connect.relayTicket() } }
        assertFalse((e.message + e.toString()).contains(g.ticket))
    }

    @Test
    fun refusesAnAnswerThatIsNotInTheContractShape() {
        val r = rig()
        val bad = listOf(
            "not json",
            "[]",
            """{"ticket":"pkeyrt_short","url":"wss://$home/x","protocol":"$RELAY_PROTOCOL","expiresAt":1}""",
            okBody(protocol = "pkey-relay.2"),
            okBody(url = "ws://$home/djdl/connect/relay"),
            okBody(url = "https://$home/djdl/connect/relay"),
            okBody(url = "wss://evil.example/djdl/connect/relay"),
            okBody(url = "wss://$home.evil.example/djdl/connect/relay"),
            okBody(url = "wss://user@evil.example/djdl/connect/relay"),
            okBody(url = "wss://$home:444/djdl/connect/relay"),
            okBody(ticket = "pkeyrt_" + "A".repeat(33)),
            okBody(ticket = "pkeyt_" + "A".repeat(32)),
            """{"ticket":"${newTicket()}","url":"wss://$home/x","protocol":"$RELAY_PROTOCOL"}""",
            """{"ticket":"${newTicket()}","url":"wss://$home/x","protocol":"$RELAY_PROTOCOL","expiresAt":"soon"}""",
        )
        for (body in bad) {
            ticketBody = body
            relayRefusal(RelayErrorReason.ticket_invalid) { runBlocking { r.client.connect.relayTicket() } }
        }
    }

    @Test
    fun mapsTheWorkersRefusalsToRegisteredCodes() {
        val r = rig()
        ticketStatus = 403
        ticketBody = """{"error":{"code":"relay_disabled"}}"""
        assertEquals(403, relayRefusal(RelayErrorReason.disabled) { runBlocking { r.client.connect.relayTicket() } }.httpStatus)

        ticketStatus = 503
        ticketBody = """{"error":"relay_paused"}"""
        ticketHeaders = mapOf("Retry-After" to "300")
        val paused = relayRefusal(RelayErrorReason.paused) { runBlocking { r.client.connect.relayTicket() } }
        assertEquals(300, paused.retryAfterSeconds)

        ticketHeaders = mapOf("retry-after" to "999999")
        assertEquals(
            RELAY_RETRY_AFTER_CAP_SECONDS,
            relayRefusal(RelayErrorReason.paused) {
                runBlocking { r.client.connect.relayTicket() }
            }.retryAfterSeconds,
        )
        ticketHeaders = mapOf("retry-after" to "soon")
        assertNull(relayRefusal(RelayErrorReason.paused) { runBlocking { r.client.connect.relayTicket() } }.retryAfterSeconds)

        ticketStatus = 429
        ticketHeaders = emptyMap()
        ticketBody = """{"error":{"code":"relay_quota_exceeded"},"scope":"product"}"""
        assertEquals(RelayQuotaScope.product, relayRefusal(RelayErrorReason.quota) { runBlocking { r.client.connect.relayTicket() } }.scope)
        ticketBody = """{"error":{"code":"relay_quota_exceeded"},"scope":"galaxy"}"""
        assertNull(relayRefusal(RelayErrorReason.quota) { runBlocking { r.client.connect.relayTicket() } }.scope)

        ticketStatus = 403
        ticketBody = """{"error":{"code":"relay_ticket_invalid"}}"""
        relayRefusal(RelayErrorReason.ticket_invalid) { runBlocking { r.client.connect.relayTicket() } }

        // Anything else is the Worker's own refusal, with its status and no relay reason.
        ticketStatus = 404
        ticketBody = """{"error":{"code":"not_found"}}"""
        try {
            runBlocking { r.client.connect.relayTicket() }
            fail("expected a refusal")
        } catch (e: RelayException) {
            fail("a plain refusal is not a relay error")
        } catch (e: PolarisException) {
            assertEquals("not_found", e.code)
            assertEquals(404, e.httpStatus)
        }
    }

    @Test
    fun withoutATokenItIsNoTokenAndNothingIsSent() {
        val r = rig(token = null)
        try {
            runBlocking { r.client.connect.relayTicket() }
            fail("expected no-token")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.noToken, e.code)
        }
        assertEquals(0, ticketCalls)
    }

    @Test
    fun everyReasonMapsToARegisteredCode() {
        for (reason in LanErrorReason.values()) assertTrue(reason.name, (reason.code in ERROR_CODE_VALUES))
        for (reason in RelayErrorReason.values()) assertTrue(reason.name, (reason.code in ERROR_CODE_VALUES))
    }

    @Test
    fun peerSourceNeedsAHeldIdentityThenSnapshotsIt() = runBlocking {
        val r = rig()
        try {
            r.client.connect.peerSource()
            fail("expected no_identity")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.no_identity, e.reason)
            assertEquals(ErrorCode.notConfigured, e.code)
        }
        val id = r.client.connect.identity()
        val src = r.client.connect.peerSource()
        assertEquals(id.sub, src.sub)
        assertEquals(listOf(deviceId), src.roster)
        assertEquals(32, src.agreePublic.size)
        assertEquals(2, if (src.discovery.previous != null) 2 else 1)
        assertFalse(src.toString().contains(src.certificate))
    }

    @Test
    fun adoptRingStoresANewerRosterAndKeysStaleHoldsUntilARefresh() = runBlocking {
        val r = rig()
        val peer = Triple("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", b64(7), b64(8))
        others = listOf(peer)
        r.client.connect.identity()
        val mine = r.port.publicKeys()!!
        val me = Triple(deviceId, mine.signKey, mine.agreeKey)
        assertNotEquals(null, r.client.connect.discoveryKeys()?.previous)

        // A newer roster that keeps every device keeps the previous key.
        val kept = r.client.connect.adoptRing(ring(listOf(me, peer, Triple("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", b64(9), b64(10))), 2))
        assertEquals(2L, (kept as RingAdoption.Stored).epoch)
        assertNotEquals(null, r.client.connect.discoveryKeys()?.previous)

        // The same or a lower epoch, another subject, and a roster without this device are refused.
        assertEquals("epoch-not-higher", (r.client.connect.adoptRing(ring(listOf(me, peer), 2)) as RingAdoption.Refused).reason)
        assertEquals(
            "other-product-or-subject",
            (r.client.connect.adoptRing(ring(listOf(me, peer), 3, "ps_ZzZzZzZzZzZzZzZzZzZzZz")) as RingAdoption.Refused).reason,
        )
        assertEquals("device_not_in_roster", (r.client.connect.adoptRing(ring(listOf(peer), 3)) as RingAdoption.Refused).reason)
        assertEquals("new-rejected", (r.client.connect.adoptRing("not a jws") as RingAdoption.Refused).reason)

        // A roster that drops a device is stored, and K_disc is not used until a refresh brings the new one.
        val dropped = r.client.connect.adoptRing(ring(listOf(me), 4))
        assertEquals(4L, (dropped as RingAdoption.Stored).epoch)
        assertNull(r.client.connect.discoveryKeys())
        try {
            r.client.connect.peerSource()
            fail("expected no_keys")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.no_keys, e.reason)
        }
        epoch = 4
        others = emptyList()
        discKeys = listOf(b64(3))
        r.client.connect.identity(refresh = true)
        assertTrue(r.client.connect.discoveryKeys() != null)
        assertNull(r.client.connect.discoveryKeys()!!.previous)
    }

    @Test
    fun adoptRingWithNothingHeldIsRefused() = runBlocking {
        val r = rig()
        assertEquals("no_identity", (r.client.connect.adoptRing(ring(emptyList(), 2)) as RingAdoption.Refused).reason)
    }
}
