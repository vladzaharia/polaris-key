// The Cloud Sync machine's shared mutable state and its gate predicates. The behaviour lives in the
// collaborators of [MachineParts]; they all read and write this one object.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_CLIENT_ID_PATTERN
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** What the Worker advertises for `services.sync.encryption` (a missing member is `omitted`). */
public data class SyncDiscovery(val encryption: String?)

/** The host's options (the TypeScript `CloudSyncOptions`). */
public class CloudSyncOptions(
    public val product: String,
    public val catalog: JsonObject,
    public val document: JsonObject,
    public val now: Long,
    public val newClientId: () -> String,
) {
    public var offsetMs: Long = 0
    public var contacted: Boolean = false
    public var subject: String? = null
    public var network: String = "online"
    public var onSignOut: String = "clear"
    public var deviceLocal: Map<String, JsonElement> = emptyMap()
    public var imported: Boolean = false
    public var encryption: String? = null
    public var hasRoot: Boolean = false
    public var discovery: SyncDiscovery? = null

    /** The same options with the clock and network taken from a running machine (a relaunch). */
    public fun copyWith(now: Long, network: String): CloudSyncOptions = CloudSyncOptions(product, catalog, document, now, newClientId).also {
        it.offsetMs = offsetMs
        it.contacted = contacted
        it.subject = subject
        it.network = network
        it.onSignOut = onSignOut
        it.deviceLocal = deviceLocal
        it.imported = imported
        it.encryption = encryption
        it.hasRoot = hasRoot
        it.discovery = discovery
    }
}

/** The request in flight: its kind, partition, cursor and the mutation ids it carries. */
internal class InFlight(val kind: String, val partition: String, val cursor: Long, val mutationIds: List<Long>)

/** A sign-out waiting for its bounded flush. */
internal class SigningOut(val deadline: Long, val discard: Boolean)

internal class MachineCore(val opts: CloudSyncOptions, var s: MachineState) {
    private val clientIdPattern = Regex(SYNC_CLIENT_ID_PATTERN)

    var now: Long = opts.now
    var network: String = opts.network
    var root: Boolean = opts.hasRoot
    var advertised: String? = opts.discovery?.let { it.encryption ?: "omitted" }
    val appEncryption: String = opts.encryption ?: "e2e"
    val drafts: LinkedHashMap<String, Draft> = linkedMapOf()
    var inFlight: InFlight? = null
    var signingOut: SigningOut? = null
    var needSnapshot: Boolean = false
    var pullWanted: Boolean = false
    var paused: Boolean = false
    val outbox: MutableList<JsonObject> = mutableListOf()
    val events: MutableList<SyncEvent> = mutableListOf()

    /** The app requires E2E, or this device has accepted it before: the pin cannot be undone. */
    fun requiresE2e(): Boolean = appEncryption == "e2e" || s.e2eSeen

    /** The Worker's answer contradicts the mode: nothing is sent to it and nothing it says is read. */
    fun pinnedOut(): Boolean {
        val said = advertised ?: return false
        return if (requiresE2e()) said != "e2e" else said == "e2e"
    }

    /** E2E with no root for the ring. */
    fun lockedOut(): Boolean = requiresE2e() && !root

    fun mayTalk(): Boolean = !pinnedOut() && !lockedOut()

    fun partitionFor(name: String): SyncPartition =
        s.partitions.getOrPut(name) { SyncPartition(if (name == LOCAL_PARTITION) null else freshClientId()) }

    fun active(): SyncPartition = partitionFor(s.subject ?: LOCAL_PARTITION)

    fun freshClientId(): String {
        val id = opts.newClientId()
        require(clientIdPattern.containsMatchIn(id)) { "bad clientId" }
        return id
    }
}
