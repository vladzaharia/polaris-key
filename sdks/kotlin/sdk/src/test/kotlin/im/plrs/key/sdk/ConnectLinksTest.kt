// @pkey-feature connect.links
//
// Inter-account links through the Kotlin SDK (WIRE-CONTRACT-V5 sections 15.4, 15.7 and 15.10): two accounts
// meeting in mode `c` over the LAN (a fake directory, real loopback TCP) and through a contact room (an
// in-process room that speaks aliases only), the contact rows in the Connect record, the typed gate and the
// contact ticket. The corpus `contact` rows are in :conformance (PeerMatrixContactTest) and the transcripts
// replay in TranscriptTest. Mirrors the Node package's `test/connect/links.test.ts`.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.contactAlias
import im.plrs.key.core.peer.contactRid
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.encodeRelay
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class ConnectLinksTest : ConnectLanBase() {
    /** Two devices of two accounts and the contact between them (what a pairing would have stored). */
    private inner class Link {
        val a = device(idA)
        val b = device(idB)
        val secret = rnd()

        fun live(key: String, reachable: Boolean = true, pending: Boolean = false) = LiveContact(
            contactId(key),
            key,
            Base64Url.decodeStrict(key)!!,
            secret.copyOf(),
            "Peer",
            listOf("docs"),
            reachable,
            pending,
        )

        fun forA(reachable: Boolean = true, pending: Boolean = false, key: String = b.agreeKey) = live(key, reachable, pending)

        fun forB(reachable: Boolean = true) = live(a.agreeKey, reachable)
    }

    private class Contacts(initial: List<LiveContact>) {
        @Volatile
        var list: List<LiveContact> = initial
        val fns = CopyOnWriteArrayList<() -> Unit>()
        val promoted = CopyOnWriteArrayList<ContactRef>()

        fun set(l: List<LiveContact>) {
            list = l
            for (f in fns) f()
        }
    }

    private fun lanSource(w: World, d: Device, c: Contacts): LanSource = LanSource(
        load = { w.peerSource(d, roster = listOf(d.id)) },
        now = { w.now },
        // A fresh copy each call: the service zeroes what it replaces.
        contacts = {
            c.list.map { LiveContact(it.id, it.agreeKey, it.agreeKeyBytes.copyOf(), it.secret.copyOf(), it.label, it.cats, it.reachable, it.pending) }
        },
        onContacts = { fn ->
            c.fns += fn
            ({ c.fns -= fn })
        },
        contactEstablished = { c.promoted += it },
    )

    // Each device is its own account here: a roster of one, so no account peer is ever found.
    private fun start(w: World, d: Device, c: Contacts): LanService = w.start(d, lanSource(w, d, c))

    // -- LAN ----------------------------------------------------------------------------------------

    @Test
    fun twoAccountsMeetInModeCAndTheContactIsCarried() {
        val link = Link()
        val w = World()
        val a = start(w, link.a, Contacts(listOf(link.forA())))
        val b = start(w, link.b, Contacts(listOf(link.forB())))
        val inbound = CopyOnWriteArrayList<ConnectSession>()
        val plain = CopyOnWriteArrayList<ConnectSession>()
        b.onContactSession { inbound += it }
        b.onSession { plain += it }
        // Account adverts plus one contact advert each: the names differ per advertiser.
        until { w.net.names().size == 4 }
        until { a.contactPeerIds().isNotEmpty() }
        val s = runBlocking { a.connectContact(link.forA().id) }
        assertEquals(link.forA().id, s.contact?.id)
        assertEquals("Peer", s.contact?.label)
        assertEquals(listOf("docs"), s.contact?.categories)
        assertEquals("", s.peerDeviceId)
        until { inbound.isNotEmpty() }
        val r = inbound[0]
        assertEquals(link.forB().id, r.contact?.id)
        assertTrue("a contact session is not handed to the account listener", plain.isEmpty())
        runBlocking { s.send("ping".toByteArray()) }
        assertEquals("ping", String(runBlocking { r.receive(5000).body }))
        runBlocking { s.close() }
        until { r.closed != null }
    }

    @Test
    fun nothingIsAdvertisedWhileLinksAreOff() {
        val link = Link()
        val w = World()
        val a = start(w, link.a, Contacts(emptyList()))
        start(w, link.b, Contacts(emptyList()))
        assertEquals("account adverts only", 2, w.net.names().size)
        assertTrue(a.contactPeerIds().isEmpty())
    }

    @Test
    fun aContactNotMarkedReachableIsNotAdvertised() {
        val link = Link()
        val w = World()
        start(w, link.a, Contacts(listOf(link.forA(reachable = false))))
        assertEquals(1, w.net.names().size)
    }

    @Test
    fun theLiveAdvertsAreCappedAtEight() {
        val link = Link()
        val w = World()
        val many = (0 until 12).map {
            val key = Base64Url.encode(rnd())
            LiveContact(contactId(key), key, Base64Url.decodeStrict(key)!!, rnd(), null, emptyList(), true, false)
        }
        start(w, link.a, Contacts(many))
        assertEquals(1 + 8, w.net.names().size)
    }

    @Test
    fun removingAContactWithdrawsItsAdvertAndStopsAnsweringIt() {
        val link = Link()
        val w = World()
        val ca = Contacts(listOf(link.forA()))
        val cb = Contacts(listOf(link.forB()))
        val a = start(w, link.a, ca)
        start(w, link.b, cb)
        until { a.contactPeerIds().isNotEmpty() }
        assertEquals(4, w.net.names().size)
        cb.set(emptyList())
        until { w.net.names().size == 3 }
        // B no longer holds the secret: a dial from A fails the handshake silently.
        try {
            runBlocking { a.connectContact(link.forA().id) }
            fail("B answered a removed contact")
        } catch (e: LanException) {
            // Not answered: the advert is gone (unknown peer), or the socket was dialled and the tag failed.
            assertTrue(e.reason in setOf(LanErrorReason.unknown_peer, LanErrorReason.handshake_failed, LanErrorReason.connect_failed))
        }
    }

    @Test
    fun aPendingContactIsPromotedByItsFirstHandshake() {
        val link = Link()
        val w = World()
        val ca = Contacts(listOf(link.forA(pending = true)))
        val a = start(w, link.a, ca)
        start(w, link.b, Contacts(listOf(link.forB())))
        until { a.contactPeerIds().isNotEmpty() }
        val s = runBlocking { a.connectContact(link.forA().id, pending = true) }
        assertEquals(true, s.contact?.pending)
        until { ca.promoted.isNotEmpty() }
        assertEquals(link.b.agreeKey, ca.promoted[0].agreeKey)
        runBlocking { s.close() }
    }

    @Test
    fun aContactAdvertIsNeverDialledAsAnAccountDevice() {
        val link = Link()
        val w = World()
        val a = start(w, link.a, Contacts(listOf(link.forA())))
        start(w, link.b, Contacts(listOf(link.forB())))
        until { a.contactPeerIds().isNotEmpty() }
        assertTrue("m=c is judged by the contact parser only", a.peers().isEmpty())
    }

    // -- the contact room ---------------------------------------------------------------------------

    private class RoomSocket(val alias: ByteArray, val room: ContactFakeRoom) : RelaySocket {
        val incoming = Channel<RelayFrame>(Channel.UNLIMITED)

        override suspend fun send(data: ByteArray) = room.fromClient(this, data)

        override suspend fun receive(): RelayFrame = incoming.receiveCatching().getOrNull() ?: throw SocketClosed(1000)

        override suspend fun close(code: Int) {
            incoming.close()
            room.drop(this)
        }
    }

    /** A contact room as the Worker's DO runs it: it knows only aliases. */
    private class ContactFakeRoom {
        private val socks = CopyOnWriteArrayList<RoomSocket>()
        val seen = CopyOnWriteArrayList<String>()

        fun opener(alias: ByteArray): RelayOpener = { _, _ -> RoomSocket(alias, this).also { socks += it } }

        fun drop(s: RoomSocket) {
            socks -= s
            for (r in socks) r.incoming.trySend(RelayFrame.Binary(encodeRelay(RelayMessage.Gone(s.alias))))
        }

        fun fromClient(s: RoomSocket, data: ByteArray) {
            when (val m = decodeRelay(RelayDirection.toRoom, data) ?: return) {
                RelayMessage.List -> s.incoming.trySend(RelayFrame.Binary(encodeRelay(RelayMessage.Members(socks.map { it.alias }))))

                is RelayMessage.Send -> {
                    seen += "send"
                    socks.firstOrNull { it.alias.contentEquals(m.to) }
                        ?.incoming?.trySend(RelayFrame.Binary(encodeRelay(RelayMessage.Recv(s.alias, m.session, m.noise))))
                }

                is RelayMessage.Ping -> s.incoming.trySend(RelayFrame.Binary(encodeRelay(RelayMessage.Pong(m.data))))

                else -> Unit
            }
        }
    }

    private val grant = RelayGrant("pkeyt_unused", "wss://key.plrs.im/djdl/connect/relay", RELAY_PROTOCOL, 1_700_000_060L)

    private fun relayOf(
        w: World,
        d: Device,
        c: Contacts,
        room: ContactFakeRoom,
        alias: ByteArray,
        tickets: java.util.concurrent.atomic.AtomicInteger,
    ): ContactRelay {
        val src = ContactRelaySource(lanSource(w, d, c)) {
            tickets.incrementAndGet()
            grant
        }
        return ContactRelay(src, RelayOptions(opener = room.opener(alias)))
    }

    @Test
    fun twoAccountsMeetInAContactRoomBySpeakingAliasesOnly() = runBlocking {
        val link = Link()
        val w = World()
        val rid = contactRid(link.secret)
        val aliasA = contactAlias(rid, idA)
        val aliasB = contactAlias(rid, idB)
        assertFalse(aliasA.contentEquals(aliasB))
        val room = ContactFakeRoom()
        val ta = java.util.concurrent.atomic.AtomicInteger()
        val ra = relayOf(w, link.a, Contacts(listOf(link.forA())), room, aliasA, ta)
        val rb = relayOf(w, link.b, Contacts(listOf(link.forB())), room, aliasB, java.util.concurrent.atomic.AtomicInteger())
        val inbound = CopyOnWriteArrayList<ConnectSession>()
        rb.onSession { inbound += it }
        rb.start()
        ra.start()
        val s = ra.dial(link.forA().id)
        assertEquals("relay", s.path)
        assertEquals(link.forA().id, s.contact?.id)
        until { inbound.isNotEmpty() }
        val r = inbound[0]
        assertEquals(link.forB().id, r.contact?.id)
        assertEquals("relay", r.path)
        s.send("over the room".toByteArray())
        assertEquals("over the room", String(r.receive(5000).body))
        assertTrue("a ticket was asked for", ta.get() >= 1)
        assertTrue(room.seen.isNotEmpty())
        s.close()
        ra.stop()
        rb.stop()
    }

    @Test
    fun aDialToAPeerThatIsNotInTheRoomIsUnknownPeer() = runBlocking {
        val link = Link()
        val w = World()
        val rid = contactRid(link.secret)
        val ra =
            relayOf(w, link.a, Contacts(listOf(link.forA())), ContactFakeRoom(), contactAlias(rid, idA), java.util.concurrent.atomic.AtomicInteger())
        ra.start()
        try {
            ra.dial(link.forA().id)
            fail("dialled an offline contact")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.unknown_peer, e.reason)
        }
        ra.stop()
    }

    @Test
    fun aLinksDisabledTicketStopsTheRoomWithATypedError() = runBlocking {
        val link = Link()
        val w = World()
        val src = ContactRelaySource(lanSource(w, link.a, Contacts(listOf(link.forA())))) {
            throw RelayException(RelayErrorReason.links_disabled, "off", httpStatus = 403)
        }
        val r = ContactRelay(src, RelayOptions())
        r.start()
        until { r.status().values.firstOrNull()?.state == RelayState.blocked }
        val st = r.status().values.first()
        assertEquals(RelayErrorReason.links_disabled, st.error?.reason)
        assertEquals(ErrorCode.connectLinksDisabled, st.error?.code)
        r.stop()
    }

    // -- the client: rows, the gate, the ticket -------------------------------------------------------

    private val deviceId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private val now = 1_700_000_000L
    private var interAccount = false
    private var ticketBody: String? = null
    private var ticketStatus = 200
    private var lastTicketBody: String? = null
    private var lastTicketContentType: String? = null

    private fun okTicket(room: Boolean) = """{"ticket":"pkeyrt_${"A".repeat(
        32,
    )}","url":"wss://key.plrs.im/djdl/connect/relay","protocol":"$RELAY_PROTOCOL","expiresAt":${now + 60}${if (room) ",\"room\":\"c\"" else ""}}"""

    private fun handle(r: PolarisRequest, port: DeviceKeyPort): PolarisResponse = when {
        r.path.endsWith("/.well-known/polaris.json") -> respond(
            200,
            """{"product":"djdl","services":{"connect":{"enabled":true,"interAccount":$interAccount,"endpoints":{"identity":"x","ticket":"t"}}}}""",
        )

        r.path.endsWith("/devices/keys") -> respond(200, """{"keySeq":1}""")

        r.path.endsWith("/connect/relay/ticket") -> {
            lastTicketBody = r.body?.toString(Charsets.UTF_8)
            lastTicketContentType = r.headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value
            respond(ticketStatus, ticketBody ?: "")
        }

        r.path.endsWith("/connect/identity") -> runBlocking {
            val mine = port.ensure()
            val ring = signer.sign(
                "pkey-ring+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"),
                        "aud" to JsonPrimitive("djdl"),
                        "sub" to JsonPrimitive(sub),
                        "epoch" to jsonInt(5),
                        "issuedAt" to jsonInt(now),
                        "expiresAt" to jsonInt(now + 604_800),
                        "devices" to JsonArray(
                            listOf(
                                JsonObject(
                                    mapOf(
                                        "deviceId" to JsonPrimitive(deviceId),
                                        "signKey" to JsonPrimitive(mine.signKey),
                                        "agreeKey" to JsonPrimitive(mine.agreeKey),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            )
            val cert = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                        "deviceId" to JsonPrimitive(deviceId), "signKey" to JsonPrimitive(mine.signKey), "agreeKey" to JsonPrimitive(mine.agreeKey),
                        "ringEpoch" to jsonInt(5), "issuedAt" to jsonInt(now), "expiresAt" to jsonInt(now + 604_800),
                    ),
                ),
            )
            respond(
                200,
                JsonObject(
                    mapOf(
                        "ring" to JsonPrimitive(ring),
                        "certificate" to JsonPrimitive(cert),
                        "discKeys" to JsonArray(listOf(JsonPrimitive(Base64Url.encode(rnd())))),
                    ),
                ).toString(),
            )
        }

        else -> respond(404, "")
    }

    private fun client(state: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()): PolarisKeyClient = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val store = InMemoryStore("djdl", deviceId)
        store.setToken("pkeyt_held")
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", baseUrl = "https://key.plrs.im", pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, transport = ScriptedTransport { handle(it, port) }, clock = { now }, deviceName = "Test Device",
                ),
                license = LicenseClientOptions(fingerprint = false),
                connect = ConnectOptions(deviceKeys = port, allowEphemeralKeys = true, state = state),
            ),
        )
    }

    @Test
    fun rowsAreStoredListedMarkedPromotedRemovedAndSurviveARefresh() = runBlocking {
        val c = client()
        c.connect.identity(refresh = true)
        val peerKey = Base64Url.encode(rnd())
        c.connect.updateContacts { rows, t -> storeRow(rows, peerKey, rnd(), "Ben", listOf("docs"), t)?.rows }
        val id = contactId(peerKey)
        val list = c.cloudConnect.links.list()
        assertEquals(listOf(id), list.map { it.id })
        assertEquals("Ben", list[0].label)
        assertEquals(listOf("docs"), list[0].categories)
        assertTrue(list[0].reachable)
        assertEquals(16, id.length)
        assertFalse("no key in anything printable", list.toString().contains(peerKey))
        assertTrue(c.cloudConnect.links.setReachable(id, false))
        assertFalse(c.cloudConnect.links.list()[0].reachable)
        assertFalse(c.cloudConnect.links.setReachable("nope", true))
        // A refresh of the identity keeps the links.
        c.connect.identity(refresh = true)
        assertEquals(listOf(id), c.cloudConnect.links.list().map { it.id })
        // A re-pair of the same peer is pending and takes no slot.
        c.connect.updateContacts { rows, t -> storeRow(rows, peerKey, rnd(), "Ben2", emptyList(), t)?.rows }
        val rp = c.cloudConnect.links.list()
        assertEquals(1, rp.size)
        assertTrue(rp[0].rePairPending)
        assertEquals("the held contact is untouched until the first handshake", "Ben", rp[0].label)
        c.connect.updateContacts { rows, _ -> promoteRow(rows, peerKey) }
        val promoted = c.cloudConnect.links.list()
        assertEquals("Ben2", promoted[0].label)
        assertFalse(promoted[0].rePairPending)
        assertTrue(c.cloudConnect.links.remove(id))
        assertTrue(c.cloudConnect.links.list().isEmpty())
        assertFalse(c.cloudConnect.links.remove(id))
    }

    @Test
    fun leavingWipesTheLinks() = runBlocking {
        val state = InMemoryDeviceKeyStorage()
        val c = client(state)
        c.connect.identity(refresh = true)
        c.connect.updateContacts { rows, t -> storeRow(rows, Base64Url.encode(rnd()), rnd(), null, emptyList(), t)?.rows }
        c.connect.leave()
        assertTrue(c.connect.contactRows().isEmpty())
        assertNull(state.get())
    }

    @Test
    fun aBadRowMakesTheRecordUnusableNotSilentlyReset() = runBlocking {
        val state = InMemoryDeviceKeyStorage()
        val c = client(state)
        c.connect.identity(refresh = true)
        c.connect.updateContacts { rows, t -> storeRow(rows, Base64Url.encode(rnd()), rnd(), null, emptyList(), t)?.rows }
        // Break the stored row's key.
        val raw = state.get()!!.toString(Charsets.UTF_8)
        val broken = raw.replace(Regex("\"agreeKey\":\"[A-Za-z0-9_-]{43}\"(?=,\"secret\")"), "\"agreeKey\":\"short\"")
        assertTrue("the fixture changed the row", broken != raw)
        state.put(broken.toByteArray())
        try {
            c.connect.contactRows()
            fail("an unreadable record must not read as no links")
        } catch (e: im.plrs.key.core.PolarisException) {
            assertEquals(ErrorCode.storeFailed, e.code)
        }
    }

    @Test
    fun pairAndOpenAreTheTypedNAWhileLinksAreOff() = runBlocking {
        interAccount = false
        val c = client()
        c.discover()
        assertFalse(c.cloudConnect.links.interAccount())
        try {
            c.cloudConnect.links.pair(LinkPairOptions(emptyList(), { }))
            fail("pair ran while links are off")
        } catch (e: LinksDisabledException) {
            assertEquals(ErrorCode.connectLinksDisabled, e.code)
            assertEquals(im.plrs.key.core.Feature.connectLinks, e.unsupported?.feature)
        }
        try {
            c.cloudConnect.links.open("x")
            fail("open ran while links are off")
        } catch (e: LinksDisabledException) {
            assertNotNull(e)
        }
        interAccount = true
        c.discover()
        assertTrue(c.cloudConnect.links.interAccount())
    }

    @Test
    fun theContactTicketBodyAndTheRoomEcho() = runBlocking {
        val c = client()
        val rid = "lXg0MgIHVN5qAmGFUen7vA"
        ticketBody = okTicket(room = true)
        c.connect.relayTicket("c", rid)
        assertEquals("application/json", lastTicketContentType)
        assertEquals("""{"room":"c","rid":"$rid"}""", lastTicketBody)
        // An older Worker ignores the body and answers an account ticket: unsupported, never used.
        ticketBody = okTicket(room = false)
        try {
            c.connect.relayTicket("c", rid)
            fail("an account ticket must not open a contact room")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.contact_unsupported, e.reason)
        }
        // An account request that answers a room is not in the contract shape.
        ticketBody = okTicket(room = true)
        try {
            c.connect.relayTicket()
            fail("a room echo on an account request is not the contract shape")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.ticket_invalid, e.reason)
        }
        ticketStatus = 403
        ticketBody = """{"error":{"code":"connect_links_disabled"}}"""
        try {
            c.connect.relayTicket("c", rid)
            fail("a gated ticket must be refused")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.links_disabled, e.reason)
            assertEquals(403, e.httpStatus)
        }
    }
}
