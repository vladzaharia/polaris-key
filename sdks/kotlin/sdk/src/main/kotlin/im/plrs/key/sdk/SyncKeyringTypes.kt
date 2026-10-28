// The types of `client.keyring` (U-39.8): its options, results, the codec the E2E machine seals with,
// and the roots in memory. Nothing here prints key material: a type that holds a root prints as redacted.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncEnvelope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The record names beside the device keys, in the state directory. */
public const val SYNC_ROOT_FILE: String = "pkey.sync-root.v1.bin"
public const val SYNC_PIN_FILE: String = "pkey.sync-ring-pin.v1.json"

/** What the host may give the key ring. */
public data class KeyringOptions @JvmOverloads constructor(
    /**
     * This device's keys: give the same port you gave [ConnectOptions]. Default: the one `connect`
     * uses (the state directory's 0600 file); Android has no default.
     */
    val keys: DeviceKeyPort? = null,
    /**
     * Where the root is kept between launches. Default: the 0600 file `pkey.sync-root.v1.bin` in
     * the state directory, or memory only without one. Android: `androidSyncRootStorage(...)`.
     */
    val rootStorage: DeviceKeyStorage? = null,
)

/** Told when this device gains or loses the root: Cloud Sync's machine takes the root as a flag. */
public fun interface SyncRootListener {
    public fun setRoot(present: Boolean)
}

/** The ring a device pinned: the first one it acquired a root for. It holds no secret. */
public data class SyncRingPin(val ringId: String, val epoch: Int, val rootKid: String)

/** The served ring, as `GET /<p>/devices/keyring` answers it. */
public data class SyncKeyringRing(
    val ringId: String,
    val epoch: Int,
    val rootKid: String,
    val state: String,
    val createdAt: Long,
    val recoverySet: Boolean,
    val recoveryCreatedAt: Long?,
    val adopted: List<Adopted>,
    val previous: Previous?,
) {
    public data class Adopted(val ringId: String, val epoch: Int, val kid: String, val ct: String)

    public data class Previous(val ringId: String, val kid: String, val until: Long)
}

/** This device's own wrap, as served. [kem] is the HPKE KEM id (`32`), or an older Worker's `"x25519"`. */
public data class SyncKeyringWrapInfo(val epoch: Int, val kid: String, val kem: JsonElement, val enc: String, val ct: String, val by: String?)

public data class SyncKeyringState(val ring: SyncKeyringRing?, val wrap: SyncKeyringWrapInfo?)

/** What this device holds right now; no request is made. */
public data class SyncKeyringStatus(
    val unlocked: Boolean,
    val ringId: String?,
    val epoch: Int?,
    val pinned: SyncRingPin?,
    /** Whether the root storage holds a root for this product. */
    val rootStored: Boolean,
    /** [DeviceKeyPersistence.memory]: the root dies with the process. */
    val rootPersistence: DeviceKeyPersistence,
)

public sealed interface SyncUnlockResult {
    public data class Unlocked(val ringId: String, val epoch: Int) : SyncUnlockResult

    public data class Locked(val reason: LockReason) : SyncUnlockResult

    /**
     * The served ring is not the pinned one. Nothing was opened or replaced; confirm with the person,
     * then [SyncKeyring.recover] or [SyncKeyring.acceptRingChange]. [by] is the device that wrapped.
     */
    public data class RingChanged(val pinned: SyncRingPin, val served: SyncRingPin, val createdAt: Long, val by: String?) : SyncUnlockResult

    public enum class LockReason(public val wire: String) { NoRing("no-ring"), NoWrap("no-wrap"), UnusableWrap("unusable-wrap") }
}

/** A new ring. It prints without the recovery code. */
public class SyncCreatedRing(
    public val ringId: String,
    public val epoch: Int,
    public val rootKid: String,
    /** The recovery code, shown once, when the ring was created with one. */
    public val recoveryCode: String?,
) {
    override fun toString(): String = "SyncCreatedRing(ringId=$ringId, epoch=$epoch)"
}

public data class SyncRecovered(
    val ringId: String,
    val epoch: Int,
    /** False when the Worker refused this device's own wrap or one already stood. */
    val wrapDeposited: Boolean,
)

public data class SyncRecoveryBlob(val ct: String, val epoch: Int, val kid: String)

/** The key material of one ring. It prints as redacted. */
internal class HeldRoot(val ringId: String, val epoch: Int, val kid: ByteArray, val root: ByteArray) {
    fun matches(ringId: String, epoch: Int, kid: ByteArray): Boolean =
        this.ringId == ringId && this.epoch == epoch && SyncCrypto.equalBytes(this.kid, kid)

    override fun toString(): String = "HeldRoot(redacted)"
}

/** The roots in memory, shared between the keyring and its codec. */
internal class RingMemory {
    private val lock = Any()
    private var heldValue: HeldRoot? = null
    private var othersValue: List<HeldRoot> = emptyList()
    private val listeners = LinkedHashMap<Int, SyncRootListener>()
    private var nextId = 0

    val held: HeldRoot? get() = synchronized(lock) { heldValue }
    val others: List<HeldRoot> get() = synchronized(lock) { othersValue }

    fun set(held: HeldRoot?, others: List<HeldRoot>? = null) {
        val ls = synchronized(lock) {
            heldValue = held
            if (others != null) othersValue = others
            listeners.values.toList()
        }
        for (l in ls) l.setRoot(held != null)
    }

    fun addOther(h: HeldRoot) {
        synchronized(lock) { othersValue = othersValue.filter { it.ringId != h.ringId } + h }
    }

    fun attach(l: SyncRootListener): () -> Unit {
        val (id, present) = synchronized(lock) {
            nextId++
            listeners[nextId] = l
            nextId to (heldValue != null)
        }
        l.setRoot(present)
        return { synchronized(lock) { listeners.remove(id) } }
    }

    override fun toString(): String = "RingMemory(redacted)"
}

internal fun lockedError() = PolarisException(ErrorCode.syncLocked, "This device holds no root for the key ring; unlock it first.")

/**
 * What the E2E machine's host seals and opens with. It holds no key itself: every call reads the
 * ring's current root, and refuses with `sync-locked` once the ring is locked.
 */
public class SyncCodec internal constructor(private val memory: RingMemory) : SyncCodecPort {
    /** The current root's `kid`, lowercase hex; null while locked. */
    public val kid: String? get() = memory.held?.let { hex(it.kid) }
    override val locked: Boolean get() = memory.held == null

    override fun toString(): String = "SyncCodec(locked=$locked)"

    private fun need(): HeldRoot = memory.held ?: throw lockedError()

    override fun seal(collection: String, name: String, value: JsonElement): ByteArray = SyncEnvelope.seal(need().root, collection, name, value)

    /** Tries the current root, then any adopted root whose `kid` the envelope names. */
    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>): SyncEnvelope.Opened =
        tryRoots(envelope) { SyncEnvelope.open(it, collection, name, envelope, aliases) }

    /** Opens an envelope whose name is inside it. The caller checks the name it gets back. */
    override fun openAny(collection: String, envelope: ByteArray): SyncEnvelope.Opened =
        tryRoots(envelope) { SyncEnvelope.openAnyName(it, collection, envelope) }

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String): String = SyncBlind.blind(need().root, kind, ctx, name)

    private fun tryRoots(envelope: ByteArray, attempt: (ByteArray) -> SyncEnvelope.Opened): SyncEnvelope.Opened {
        val first = attempt(need().root)
        if (!isKidMismatch(first) || envelope.size < 1 + SyncCrypto.KID_BYTES) return first
        val kid = envelope.copyOfRange(1, 1 + SyncCrypto.KID_BYTES)
        // Another held root whose kid the envelope names; the first that does not answer kid-mismatch wins.
        val answers = memory.others.asSequence().filter { SyncCrypto.equalBytes(it.kid, kid) }.map { attempt(it.root) }
        return answers.firstOrNull { !isKidMismatch(it) } ?: first
    }

    private fun isKidMismatch(o: SyncEnvelope.Opened): Boolean = o is SyncEnvelope.Opened.Refused && o.reason == SyncEnvelope.Invalid.Kid
}

internal fun anyNull(vararg xs: Any?): Boolean = xs.any { it == null }

internal fun refuse(code: String, what: String, cause: Throwable? = null): Nothing = throw PolarisException(code, what, cause = cause)

internal fun badArg(what: String) = PolarisException(ErrorCode.invalidArgument, what)

internal fun badResponse(what: String) = PolarisException(ErrorCode.badResponse, what)

internal fun segment(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")

internal fun needDeviceId(deviceId: String) {
    if (deviceId.isEmpty() || deviceId.any { it in "/?#" || it.isWhitespace() }) throw badArg("A device id is required.")
}

internal val RING_ID = Regex("^rg_[A-Za-z0-9_-]{22}$")

internal fun obj(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*pairs))

internal fun str(s: String): JsonElement = JsonPrimitive(s)
