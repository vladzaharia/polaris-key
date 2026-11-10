// The local-link store, `pkey.connect.local.v1` (CC-29.13; WIRE-CONTRACT-V5 section 15.12, "What each side stores"): the
// links this device holds for one product, each with its own link private key and the link secret. It sits in its own
// file in the SDK's state directory, written through the same file storage as the Cloud Connect record (`0600`, replaced
// atomically, a cross-process lock), or in memory for a host whose keys are memory-only. It is not account data: a
// sign-out, a licence deactivation and an account deletion leave it alone. Mirrors sdk-node's `connect/localState.ts`.
//
// Rules this file keeps:
// - the record is parsed strictly; one that exists but is unusable is an error for the caller to surface, never silently
//   replaced (replacing it would forget the held links);
// - a private key and a secret are fields of the record and of nothing else here: [LocalLinkInfo] carries neither, and no
//   error or print names one;
// - a link is added under the store's lock, which also holds the cap ([MAX_LOCAL_LINKS]); the read, the cap and the write
//   are one step under the storage's own lock, so a second process on the directory cannot pass the cap;
// - a link in use ([LiveLocal]) carries its decoded key and secret: the user of one wipes it.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.StoreException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.peer.MAX_CONTACT_CATS
import im.plrs.key.core.peer.MAX_LIVE_LOCAL_ADVERTS
import im.plrs.key.core.peer.MAX_LOCAL_LINKS
import im.plrs.key.core.peer.sha256
import im.plrs.key.core.stringValue
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal const val LOCAL_STATE_SCHEMA = "pkey.connect.local.v1"

/** The record's file name in the state directory. */
public const val LOCAL_STATE_FILE: String = "pkey.connect.local.v1.json"

private const val ID_BYTES = 12
private const val KEY_BYTES = 32
private const val KEY_CHARS = 43
private val CAT_RE = Regex("[a-z0-9-]{1,32}")
private val ID_RE = Regex("[A-Za-z0-9_-]{16}")

/** What the host sees of one local link. No key, no secret. */
public data class LocalLinkInfo(
    /** Names the link on this device (16 characters). Not the peer's key and not shared. */
    val id: String,
    /** The peer's label, cleaned; a rename replaces it on this device only. */
    val label: String?,
    /** The data categories both people approved, in byte order. */
    val categories: List<String>,
    /** Unix seconds. */
    val createdAt: Long,
    /** Unix seconds, coarsened to the hour; null until a session has run under the link. */
    val lastSeen: Long?,
    /** Advertised on the LAN (at most 8 at once). A new link is reachable already while fewer than 8 are. */
    val reachable: Boolean,
)

/** The link a mode-`l` session was made over. No key, no secret. */
public class LocalRef(
    public val id: String,
    /** The stored label, or the one the person gave it with `rename`. */
    public val label: String?,
    public val categories: List<String>,
    /** The peer's link public key, 43 base64url characters. */
    public val peerKey: String,
    /** A one-way tag of the secret the session opened under (not the secret). */
    internal val tag: String,
) {
    override fun toString(): String = "LocalRef($id)"
}

/** One link as it rests in the record. Keys and the secret are canonical base64url of 32 bytes. Never printed. */
internal class LocalLinkRow(
    val id: String,
    /** This device's private key for the link: the static key of every session under it. */
    val ownKey: String,
    val ownPublic: String,
    val peerKey: String,
    val secret: String,
    val label: String?,
    val cats: List<String>,
    val createdAt: Long,
    val lastSeen: Long?,
    val reachable: Boolean,
) {
    override fun toString(): String = "LocalLinkRow(redacted)"

    fun copy(label: String? = this.label, lastSeen: Long? = this.lastSeen, reachable: Boolean = this.reachable): LocalLinkRow =
        LocalLinkRow(id, ownKey, ownPublic, peerKey, secret, label, cats, createdAt, lastSeen, reachable)

    fun valid(): Boolean = ID_RE.matches(id) && listOf(ownKey, ownPublic, peerKey, secret).all(::isKey) && catsOk(cats)
}

private fun isKey(k: String): Boolean = k.length == KEY_CHARS && Base64Url.decodeStrict(k)?.size == KEY_BYTES

private fun catsOk(c: List<String>): Boolean = c.size <= MAX_CONTACT_CATS && c.toSet().size == c.size && c.all { CAT_RE.matches(it) }

/**
 * The id of a link on this device: `SHA-256("pkey-local/1" 0x00 peerKey)[0..12]` in base64url, 16 characters. Derived
 * from the peer's link key, a public key, and meaningful here only.
 */
internal fun localLinkId(peerKey: ByteArray): String =
    Base64Url.encode(sha256("pkey-local/1".toByteArray(Charsets.UTF_8), byteArrayOf(0), peerKey).copyOf(ID_BYTES))

/** A one-way tag that tells two secrets apart without holding either. */
internal fun localTag(secret: ByteArray): String =
    Base64Url.encode(sha256("pkey-local-tag/1".toByteArray(Charsets.UTF_8), byteArrayOf(0), secret).copyOf(ID_BYTES))

/** A link in use: the row with its key and secret decoded. [wipeLocals] zeroes them. */
internal class LiveLocal(
    val id: String,
    val ownKey: ByteArray,
    val ownPublic: ByteArray,
    val peerKey: ByteArray,
    val secret: ByteArray,
    val label: String?,
    val cats: List<String>,
    val reachable: Boolean,
) {
    val tag: String = localTag(secret)

    val ref: LocalRef get() = LocalRef(id, label, cats, Base64Url.encode(peerKey), tag)

    override fun toString(): String = "LiveLocal(redacted)"
}

internal fun liveOfLocal(r: LocalLinkRow): LiveLocal = LiveLocal(
    id = r.id,
    ownKey = Base64Url.decode(r.ownKey) ?: ByteArray(0),
    ownPublic = Base64Url.decode(r.ownPublic) ?: ByteArray(0),
    peerKey = Base64Url.decode(r.peerKey) ?: ByteArray(0),
    secret = Base64Url.decode(r.secret) ?: ByteArray(0),
    label = r.label,
    cats = r.cats,
    reachable = r.reachable,
)

internal fun wipeLocals(list: List<LiveLocal>) {
    for (l in list) {
        l.secret.fill(0)
        l.ownKey.fill(0)
    }
}

internal fun infoOfLocal(rows: List<LocalLinkRow>): List<LocalLinkInfo> =
    rows.map { LocalLinkInfo(it.id, it.label, it.cats, it.createdAt, it.lastSeen, it.reachable) }

private fun rowJson(r: LocalLinkRow): JsonObject = JsonObject(
    buildMap {
        put("id", JsonPrimitive(r.id))
        put("ownKey", JsonPrimitive(r.ownKey))
        put("ownPublic", JsonPrimitive(r.ownPublic))
        put("peerKey", JsonPrimitive(r.peerKey))
        put("secret", JsonPrimitive(r.secret))
        r.label?.let { put("label", JsonPrimitive(it)) }
        put("cats", JsonArray(r.cats.map { JsonPrimitive(it) }))
        put("createdAt", jsonInt(r.createdAt))
        r.lastSeen?.let { put("lastSeen", jsonInt(it)) }
        put("reachable", JsonPrimitive(r.reachable))
    },
)

internal fun encodeLocalState(product: String, rows: List<LocalLinkRow>): ByteArray = JsonObject(
    mapOf(
        "schema" to JsonPrimitive(LOCAL_STATE_SCHEMA),
        "product" to JsonPrimitive(product),
        "links" to JsonArray(rows.map(::rowJson)),
    ),
).toString().toByteArray(Charsets.UTF_8)

/** The rows of a record, or null when it is unusable (not this schema, another product's, or any row breaks a rule). */
internal fun parseLocalState(raw: ByteArray, product: String): List<LocalLinkRow>? {
    val v = JsonText.parseOrNull(raw.toString(Charsets.UTF_8)).objectValue ?: return null
    if (v["schema"].stringValue != LOCAL_STATE_SCHEMA || v["product"].stringValue != product) return null
    val list = v["links"].arrayValue ?: return null
    if (list.size > MAX_LOCAL_LINKS) return null
    val out = ArrayList<LocalLinkRow>(list.size)
    val seen = HashSet<String>()
    for (e in list) {
        val o = e.objectValue ?: return null
        val labelEl = o["label"]
        if (labelEl != null && labelEl.stringValue == null) return null
        val seenEl = o["lastSeen"]
        if (seenEl != null && seenEl.longValue == null) return null
        val row = LocalLinkRow(
            id = o["id"].stringValue ?: return null,
            ownKey = o["ownKey"].stringValue ?: return null,
            ownPublic = o["ownPublic"].stringValue ?: return null,
            peerKey = o["peerKey"].stringValue ?: return null,
            secret = o["secret"].stringValue ?: return null,
            label = labelEl.stringValue,
            cats = o["cats"].arrayValue?.map { it.stringValue ?: return null } ?: return null,
            createdAt = o["createdAt"].longValue ?: return null,
            lastSeen = seenEl.longValue,
            reachable = o["reachable"].boolValue ?: return null,
        )
        // A record with two rows of one id is unusable: it was not written by this code.
        if (!row.valid() || !seen.add(row.id)) return null
        out += row
    }
    return out
}

/** The links this device holds for one product. Every call is serialised. */
internal class LocalLinkStore(private val product: String, private val open: suspend () -> DeviceKeyStorage) {
    private val lock = Mutex()
    private var storage: DeviceKeyStorage? = null

    override fun toString(): String = "LocalLinkStore"

    private suspend fun storage(): DeviceKeyStorage = storage ?: open().also { storage = it }

    private fun error(e: Exception): PolarisException =
        PolarisException(ErrorCode.storeFailed, "The local links could not be used: ${e.message ?: "store fault"}", cause = e)

    private fun unreadable(): PolarisException = PolarisException(ErrorCode.storeFailed, "The local links record is unreadable.")

    private suspend fun load(): List<LocalLinkRow> {
        val raw = try {
            storage().get()
        } catch (e: StoreException) {
            throw error(e)
        } catch (e: DeviceKeysUnreadableException) {
            throw error(e)
        } ?: return emptyList()
        try {
            return parseLocalState(raw, product) ?: throw unreadable()
        } finally {
            raw.fill(0)
        }
    }

    /** The rows, with their keys and secrets: they stay inside the SDK. */
    suspend fun rows(): List<LocalLinkRow> = lock.withLock { load() }

    suspend fun count(): Int = rows().size

    /**
     * Change the rows under the store's lock: [fn] returns the new rows, or null for no change. Resolves with the rows as
     * they are after. The read, the judgement and the write run inside the storage's own lock.
     */
    suspend fun update(fn: (List<LocalLinkRow>) -> List<LocalLinkRow>?): List<LocalLinkRow> = lock.withLock {
        var result: List<LocalLinkRow> = emptyList()
        try {
            storage().update { current ->
                var base: List<LocalLinkRow> = emptyList()
                if (current != null) base = parseLocalState(current, product) ?: throw unreadable()
                val next = fn(base)
                result = next ?: base
                next?.let { encodeLocalState(product, it) }
            }
        } catch (e: StoreException) {
            throw error(e)
        } catch (e: DeviceKeysUnreadableException) {
            throw error(e)
        }
        result
    }

    /**
     * Add a link, unless the device already holds [MAX_LOCAL_LINKS]. The cap is judged under the lock, so two pairings that
     * finish together cannot both pass it. The new link is reachable while fewer than [MAX_LIVE_LOCAL_ADVERTS] are, else it
     * is stored off and the list says so (section 15.12, "Reachable by default"). Null at the cap.
     */
    suspend fun add(
        ownKey: ByteArray,
        ownPublic: ByteArray,
        peerKey: ByteArray,
        secret: ByteArray,
        label: String?,
        cats: List<String>,
        now: Long,
    ): String? {
        val id = localLinkId(peerKey)
        var full = false
        update { rows ->
            if (rows.size >= MAX_LOCAL_LINKS) {
                full = true
                return@update null
            }
            val others = rows.filter { it.id != id }
            val reachable = others.count { it.reachable } < MAX_LIVE_LOCAL_ADVERTS
            others + LocalLinkRow(
                id, Base64Url.encode(ownKey), Base64Url.encode(ownPublic), Base64Url.encode(peerKey), Base64Url.encode(secret),
                label, cats, now, null, reachable,
            )
        }
        return if (full) null else id
    }
}
