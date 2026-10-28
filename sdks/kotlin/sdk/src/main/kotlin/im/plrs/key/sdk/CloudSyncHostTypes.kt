// What the Cloud Sync host takes: the app's options, and the functions it reads the client through.

package im.plrs.key.sdk

import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncDiscovery
import im.plrs.key.core.sync.SyncResponse
import kotlinx.serialization.json.JsonObject
import java.io.File

/** What app code sets. Never read from the Worker. */
public class CloudSyncHostOptions {
    /** The product's mode, `e2e` (default) or `server`. A `server` app still refuses a Worker it has seen speak E2E. */
    public var encryption: String = "e2e"

    /** The catalog compiled into the app (`pkey mirror`): used until `/config/schema` is fetched once, and authoritative for its keys. */
    public var catalog: JsonObject? = null

    /** Renames the app declares (old name to current name). Never taken from a served body. */
    public var aliases: Map<String, String> = emptyMap()
}

/** What the host needs from the client; each is a function so the host holds no stale copy. */
public class CloudSyncHostDeps(
    public val product: String,
    /** The state directory (on Android the store's no-backup directory, Q-6). */
    public val stateDir: File,
    /** One exchange of a machine request ([CloudSyncTransport.send]). */
    public val send: suspend (JsonObject) -> SyncResponse,
    public val codec: SyncCodecPort,
    /** The signed config document's `values` and the keys it `locked`. */
    public val document: suspend () -> JsonObject,
) {
    /**
     * `send` with the person the request is bound to: the live wiring re-reads the stored subject after it reads the
     * token and refuses the request when it is another person's. Null: [send] alone.
     */
    public var sendFor: (suspend (JsonObject, String?) -> SyncResponse)? = null

    public var keyringUnlocked: () -> Boolean = { false }
    public var attachKeyring: (im.plrs.key.sdk.SyncRootListener) -> () -> Unit = { { } }

    /** Whether the product runs Cloud Sync (discovery or the build's declaration). */
    public var syncEnabled: suspend () -> Boolean = { true }

    /** `services.sync.encryption` from the loaded discovery document; null: not loaded or Sync off. */
    public var discovery: suspend () -> SyncDiscovery? = { null }

    /** `GET /config/schema` (diagnostic and unsigned; null on any failure). */
    public var fetchSchema: suspend () -> JsonObject? = { null }

    /** The person the session's token belongs to; null when unknown (offline, discovery not loaded). */
    public var subject: suspend () -> String? = { null }

    /** How long to wait before retry number `attempt` (1-based) after a transport failure: bounded and jittered. */
    public var retryDelayMs: (Int) -> Long = { attempt -> defaultRetryDelayMs(attempt) }

    /** Whether to install the JVM shutdown hook that flushes (bounded); Android's lifecycle does that job there. */
    public var shutdownHook: Boolean = true

    /** The clock, in epoch milliseconds. */
    public var clock: () -> Long = System::currentTimeMillis
}

/** The most retries after one outage; the next edit or timer tick with new work starts a fresh run. */
public const val SYNC_MAX_RETRIES: Int = 8
private const val RETRY_BASE_MS = 1_000L
private const val RETRY_MAX_MS = 60_000L

/** Exponential backoff from one second to one minute, with 50 to 100 percent jitter. */
public fun defaultRetryDelayMs(attempt: Int): Long {
    val capped = minOf(RETRY_MAX_MS, RETRY_BASE_MS shl minOf(attempt - 1, RETRY_SHIFT_CAP))
    return (capped * (JITTER_FLOOR + java.util.concurrent.ThreadLocalRandom.current().nextDouble() * JITTER_SPAN)).toLong()
}

private const val RETRY_SHIFT_CAP = 10
private const val JITTER_FLOOR = 0.5
private const val JITTER_SPAN = 0.5
