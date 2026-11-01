// @pkey-feature connect.links
//
// The `contact` section of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 sections 15.4, 15.7 and
// 15.10), read in place and driven through :core's contact module: the secret, the CONTACT body, a link's
// categories, the exchange order, the contact list, the pin, the advert (name, TXT, browse), the room id and
// alias, the ticket body and the shared listener's trial order (real message 1s through a `PeerChannel`).
// It mirrors conformance/runners/node/peerMatrixSuites.ts (`contact`). The Gradle `test` task runs it on the
// JCA backend and `testTink` on Tink.

package im.plrs.key.conformance

import im.plrs.key.core.Base64Url
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.CONTACT_BODY_MAX
import im.plrs.key.core.peer.CONTACT_EXCHANGE_SECONDS
import im.plrs.key.core.peer.CONTACT_LEASE_BYTES
import im.plrs.key.core.peer.CONTACT_ROOM_IDLE_SECONDS
import im.plrs.key.core.peer.CONTACT_TICKET_BODY_MAX
import im.plrs.key.core.peer.ContactAdvertKey
import im.plrs.key.core.peer.ContactBody
import im.plrs.key.core.peer.ContactExchange
import im.plrs.key.core.peer.ContactLink
import im.plrs.key.core.peer.ContactTxtResult
import im.plrs.key.core.peer.ContactVerdict
import im.plrs.key.core.peer.ExchangeEvent
import im.plrs.key.core.peer.HandshakeLimiter
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.MAX_CONTACTS
import im.plrs.key.core.peer.MAX_CONTACT_CATS
import im.plrs.key.core.peer.MAX_CONTACT_SECRETS
import im.plrs.key.core.peer.MAX_LIVE_CONTACT_ADVERTS
import im.plrs.key.core.peer.MAX_PENDING_CONTACTS
import im.plrs.key.core.peer.NoiseHandshake
import im.plrs.key.core.peer.NoiseHandshakeOptions
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PENDING_CONTACT_SECONDS
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.StoreVerdict
import im.plrs.key.core.peer.StoredContact
import im.plrs.key.core.peer.browseContactInstance
import im.plrs.key.core.peer.contactAlias
import im.plrs.key.core.peer.contactCategories
import im.plrs.key.core.peer.contactInstance
import im.plrs.key.core.peer.contactPin
import im.plrs.key.core.peer.contactRid
import im.plrs.key.core.peer.contactSecret
import im.plrs.key.core.peer.contactTrialOrder
import im.plrs.key.core.peer.dropStalePending
import im.plrs.key.core.peer.parseContact
import im.plrs.key.core.peer.parseContactTicketBody
import im.plrs.key.core.peer.parseContactTxt
import im.plrs.key.core.peer.payload1
import im.plrs.key.core.peer.peerNoiseProtocol
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.peerPsk
import im.plrs.key.core.peer.promoteContact
import im.plrs.key.core.peer.storeContact
import im.plrs.key.core.stringValue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.SecureRandom

class PeerMatrixContactTest : ConformanceSuite() {
    private val c: JsonObject = Corpus.v2("peer-matrix.json")["contact"]!!.obj
    private val rng = SecureRandom()

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.o(name: String): JsonObject = this[name]!!.obj

    private fun JsonObject.strings(name: String): List<String> = this[name]!!.arrayValue!!.map { it.stringValue!! }

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    /** A body row's bytes: hex, a text, or a prefix, a filler and a suffix. */
    private fun rowBytes(r: JsonObject): ByteArray {
        r["bodyHex"]?.let { return unhex(it.stringValue!!) }
        r["bodyPad"]?.let {
            val p = it.obj
            return (p.s("prefix") + p.s("fill").repeat(p["count"].longValue!!.toInt()) + p.s("suffix")).toByteArray()
        }
        return r.s("body").toByteArray()
    }

    @Test
    fun constants() {
        val k = c.o("constants")
        assertEquals(MAX_CONTACTS.toLong(), k["maxContacts"].longValue)
        assertEquals(MAX_CONTACT_CATS.toLong(), k["maxCats"].longValue)
        assertEquals(MAX_PENDING_CONTACTS.toLong(), k["maxPending"].longValue)
        assertEquals(MAX_CONTACT_SECRETS.toLong(), k["maxSecrets"].longValue)
        assertEquals(PENDING_CONTACT_SECONDS, k["pendingSeconds"].longValue)
        assertEquals(CONTACT_BODY_MAX.toLong(), k["bodyMax"].longValue)
        assertEquals(CONTACT_TICKET_BODY_MAX.toLong(), k["ticketBodyMax"].longValue)
        assertEquals(MAX_LIVE_CONTACT_ADVERTS.toLong(), k["maxLiveAdverts"].longValue)
        assertEquals(CONTACT_LEASE_BYTES.toLong(), k["leaseBytes"].longValue)
        assertEquals(CONTACT_ROOM_IDLE_SECONDS, k["roomIdleSeconds"].longValue)
        assertEquals(CONTACT_EXCHANGE_SECONDS.toLong(), k["exchangeSeconds"].longValue)
    }

    @Test
    fun secrets() {
        val f = Failures("peer-matrix contact secrets")
        for (r in rows(c["secrets"])) {
            val got = contactSecret(
                unhex(r.s("h")),
                unhex(r.s("nD")),
                unhex(r.s("nM")),
                Base64Url.decodeStrict(r.s("agreeKeyA"))!!,
                Base64Url.decodeStrict(r.s("agreeKeyB"))!!,
            )
            f.equal(r.s("secret"), hex(got)) { "secret ${r.s("id")}" }
        }
        f.done(5)
    }

    @Test
    fun bodiesAndCategories() {
        val f = Failures("peer-matrix contact bodies")
        for (r in rows(c["bodies"])) {
            val b = rowBytes(r)
            val id = r.s("id")
            f.equal(r["length"].longValue, b.size.toLong()) { "$id length" }
            val want = r.o("want")
            val got = parseContact(b, r["own"]?.stringValue)
            if (want["ok"].boolValue == true) {
                val ok = got as? ContactVerdict.Ok
                f.check(ok != null) { "$id: refused" }
                if (ok != null) bodyMatches(f, id, want, ok.body)
            } else {
                f.check(got is ContactVerdict.No) { "$id: expected a refusal" }
            }
        }
        for (r in rows(c["categories"])) {
            f.equal(r.strings("want"), contactCategories(r.strings("local"), r.strings("remote"))) { "categories ${r.s("id")}" }
        }
        f.done(20)
    }

    private fun bodyMatches(f: Failures, id: String, want: JsonObject, got: ContactBody) {
        f.equal(want.s("agreeKey"), got.agreeKey) { "$id agreeKey" }
        f.equal(want["label"]?.stringValue, got.label) { "$id label" }
        f.equal(want.strings("cats"), got.cats) { "$id cats" }
    }

    @Test
    fun exchange() {
        val f = Failures("peer-matrix contact exchange")
        for (r in rows(c["exchange"])) {
            val x = ContactExchange(r.s("own"), r.strings("held"))
            val steps = rows(r["steps"])
            val want = rows(r["want"])
            f.equal(steps.size, want.size) { "${r.s("id")} shape" }
            steps.forEachIndexed { i, s ->
                val e = when (s.s("event")) {
                    "own-confirm" -> ExchangeEvent.OwnConfirm
                    "peer-confirm" -> ExchangeEvent.PeerConfirm
                    "timeout" -> ExchangeEvent.Timeout
                    else -> ExchangeEvent.PeerContact(s.s("body").toByteArray())
                }
                val got = x.step(e)
                val w = want[i]
                val tag = "${r.s("id")} step $i"
                f.equal(w.strings("sends"), got.sends) { "$tag sends" }
                f.equal(w["close"]?.stringValue, got.close?.name) { "$tag close" }
                val st = w["stored"]?.obj
                if (st != null) {
                    f.check(got.stored != null) { "$tag stored" }
                    got.stored?.let { bodyMatches(f, tag, st, it) }
                    f.equal(st["pending"].boolValue, got.pending) { "$tag pending" }
                } else {
                    f.check(got.stored == null) { "$tag stored nothing" }
                }
            }
        }
        f.done(20)
    }

    @Test
    fun store() {
        fun fill(n: Int) = ByteArray(32) { n.toByte() }

        fun key(n: Int) = Base64Url.encode(fill(n))
        val f = Failures("peer-matrix contact store")
        for (r in rows(c["store"])) {
            var list = r["start"]!!.arrayValue!!.map { p ->
                val a = p.arrayValue!!
                StoredContact(key(a[0].longValue!!.toInt()), fill(a[1].longValue!!.toInt()))
            }
            val ops = rows(r["ops"])
            val want = rows(r["want"])
            ops.forEachIndexed { i, o ->
                var result: String? = null
                when (o.s("op")) {
                    "pair" -> {
                        val inc = StoredContact(key(o["key"].longValue!!.toInt()), fill(o["secret"].longValue!!.toInt()), o["label"]?.stringValue)
                        when (val v = storeContact(list, inc, o["now"].longValue!!)) {
                            is StoreVerdict.Stored -> {
                                list = v.contacts
                                result = if (v.pending) "pending" else "active"
                            }

                            StoreVerdict.Full -> result = "full"
                        }
                    }

                    "promote" -> list = promoteContact(list, key(o["key"].longValue!!.toInt()))

                    else -> list = dropStalePending(list, o["now"].longValue!!)
                }
                fun ids(l: List<StoredContact>) = l.map { (it.secret[0].toInt() and 0xff).toLong() }
                val w = want[i]
                val tag = "${r.s("id")} op $i"
                f.equal(w["result"]?.stringValue, result) { "$tag result" }
                f.equal(w["active"]!!.arrayValue!!.map { it.longValue }, ids(list.filter { it.pendingSince == null })) { "$tag active" }
                f.equal(w["pending"]!!.arrayValue!!.map { it.longValue }, ids(list.filter { it.pendingSince != null })) { "$tag pending" }
                f.equal(w["order"]!!.arrayValue!!.map { it.longValue }, ids(contactTrialOrder(list))) { "$tag order" }
            }
        }
        f.done(20)
    }

    @Test
    fun pin() {
        val f = Failures("peer-matrix contact pin")
        for (r in rows(c["pin"])) {
            val ok = contactPin(r.strings("held")[r["matched"].longValue!!.toInt()], Base64Url.decodeStrict(r.s("remoteStatic"))!!)
            f.equal(r.o("want")["ok"].boolValue, ok) { "pin ${r.s("id")}" }
        }
        f.done(5)
    }

    @Test
    fun advertsRoomsAndTickets() {
        val f = Failures("peer-matrix contact adverts")
        val a = c.o("adverts")
        f.equal(900L, a["epochSeconds"].longValue) { "epochSeconds" }
        for (r in rows(a["names"])) {
            f.equal(r.s("instance"), contactInstance(unhex(r.s("secret")), Base64Url.decodeStrict(r.s("agreeKey"))!!, r["epoch"].longValue!!)) {
                "name ${r.s("id")}"
            }
        }
        for (r in rows(a["txt"])) {
            val want = r.o("want")
            val got = parseContactTxt(r.strings("entries"))
            if (want["ok"].boolValue == true) {
                f.check(got is ContactTxtResult.Ok) { "txt ${r.s("id")}" }
            } else {
                f.equal(want.s("reason"), (got as? ContactTxtResult.Refused)?.reason) { "txt ${r.s("id")}" }
            }
        }
        for (r in rows(a["browse"])) {
            val keys = rows(r["contacts"]).map { ContactAdvertKey(unhex(it.s("secret")), Base64Url.decodeStrict(it.s("agreeKey"))!!) }
            val hit = browseContactInstance(r.s("instance"), keys, r["now"].longValue!!)
            val want = r["want"] as? JsonObject
            f.equal(want?.get("contact")?.longValue, hit?.contact?.toLong()) { "browse ${r.s("id")} contact" }
            f.equal(want?.get("epochBack")?.longValue, hit?.epochBack?.toLong()) { "browse ${r.s("id")} epochBack" }
        }
        val rooms = c.o("rooms")
        for (r in rows(rooms["rid"])) f.equal(r.s("rid"), contactRid(unhex(r.s("secret")))) { "rid ${r.s("id")}" }
        for (r in rows(rooms["alias"])) f.equal(r.s("alias"), hex(contactAlias(r.s("rid"), r.s("deviceId")))) { "alias ${r.s("id")}" }
        for (r in rows(c["tickets"])) {
            val b = rowBytes(r)
            f.equal(r["length"].longValue, b.size.toLong()) { "ticket ${r.s("id")} length" }
            val want = r.o("want")
            f.equal(if (want["ok"].boolValue == true) want.s("rid") else null, parseContactTicketBody(b)) { "ticket ${r.s("id")}" }
        }
        f.done(40)
    }

    /**
     * Real message 1s: the responder is a `PeerChannel` with the row's keys. The account keys are tried first,
     * then the contact secrets in order; what matters is which key opens, what is answered, what closes and
     * whether the contact trial holds its limiter slot. (The count of AEAD opens is not asserted: the port is
     * the engine's own.)
     */
    @Test
    fun listener() = runBlocking {
        val slug = "djdl"
        val f = Failures("peer-matrix contact listener")
        for (r in rows(c["listener"])) {
            val id = r.s("id")
            val account = r["account"]?.arrayValue
            val keys = account?.map { rnd() }.orEmpty()
            val secrets = r.strings("contacts").map { rnd() }
            var mode = PeerMode.c
            var psk: ByteArray = rnd()
            val opens = r["opens"] as? JsonObject
            if (opens != null) {
                if (opens.s("mode") == "a") {
                    mode = PeerMode.a
                    psk = peerPsk(keys[opens["key"].longValue!!.toInt()], slug)
                } else {
                    psk = secrets[opens["contact"].longValue!!.toInt()]
                }
            }
            val limiter = HandshakeLimiter(if (r.s("limiter") == "refuse") 0 else 99, 1)
            val out = ArrayList<ByteArray>()
            val events = ArrayList<SessionEvent>()
            val acct = account?.let { a ->
                im.plrs.key.core.peer.AccountContext(
                    emptyMap(),
                    slug,
                    "",
                    "ps_x",
                    "x".repeat(32),
                    { null },
                    a.mapIndexed { i, k -> if (k.stringValue == null) null else keys[i] },
                )
            }
            val ch = PeerChannel(
                NoiseRole.responder, slug, RawNoiseStatic(rnd()), acct, HelloInfo("t", "a"),
                { out.add(it) }, { events.add(it) },
                mode = if (acct != null) PeerMode.a else PeerMode.c, admission = limiter,
                contacts = secrets.map { ContactLink(it, Base64Url.encode(rnd())) },
            )
            val init =
                NoiseHandshake(
                    NoiseHandshakeOptions(NoiseRole.initiator, peerNoiseProtocol(mode), peerPrologue(slug, mode), psk, RawNoiseStatic(rnd())),
                )
            ch.receive(init.writeMessage(payload1()))
            val want = r.o("want")
            val closed = events.filterIsInstance<SessionEvent.Closed>().firstOrNull()?.code
            f.equal(want["close"]?.stringValue, closed) { "$id close" }
            f.equal(if (want["hit"]?.stringValue == null) 0 else 1, out.size) { "$id answered" }
            if (r.s("limiter") == "admit") f.equal(want["slot"].boolValue, limiter.begin() == null) { "$id slot" }
        }
        f.done(10)
    }
}
