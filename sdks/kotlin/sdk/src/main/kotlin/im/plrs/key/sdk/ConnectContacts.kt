// Inter-account links as the Kotlin SDK holds them (CC-19.8; WIRE-CONTRACT-V5 section 15.10): the contact rows
// of `pkey.connect.v1` and the pure steps that change them. The rules (the cap of 64, the pending contacts,
// the trial order, the 24 h lapse) are :core's `peer/Contact.kt`; this file carries the SDK's own columns
// (`createdAt`, `reachable`) across those calls. Mirrors sdk-node's `connect/contacts.ts`.
//
// Rules this file keeps:
// - a contact secret is key material: it is decoded for a call and zeroed after where this code owns the
//   array (`wipe`), it is in no [ContactInfo], no error and no `toString`, and [ContactInfo] carries no key;
// - an `id` is derived from the peer's agreeKey (a public key) and names a link on this device only:
//   SHA-256("pkey-contact/1" 0x00 agreeKey)[0..12] in base64url, 16 characters.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.peer.MAX_CONTACT_CATS
import im.plrs.key.core.peer.MAX_CONTACT_SECRETS
import im.plrs.key.core.peer.StoreVerdict
import im.plrs.key.core.peer.StoredContact
import im.plrs.key.core.peer.contactTrialOrder
import im.plrs.key.core.peer.dropStalePending
import im.plrs.key.core.peer.promoteContact
import im.plrs.key.core.peer.sha256
import im.plrs.key.core.peer.storeContact

private const val ID_BYTES = 12
private const val KEY_CHARS = 43
private val CAT_RE = Regex("[a-z0-9-]{1,32}")

/** What the host sees of one link. No key of any kind. */
public data class ContactInfo(
    /** Names the link on this device (16 characters). Not the peer's key and not shared. */
    val id: String,
    /** The label stored when the link was made: display data the other person chose. */
    val label: String?,
    /** The data categories both people approved, in byte order. */
    val categories: List<String>,
    /** Unix seconds. */
    val createdAt: Long,
    /** Advertised on the LAN and kept in a relay room (at most 8 at once). */
    val reachable: Boolean,
    /** A newer pairing with the same peer waits for its first handshake (section 15.10). */
    val rePairPending: Boolean,
)

/** The link a session was made over. */
public class ContactRef(
    public val id: String,
    public val label: String?,
    public val categories: List<String>,
    /** The peer's agreeKey, 43 base64url characters (a public key). */
    public val agreeKey: String,
    /** The session was opened under a pending contact: it is the first handshake of a re-pair. */
    public val pending: Boolean,
) {
    override fun toString(): String = "ContactRef($id)"
}

/** One contact as it rests in the record. `secret` and `agreeKey` are canonical base64url of 32 bytes. Never printed. */
internal class ContactRow(
    val agreeKey: String,
    val secret: String,
    val label: String?,
    val cats: List<String>,
    val createdAt: Long,
    val reachable: Boolean,
    val pendingSince: Long? = null,
) {
    override fun toString(): String = "ContactRow(redacted)"

    fun copy(reachable: Boolean = this.reachable): ContactRow = ContactRow(agreeKey, secret, label, cats, createdAt, reachable, pendingSince)

    /** A row that breaks a rule makes the whole record unusable (a hand-edited file is not trusted). */
    fun valid(): Boolean = isKey(agreeKey) && isKey(secret) && cats.size <= MAX_CONTACT_CATS && cats.toSet().size == cats.size &&
        cats.all { CAT_RE.matches(it) }

    private fun isKey(k: String): Boolean = k.length == KEY_CHARS && Base64Url.decodeStrict(k)?.size == KEY_BYTES_32

    private companion object {
        const val KEY_BYTES_32 = 32
    }
}

/** A contact in use: the row with its secret decoded. [wipe] zeroes the arrays this value owns. */
internal class LiveContact(
    val id: String,
    val agreeKey: String,
    val agreeKeyBytes: ByteArray,
    val secret: ByteArray,
    val label: String?,
    val cats: List<String>,
    val reachable: Boolean,
    val pending: Boolean,
) {
    val ref: ContactRef get() = ContactRef(id, label, cats, agreeKey, pending)

    fun wipe() {
        secret.fill(0)
    }

    override fun toString(): String = "LiveContact(redacted)"
}

internal fun contactId(agreeKey: String): String {
    val raw = Base64Url.decode(agreeKey) ?: ByteArray(0)
    return Base64Url.encode(sha256("pkey-contact/1".toByteArray(Charsets.UTF_8), byteArrayOf(0), raw).copyOf(ID_BYTES))
}

internal fun liveOf(r: ContactRow): LiveContact = LiveContact(
    id = contactId(r.agreeKey),
    agreeKey = r.agreeKey,
    agreeKeyBytes = Base64Url.decode(r.agreeKey) ?: ByteArray(0),
    secret = Base64Url.decode(r.secret) ?: ByteArray(0),
    label = r.label,
    cats = r.cats,
    reachable = r.reachable,
    pending = r.pendingSince != null,
)

private fun rowKey(agreeKey: String, pending: Boolean): String = "$agreeKey|${if (pending) "p" else "h"}"

private fun storedOf(r: ContactRow): StoredContact =
    StoredContact(r.agreeKey, Base64Url.decode(r.secret) ?: ByteArray(0), r.label, r.cats, r.pendingSince)

private fun wipeStored(list: List<StoredContact>) {
    for (c in list) c.secret.fill(0)
}

/** The contacts in `contactTrialOrder` (held first, then pending), decoded. The caller wipes them. */
internal fun trialOrderOf(rows: List<ContactRow>): List<LiveContact> {
    val stored = rows.map(::storedOf)
    val ordered = contactTrialOrder(stored)
    val byKey = rows.associateBy { rowKey(it.agreeKey, it.pendingSince != null) }
    val out = ordered.mapNotNull { s -> byKey[rowKey(s.agreeKey, s.pendingSince != null)]?.let(::liveOf) }
    wipeStored(stored)
    return out.take(MAX_CONTACT_SECRETS)
}

internal fun infoOf(rows: List<ContactRow>): List<ContactInfo> {
    val pending = rows.filter { it.pendingSince != null }.map { it.agreeKey }.toSet()
    return rows.filter { it.pendingSince == null }.map {
        ContactInfo(contactId(it.agreeKey), it.label, it.cats, it.createdAt, it.reachable, it.agreeKey in pending)
    }
}

/** The rows after storing a contact the pairing produced, and whether it waits as a re-pair; null at the cap. */
internal class RowsStored(val rows: List<ContactRow>, val pending: Boolean)

/** Store a contact the pairing produced (`storeContact`); the new one is reachable. [secret] is copied, not kept. */
internal fun storeRow(
    rows: List<ContactRow>,
    agreeKey: String,
    secret: ByteArray,
    label: String?,
    cats: List<String>,
    nowSeconds: Long,
): RowsStored? {
    val stored = rows.map(::storedOf)
    val mine = secret.copyOf()
    try {
        val v = storeContact(stored, StoredContact(agreeKey, mine, label, cats), nowSeconds) as? StoreVerdict.Stored ?: return null
        val keep = rows.associateBy { rowKey(it.agreeKey, it.pendingSince != null) }
        val out = v.contacts.map { c ->
            // The new contact is the one that carries the array we passed in.
            val was = if (c.secret === mine) null else keep[rowKey(c.agreeKey, c.pendingSince != null)]
            was ?: ContactRow(c.agreeKey, Base64Url.encode(c.secret), c.label, c.cats, nowSeconds, true, c.pendingSince)
        }
        return RowsStored(out, v.pending)
    } finally {
        wipeStored(stored)
        mine.fill(0)
    }
}

/** A handshake under the pending contact of [agreeKey] passed the pin: it takes the held one's place. */
internal fun promoteRow(rows: List<ContactRow>, agreeKey: String): List<ContactRow> {
    val pend = rows.firstOrNull { it.pendingSince != null && it.agreeKey == agreeKey } ?: return rows
    val held = rows.firstOrNull { it.pendingSince == null && it.agreeKey == agreeKey }
    val stored = rows.map(::storedOf)
    try {
        return promoteContact(stored, agreeKey).mapNotNull { c ->
            if (c.pendingSince == null && c.agreeKey == agreeKey) {
                // The new link: its secret, label and categories, made when the pairing was; the held one's local choice of reachability stays.
                ContactRow(agreeKey, pend.secret, pend.label, pend.cats, pend.createdAt, held?.reachable ?: pend.reachable)
            } else {
                rows.firstOrNull { rowKey(it.agreeKey, it.pendingSince != null) == rowKey(c.agreeKey, c.pendingSince != null) }
            }
        }
    } finally {
        wipeStored(stored)
    }
}

/** Drop the pending contacts that lapsed. */
internal fun dropStaleRows(rows: List<ContactRow>, nowSeconds: Long): List<ContactRow> {
    val stored = rows.map(::storedOf)
    val keep = dropStalePending(stored, nowSeconds).map { rowKey(it.agreeKey, it.pendingSince != null) }.toSet()
    wipeStored(stored)
    return rows.filter { rowKey(it.agreeKey, it.pendingSince != null) in keep }
}
