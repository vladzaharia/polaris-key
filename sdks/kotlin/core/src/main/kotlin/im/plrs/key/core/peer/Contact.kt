// WIRE-CONTRACT-V5 section 15.10: inter-account links (CC-19.8). Pure functions and value types, no I/O: the
// contact secret, the `CONTACT` body, a link's categories, the order of the pairing exchange, the contact
// list rules, the contact advert (name, TXT, browse) and the contact room (room id, alias, ticket body).
// The vectors are `peer-matrix.json` `contact`. Mirrors client-core's `peer/contact.ts`.
//
// The secret and the keys are key material: nothing here logs one, returns one inside an error or prints
// one (`StoredContact` and `ContactAdvertKey` print as redacted). A secret is a `ByteArray`, so the copies
// this code owns can be zeroed (`wipe`); a JCA `Mac` copies its key, and that copy is the provider's.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.X25519Points
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.normalizeDeviceLabel
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireInteger
import java.text.Normalizer

/** Contacts one device holds for one product. */
public const val MAX_CONTACTS: Int = 64
public const val MAX_CONTACT_CATS: Int = 8

/** Pairings with a peer the host already holds wait as pending contacts; the oldest is dropped for a newer one. */
public const val MAX_PENDING_CONTACTS: Int = 8

/** A pending contact that no handshake has promoted is dropped this long after it was stored. */
public const val PENDING_CONTACT_SECONDS: Long = 86_400

/** The secrets a responder tries and a browser tests: the held contacts and the pending ones. */
public const val MAX_CONTACT_SECRETS: Int = MAX_CONTACTS + MAX_PENDING_CONTACTS

/** Contact adverts a host keeps live at once. */
public const val MAX_LIVE_CONTACT_ADVERTS: Int = 8
public const val CONTACT_BODY_MAX: Int = 4096
public const val CONTACT_TICKET_BODY_MAX: Int = 256

/** The relay leases bytes to a contact room in steps of this many (section 15.7). */
public const val CONTACT_LEASE_BYTES: Int = 1_048_576

/** A contact room with no socket for this long erases itself (section 15.7). */
public const val CONTACT_ROOM_IDLE_SECONDS: Long = 2_592_000

/** From this side's `CONFIRM` to the peer's `CONTACT`. */
public const val CONTACT_EXCHANGE_SECONDS: Int = 30

private const val KEY_BYTES = 32
private const val KEY_CHARS = 43
private const val RID_BYTES = 16
private const val RID_CHARS = 22
private const val ALIAS_BYTES = 24
private const val CAT_MAX = 32
private const val EPOCHS_BACK = 2
private const val BITS_PER_BYTE = 8
private const val BYTE_MASK = 0xff
private const val INSTANCE_CHARS = 16
private val CAT_RE = Regex("[a-z0-9-]{1,$CAT_MAX}")

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

private fun u64be(n: Long): ByteArray = ByteArray(BITS_PER_BYTE) { i -> (n ushr (BITS_PER_BYTE * (BITS_PER_BYTE - 1 - i))).toByte() }

/** 43 canonical base64url characters of 32 bytes, decoded; null otherwise. */
private fun key32(v: String?): ByteArray? {
    if (v == null || v.length != KEY_CHARS) return null
    return Base64Url.decodeStrict(v)?.takeIf { it.size == KEY_BYTES }
}

private fun usableKey(v: String?): Boolean = key32(v)?.let { !X25519Points.isLowOrder(it) } ?: false

private fun validCats(cats: List<String>): Boolean =
    cats.size <= MAX_CONTACT_CATS && cats.all { CAT_RE.matches(it) } && cats.toSet().size == cats.size

/** Unsigned byte order of two equal-length byte strings: negative when [a] sorts first. */
private fun byteCompare(a: ByteArray, b: ByteArray): Int {
    for (i in a.indices) {
        val d = (a[i].toInt() and BYTE_MASK) - (b[i].toInt() and BYTE_MASK)
        if (d != 0) return d
    }
    return 0
}

/** NFC, then the device-label cleaning (section 12.7.1): null when nothing is left. */
private fun cleanContactLabel(raw: String): String? = normalizeDeviceLabel(Normalizer.normalize(raw, Normalizer.Form.NFC))

/** Zero a secret this code or its caller owns. */
public fun wipe(secret: ByteArray) {
    secret.fill(0)
}

// -- The contact secret ---------------------------------------------------------------------------

/**
 * `HKDF-SHA256(salt = h, ikm = nD || nM, info = "pkey-peer/1 contact" 0x00 lo hi)`, 32 bytes: [h] is the
 * mode-p handshake hash, [nD] and [nM] the two SAS nonces and [agreeKeyA], [agreeKeyB] the two devices'
 * agreeKeys (32 raw bytes each) by unsigned byte order.
 */
public fun contactSecret(h: ByteArray, nD: ByteArray, nM: ByteArray, agreeKeyA: ByteArray, agreeKeyB: ByteArray): ByteArray {
    require(agreeKeyA.size == KEY_BYTES && agreeKeyB.size == KEY_BYTES) { "agreeKey" }
    val lo = if (byteCompare(agreeKeyA, agreeKeyB) <= 0) agreeKeyA else agreeKeyB
    val hi = if (lo === agreeKeyA) agreeKeyB else agreeKeyA
    return hkdfSha256(h, cat(nD, nM), cat(utf8("pkey-peer/1 contact"), byteArrayOf(0), lo, hi), KEY_BYTES)
}

// -- The CONTACT body -----------------------------------------------------------------------------

/** A `CONTACT` body, read. */
public class ContactBody(
    /** The sender's device agreeKey, 43 canonical base64url characters. */
    public val agreeKey: String,
    public val label: String?,
    /** The categories the sender's person approved. */
    public val cats: List<String>,
) {
    override fun toString(): String = "ContactBody(cats=${cats.size})"
}

/** The verdict on one `CONTACT` body. */
public sealed class ContactVerdict {
    public class Ok(public val body: ContactBody) : ContactVerdict()

    public object No : ContactVerdict()
}

/** The bytes of a `CONTACT` body. Throws [IllegalArgumentException] for a body the peer would refuse. */
public fun buildContact(agreeKey: String, label: String?, cats: List<String>): ByteArray {
    require(usableKey(agreeKey)) { "agreeKey" }
    require(validCats(cats)) { "cats" }
    val sb = StringBuilder("{\"v\":1,\"agreeKey\":\"").append(agreeKey).append('"')
    val clean = label?.let(::cleanContactLabel)
    if (clean != null) sb.append(",\"label\":").append(jsonQuoted(clean))
    sb.append(",\"cats\":[").append(cats.joinToString(",") { "\"$it\"" }).append("]}")
    val bytes = utf8(sb.toString())
    require(bytes.size <= CONTACT_BODY_MAX) { "size" }
    return bytes
}

private fun jsonQuoted(s: String): String = kotlinx.serialization.json.JsonPrimitive(s).toString()

/**
 * Judge one `CONTACT` body. [own] is the reader's own agreeKey: a body that carries it is no contact. The
 * label is cleaned as a `HELLO` label (section 15.6) and dropped when nothing is left.
 */
public fun parseContact(body: ByteArray, own: String? = null): ContactVerdict {
    if (body.size > CONTACT_BODY_MAX) return ContactVerdict.No
    val parsed = im.plrs.key.core.StrictJson.validate(body) ?: return ContactVerdict.No
    val o = parsed.value
    if (!wireInteger(o["v"].longValue, "/v", 1, parsed.nonWireIntegers) || o["v"].longValue != 1L) return ContactVerdict.No
    val key = o["agreeKey"].stringValue
    if (!usableKey(key) || key == own) return ContactVerdict.No
    val arr = o["cats"].arrayValue ?: return ContactVerdict.No
    val cats = arr.map { it.stringValue ?: return ContactVerdict.No }
    if (!validCats(cats)) return ContactVerdict.No
    var label: String? = null
    if ("label" in o) {
        val raw = o["label"].stringValue ?: return ContactVerdict.No
        label = cleanContactLabel(raw)
    }
    return ContactVerdict.Ok(ContactBody(key!!, label, cats))
}

/** A link's categories: the entries both sides list, once each, in byte order. */
public fun contactCategories(a: List<String>, b: List<String>): List<String> = a.filter { it in b }.toSet().sortedWith(::compareUtf8)

/** Unsigned byte order of the UTF-8 of two strings. */
private fun compareUtf8(x: String, y: String): Int {
    val a = utf8(x)
    val b = utf8(y)
    for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return (a[i].toInt() and BYTE_MASK) - (b[i].toInt() and BYTE_MASK)
    return a.size - b.size
}

// -- The pairing exchange -------------------------------------------------------------------------

/** One event of a pairing, in the order a side sees it. */
public sealed class ExchangeEvent {
    public object OwnConfirm : ExchangeEvent()

    public object PeerConfirm : ExchangeEvent()

    public class PeerContact(public val body: ByteArray) : ExchangeEvent()

    /** [CONTACT_EXCHANGE_SECONDS] after this side's `CONFIRM`. */
    public object Timeout : ExchangeEvent()
}

/** What one step makes a side do. */
public class ExchangeStep(
    /** The records this step makes the side send: `CONFIRM`, `CONTACT`. */
    public val sends: List<String> = emptyList(),
    public val close: PeerCloseCode? = null,
    /** The peer's `CONTACT`, valid, read in order: the host stores it. [pending] is true for a peer the host holds. */
    public val stored: ContactBody? = null,
    public val pending: Boolean = false,
)

/**
 * One side's order guard over the records of the exchange (section 15.10, "Order of checks"). A `CONTACT`
 * goes out once this side has sent its `CONFIRM` and read the peer's; the peer's arrives only after both.
 * After a close nothing happens. [own] is this device's agreeKey; [held] is the agreeKey of every active
 * contact the host holds: a peer in it is a re-pair, accepted at any count; a peer not in it is refused
 * (`peer_not_allowed`, nothing stored) when the host already holds [MAX_CONTACTS].
 */
public class ContactExchange(private val own: String? = null, private val held: List<String> = emptyList()) {
    private var ownConfirmed = false
    private var peerConfirmed = false
    private var contactSent = false
    private var peerContact = false
    private var dead = false

    /** This side's `CONFIRM` is out and the peer's `CONTACT` is still wanted. */
    public val waiting: Boolean get() = !dead && ownConfirmed && !peerContact

    private fun bad(): ExchangeStep {
        dead = true
        return ExchangeStep(close = PeerCloseCode.peer_bad_frame)
    }

    private fun maybeContact(): List<String> {
        if (ownConfirmed && peerConfirmed && !contactSent) {
            contactSent = true
            return listOf("CONTACT")
        }
        return emptyList()
    }

    public fun step(e: ExchangeEvent): ExchangeStep {
        if (dead) return ExchangeStep()
        return when (e) {
            ExchangeEvent.OwnConfirm -> {
                ownConfirmed = true
                ExchangeStep(sends = listOf("CONFIRM") + maybeContact())
            }

            ExchangeEvent.PeerConfirm -> {
                if (peerConfirmed) return bad()
                peerConfirmed = true
                ExchangeStep(sends = maybeContact())
            }

            is ExchangeEvent.PeerContact -> onContact(e.body)

            ExchangeEvent.Timeout -> if (ownConfirmed && !peerContact) {
                dead = true
                ExchangeStep(close = PeerCloseCode.peer_timeout)
            } else {
                ExchangeStep()
            }
        }
    }

    private fun onContact(body: ByteArray): ExchangeStep {
        if (!ownConfirmed || !peerConfirmed || peerContact) return bad()
        val v = parseContact(body, own) as? ContactVerdict.Ok ?: return bad()
        val pending = v.body.agreeKey in held
        if (!pending && held.size >= MAX_CONTACTS) {
            dead = true
            return ExchangeStep(close = PeerCloseCode.peer_not_allowed)
        }
        peerContact = true
        return ExchangeStep(stored = v.body, pending = pending)
    }
}

// -- The contact list -----------------------------------------------------------------------------

/** A contact the host holds. [pendingSince] (unix seconds) marks a pending one. Prints as redacted. */
public class StoredContact(
    public val agreeKey: String,
    public val secret: ByteArray,
    public val label: String? = null,
    public val cats: List<String> = emptyList(),
    public val pendingSince: Long? = null,
) {
    internal fun copy(pendingSince: Long?): StoredContact = StoredContact(agreeKey, secret, label, cats, pendingSince)

    override fun toString(): String = "StoredContact(redacted)"
}

/** What [storeContact] answers. */
public sealed class StoreVerdict {
    public class Stored(public val contacts: List<StoredContact>, public val pending: Boolean) : StoreVerdict()

    public object Full : StoreVerdict()
}

private fun activeOf(list: List<StoredContact>): List<StoredContact> = list.filter { it.pendingSince == null }

/**
 * Store a contact the exchange produced (section 15.10). A peer whose agreeKey the host does not hold is added
 * as an active contact, or refused ([StoreVerdict.Full]) at [MAX_CONTACTS]. A peer it does hold is stored
 * pending: the held contact stays as it is, one pending contact per key (a newer one replaces an older), at
 * most [MAX_PENDING_CONTACTS] (the oldest goes first). Pure: the list in, the list out.
 */
public fun storeContact(list: List<StoredContact>, incoming: StoredContact, nowSeconds: Long): StoreVerdict {
    val held = activeOf(list).any { it.agreeKey == incoming.agreeKey }
    if (!held) {
        if (activeOf(list).size >= MAX_CONTACTS) return StoreVerdict.Full
        return StoreVerdict.Stored(list + incoming.copy(pendingSince = null), false)
    }
    val next = list.filterNot { it.pendingSince != null && it.agreeKey == incoming.agreeKey }.toMutableList()
    next += incoming.copy(pendingSince = nowSeconds)
    while (next.count { it.pendingSince != null } > MAX_PENDING_CONTACTS) {
        // Oldest first; of equal age, the one stored earlier (lower in the list).
        val oldest = next.withIndex().filter { it.value.pendingSince != null }.minWithOrNull(compareBy({ it.value.pendingSince }, { it.index }))!!
        next.removeAt(oldest.index)
    }
    return StoreVerdict.Stored(next, true)
}

/** A handshake under a pending contact's secret passed the pin: it replaces the held contact of that key, in its place. */
public fun promoteContact(list: List<StoredContact>, agreeKey: String): List<StoredContact> {
    val p = list.firstOrNull { it.pendingSince != null && it.agreeKey == agreeKey } ?: return list
    val fresh = p.copy(pendingSince = null)
    val out = ArrayList<StoredContact>()
    for (c in list) {
        if (c === p) continue
        out += if (c.pendingSince == null && c.agreeKey == agreeKey) fresh else c
    }
    return out
}

/** Drop the pending contacts stored [PENDING_CONTACT_SECONDS] ago or earlier. */
public fun dropStalePending(list: List<StoredContact>, nowSeconds: Long): List<StoredContact> =
    list.filter { it.pendingSince == null || nowSeconds - it.pendingSince < PENDING_CONTACT_SECONDS }

/** The order a responder tries secrets and a browser tests contacts in: the active ones in held order, then the pending ones, at most [MAX_CONTACT_SECRETS]. */
public fun contactTrialOrder(list: List<StoredContact>): List<StoredContact> =
    (list.filter { it.pendingSince == null } + list.filter { it.pendingSince != null }).take(MAX_CONTACT_SECRETS)

// -- The pin --------------------------------------------------------------------------------------

/**
 * Mode c (section 15.10): the remote static key must be the agreeKey of the contact whose secret opened the
 * session. The initiator asks after message 2, the responder after message 3; false ends the session as
 * `peer_revoked` with nothing sent.
 */
public fun contactPin(held: String, remoteStatic: ByteArray): Boolean = Base64Url.encode(remoteStatic) == held

// -- The LAN advert -------------------------------------------------------------------------------

/** A contact the device holds, for the advert code: its secret and the peer's agreeKey (32 raw bytes). */
public class ContactAdvertKey(public val secret: ByteArray, public val agreeKey: ByteArray) {
    override fun toString(): String = "ContactAdvertKey(redacted)"
}

/**
 * The contact instance name for an advertiser in one epoch: `p1-` and the first 16 characters of the
 * lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 cdisc" 0x00 u64be(epoch) agreeKey)`, with the
 * advertiser's own agreeKey so the two devices of a link differ.
 */
public fun contactInstance(secret: ByteArray, advertiserAgreeKey: ByteArray, epoch: Long): String {
    val mac = hmacSha256(secret, cat(utf8("pkey-peer/1 cdisc"), byteArrayOf(0), u64be(epoch), advertiserAgreeKey))
    return "p1-" + base32Lower(mac).substring(0, INSTANCE_CHARS)
}

/** `v=1` and `m=c`; an entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated key refuses; `h` is not read. */
public fun parseContactTxt(entries: List<String>): ContactTxtResult {
    val kv = HashMap<String, String>()
    for (e in entries) {
        val at = e.indexOf('=')
        if (at < 1) continue
        val k = e.substring(0, at)
        if (kv.containsKey(k)) return ContactTxtResult.Refused("duplicate")
        kv[k] = e.substring(at + 1)
    }
    if (kv["v"] != "1") return ContactTxtResult.Refused("version")
    if (kv["m"] != "c") return ContactTxtResult.Refused("mode")
    return ContactTxtResult.Ok
}

/** The outcome of [parseContactTxt]. */
public sealed class ContactTxtResult {
    public object Ok : ContactTxtResult()

    public class Refused(public val reason: String) : ContactTxtResult()
}

/** Which contact an advert belongs to: [contact] indexes the list as given; [epochBack] is 0 (current) or 1 (previous). */
public data class ContactHit(val contact: Int, val epochBack: Int)

/**
 * Which contact an instance belongs to: the first of the first [MAX_CONTACT_SECRETS], in the order given
 * (`contactTrialOrder`), that matches in the current or the previous epoch. At most 144 HMACs.
 */
public fun browseContactInstance(instance: String, contacts: List<ContactAdvertKey>, nowSeconds: Long): ContactHit? {
    if (!isInstanceName(instance)) return null
    val epoch = advertEpoch(nowSeconds)
    for ((i, c) in contacts.take(MAX_CONTACT_SECRETS).withIndex()) {
        for (back in 0 until EPOCHS_BACK) {
            if (contactInstance(c.secret, c.agreeKey, epoch - back) == instance) return ContactHit(i, back)
        }
    }
    return null
}

// -- The contact room -----------------------------------------------------------------------------

/** The room id: base64url of `HKDF-SHA256(salt = empty, ikm = secret, info = "pkey-peer/1 room")[0..16]`, 22 characters. */
public fun contactRid(secret: ByteArray): String =
    Base64Url.encode(hkdfSha256(ByteArray(0), secret, utf8("pkey-peer/1 room"), KEY_BYTES).copyOf(RID_BYTES))

private fun ridBytes(rid: String): ByteArray? {
    if (rid.length != RID_CHARS) return null
    return Base64Url.decodeStrict(rid)?.takeIf { it.size == RID_BYTES }
}

/** The alias a room uses for a device: `SHA-256(rid || deviceId)[0..24]` over the 16 decoded rid bytes and the 24 decoded device-id bytes. */
public fun contactAlias(rid: String, deviceId: String): ByteArray {
    val r = requireNotNull(ridBytes(rid)) { "rid" }
    return sha256(r, deviceIdBytes(deviceId)).copyOf(ALIAS_BYTES)
}

/** The ticket-request body for a contact room. */
public fun contactTicketBody(rid: String): String {
    requireNotNull(ridBytes(rid)) { "rid" }
    return "{\"room\":\"c\",\"rid\":\"$rid\"}"
}

/** Read a ticket-request body: strict JSON of at most 256 bytes with exactly `room` = "c" and a canonical `rid`; the rid, or null. */
public fun parseContactTicketBody(bytes: ByteArray): String? {
    if (bytes.size > CONTACT_TICKET_BODY_MAX) return null
    val o = parseStrictObject(bytes) ?: return null
    if (o.size != 2 || o["room"].stringValue != "c") return null
    val rid = o["rid"].stringValue ?: return null
    return rid.takeIf { ridBytes(it) != null }
}
