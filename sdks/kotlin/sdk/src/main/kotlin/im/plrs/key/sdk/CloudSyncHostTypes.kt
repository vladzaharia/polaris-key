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

    /** The newest save `formatVersion` this build reads (D-11); a save above it reads as `NewerFormat`. Null turns the check off. */
    public var saveFormatVersion: Int? = null

    /**
     * Keep a save write going while the app is in the background (U-41.7b). Off by default. On, a platform binding that
     * sets [backgroundPort] (the Android entry point does) is told of each write; with no port it changes nothing.
     */
    public var backgroundTransfers: Boolean = false

    /** The platform's scheduler for background transfers; set by the platform binding, not by app code. */
    public var backgroundPort: CloudSyncBackgroundPort? = null

    internal fun background(): CloudSyncBackgroundPort? = if (backgroundTransfers) backgroundPort else null
}

/** How a scheduled background run of one transfer came out; the platform maps it to its scheduler's result. */
public enum class BackgroundTransferOutcome {
    /** The write finished (or ended in a conflict the app settles). */
    DONE,

    /** Not finished and worth another run: the system stopped it. */
    RETRY,

    /** Never run again: cancelled, failed, paused, signed out, another person, or no such write. */
    STOP,
}

/** The SDK's side of a background run, handed to the port once. It reads the live write; it carries and needs no credential. */
public fun interface CloudSyncBackgroundRunner {
    public suspend fun run(transferId: String, owner: String): BackgroundTransferOutcome
}

/**
 * What a platform gives the SDK to keep a write alive in the background. Only opaque ids cross it: the SHA-256 hex of the
 * transfer id (a transfer id names a save) and an owner tag (the SHA-256 hex of the signed-in person), never a token, a
 * key or a file name. The write itself runs in the
 * SDK, which fetches its token per request.
 */
public interface CloudSyncBackgroundPort {
    /** Called once, when the client is built: the platform runs a scheduled transfer through [runner]. */
    public fun attach(runner: CloudSyncBackgroundRunner)

    /** A write the person started: schedule it (user-initiated work). [transferId] is the SHA-256 hex of the write's id. */
    public fun enqueue(transferId: String, owner: String)

    /** The write ended, or was cancelled: drop what is still scheduled for it. */
    public fun cancel(transferId: String)

    /** Sign-out and forget: drop everything scheduled for [owner] and wait until it has stopped. Called off the main thread. */
    public fun cancelOwner(owner: String)
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
