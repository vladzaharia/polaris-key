// The Cloud Sync settings API (U-07.K9): what app code sees on top of the host ([CloudSyncHost]). A port of
// Swift's `CloudSyncApi.swift`, Python's `cloud_sync/api.py` and Node's `cloudSync/api.ts`.
//
//  - `client.cloudSync.status()` / `flush()` / `newRecoveryCode()`, and `client.events` `PolarisEvent.CloudSync`;
//  - `config.set` / `clear` / `setting(k).sync()` routed through the machine while a principal is held
//    ([ConfigSyncPort]).
//
// The identity session drives the machine, in order, on one consumer:
//  - A-1  A person change never talks to the server. The old person's unsynced edits are discarded and
//         their synced projection leaves the machine before anything waits (`signOut(discardUnsynced)`),
//         then the ring is forgotten and the data purged, then the new person signs in. The host drops any
//         request bound to the old person (HOST-BIND).
//  - A-2  An offline boot is not a sign-out. An unknown subject (nothing held, discovery not loaded, a
//         network error) changes nothing; only a readable "no session" leaves.
//  - A-3  Sign-out, the old token still current: Connect stops (bounded) and leaves, then a bounded flush while
//         the machine is signed in and the root is held, then the ring forgets (the E2E flush needs the root),
//         THEN the machine signs out and the data is purged. A forget that throws stops the sign-out before the
//         Worker is asked, leaves the machine as it was, purges nothing and returns its error (D-13; the session
//         stays, a retry forgets again); a purge failure is reported ([CloudSyncEvent.PurgeFailed]) and never
//         replaces the sign-out's result. Purge also runs when Sync is off.
//  - A-4  A sign-out that happens elsewhere (`account_required`, a released device) reaches the machine as
//         `signedOut` and forgets and purges once.
//  - A-5  `signInUrl` is vetted ([safeSignInUrl]): no control characters or whitespace, resolved against the
//         Worker origin, https on that origin only. The offer follows the forget and comes only for
//         `accountRequired` / `subjectChanged`.
//  - A-6  The legacy local values are offered to the machine once per install (a marker kept apart from the
//         state file, written after sign-in succeeds); the locked list is rebuilt before `set` / `clear`
//         after a document refresh.
//  - A-7  The mode is app code's ([CloudSyncHostOptions]); licence state is never read or written here.
// No event, log line or error carries a value or the root; events name keys and codes only (H-11).
//
// Concurrency: the API's own state is confined to one single-thread dispatcher (a suspended call frees it).
// No lock is held across the host or the network.

package im.plrs.key.sdk

import im.plrs.key.config.ConfigClient
import im.plrs.key.config.ConfigSyncPort
import im.plrs.key.config.SettingSyncState
import im.plrs.key.config.importable
import im.plrs.key.config.noteSyncChange
import im.plrs.key.config.schemaJson
import im.plrs.key.config.syncDocument
import im.plrs.key.config.useSync
import im.plrs.key.core.CoreContext
import im.plrs.key.core.Feature
import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.ReadResult
import im.plrs.key.core.sync.SyncDiscovery
import im.plrs.key.core.sync.SyncEvent
import im.plrs.key.core.sync.SyncStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import java.net.URI

/** One Cloud Sync event for app code: the machine's events, and [PurgeFailed]. Names keys and codes only (H-11). */
public sealed interface CloudSyncEvent {
    /** These settings changed; [origin] is `local`, `remote`, `merge` or `migration`. */
    public data class Change(val keys: List<String>, val origin: String) : CloudSyncEvent

    /** The Worker refused one of this device's edits. */
    public data class Rejected(val mutationId: Long, val code: String) : CloudSyncEvent

    /** The person left: [reason] is `signOut`, `accountRequired` or `subjectChanged`. */
    public data class SignedOut(val reason: String, val unsynced: Int) : CloudSyncEvent

    /** Edits that never reached the cloud were left behind. */
    public data class UnsyncedData(val count: Int) : CloudSyncEvent

    /** The app may offer sign-in; [signInUrl] is vetted (https on the Worker's origin) or null. */
    public data class SignInOffered(val signInUrl: String?) : CloudSyncEvent

    /** The synced data could not be deleted from disk (no values, no path): the app may warn the person. */
    public data object PurgeFailed : CloudSyncEvent

    public companion object {
        internal fun of(e: SyncEvent): CloudSyncEvent = when (e) {
            is SyncEvent.Change -> Change(e.keys, e.origin)
            is SyncEvent.Rejected -> Rejected(e.mutationId, e.code)
            is SyncEvent.SignedOut -> SignedOut(e.reason, e.unsynced)
            is SyncEvent.UnsyncedData -> UnsyncedData(e.count)
            is SyncEvent.SignInOffered -> SignInOffered(e.signInUrl)
        }
    }
}

/** The "New recovery code" action's model: [generate] makes a fresh code through the key ring and returns it once. The code is kept nowhere. */
public class RecoveryCodeModel internal constructor(private val make: suspend () -> String) {
    public suspend fun generate(): String = make()
}

/** `client.cloudSync`: the verbs. A product without the Sync service gets the typed N/A. */
public class CloudSyncClient internal constructor(private val api: CloudSyncApi) {
    /** The machine's status. `local` before Cloud Sync has started. Throws the typed `product` N/A when the product does not run the Sync service. */
    public suspend fun status(): SyncStatus = api.status()

    /** Send what is waiting now (bounded by the sign-out flush window), save the journal and answer the status. */
    public suspend fun flush(): SyncStatus = api.flush()

    /** A new recovery code for the key ring (`SyncKeyring.setRecoveryCode`). Shown once, kept nowhere. */
    public suspend fun newRecoveryCode(): String = api.newRecoveryCode()

    /** The app came back to the foreground: nudge the machine and retry a key ring forget that failed. Quiet for a product without Sync. */
    public suspend fun touch(): Unit = api.touch()

    /** The recovery-code screen's model. */
    public val recoveryCode: RecoveryCodeModel = RecoveryCodeModel { api.newRecoveryCode() }
}

/**
 * A sign-in URL fit to hand to the app: https on the Worker's origin, else null. A path is resolved against
 * the origin; control characters and whitespace are refused before parsing.
 */
internal fun safeSignInUrl(url: String?, origin: String): String? {
    if (url == null || url.any { it.code <= 0x20 || it.code in 0x7F..0x9F }) return null
    val base = runCatching { URI(origin) }.getOrNull() ?: return null
    val resolved = runCatching { base.resolve(URI(url)) }.getOrNull() ?: return null
    fun port(u: URI) = if (u.port == -1) HTTPS_PORT else u.port
    val ok = resolved.scheme.equals("https", true) && base.scheme.equals("https", true) &&
        resolved.host != null && resolved.host.equals(base.host, true) && port(resolved) == port(base)
    return if (ok) resolved.toString() else null
}

private const val HTTPS_PORT = 443
private val RETRY_DELAYS_MS = listOf(1_000L, 5_000L, 30_000L)

@OptIn(ExperimentalCoroutinesApi::class)
internal class CloudSyncApi(
    private val core: CoreContext,
    private val config: ConfigClient,
    private val makeHost: () -> CloudSyncHost,
    private val account: suspend () -> String?,
    private val emit: (CloudSyncEvent) -> Unit,
    private val forgetRing: suspend () -> Unit,
    private val recovery: suspend () -> String,
) {
    private sealed interface Work {
        class Identity(val subject: String?) : Work

        class Marker(val done: CompletableDeferred<Unit>) : Work
    }

    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var hostValue: CloudSyncHost? = null
    private var attached = false
    private val attachLock = Mutex()
    private var subject: String? = null

    /** While a hook forgets explicitly, the machine's own `signedOut` does not start a second forget. */
    private var explicitForget = false
    private var forgetJob: Job? = null
    private val queue = Channel<Work>(Channel.UNLIMITED)
    private var consumer: Job? = null
    private val eventLock = Any()
    private var eventTail: Job? = null

    private fun host(): CloudSyncHost = hostValue ?: makeHost().also { hostValue = it }

    private suspend fun startedHost(): CloudSyncHost? = hostValue?.takeIf { it.isStarted() }

    // ── what app code calls ──────────────────────────────────────────────────────────────────────

    suspend fun status(): SyncStatus {
        core.requireService(ServiceSlug.sync, Feature.syncSettings)
        return withContext(dispatcher) {
            val h = startedHost() ?: return@withContext SyncStatus(im.plrs.key.core.sync.SyncState.Local, 0)
            h.withMachine { it.status() }
        }
    }

    suspend fun flush(): SyncStatus {
        core.requireService(ServiceSlug.sync, Feature.syncSettings)
        withContext(dispatcher) {
            attach()
            drain()
            hostValue?.takeIf { it.isStarted() }?.flush()
            drain()
        }
        return status()
    }

    suspend fun newRecoveryCode(): String = recovery()

    // ── what the client calls ────────────────────────────────────────────────────────────────────

    /** An identity change (the subject now held; null: none), queued and handled in order. Never blocks. */
    fun onIdentity(subject: String?) {
        ensureConsumer()
        queue.trySend(Work.Identity(subject))
    }

    fun attachSoon() {
        scope.launch { attach() }
    }

    /** Start the host and sign the machine in as the held subject. Idempotent; a no-op while the product does not run the Sync service. */
    suspend fun attach() {
        withContext(dispatcher) {
            if (forgetPending) startForget()
            if (attached || !core.enabled(ServiceSlug.sync)) return@withContext
            attachLock.withLock {
                if (attached) return@withContext
                start()
            }
        }
    }

    /** The signed config document refreshed: lift a block, and rebuild if the document changed. */
    suspend fun noteDocumentRefreshed() {
        withContext(dispatcher) { startedHost()?.noteDocumentRefreshed() }
    }

    /** Discovery loaded: tell the machine what `services.sync` says, and start the host if it can now. */
    suspend fun noteDiscovery() {
        withContext(dispatcher) { startedHost()?.noteDiscovery() }
        attach()
    }

    /** The client closed: stop the host (a bounded wait, the journal saved) and the API's own work. */
    suspend fun close() {
        withContext(dispatcher) {
            queue.close()
            hostValue?.close()
        }
        scope.coroutineContext[Job]?.cancel()
    }

    /** The client's `close()`: stop the host in the background (never blocks the caller). */
    fun closeSoon() {
        CoroutineScope(Dispatchers.Default).launch { runCatching { close() } }
    }

    private suspend fun start() {
        val h = host()
        try {
            h.start()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        attached = true
        ensureConsumer()
        h.onEvents { events -> queueEvents(events) }
        config.useSync(Port())
        // A journal saved while signed in still names its subject.
        subject = h.withMachine { it.subject }
        // A-2: an unknown subject changes nothing; a known one signs in.
        account()?.let { signIn(it) }
    }

    private fun ensureConsumer() {
        if (consumer != null) return
        consumer = scope.launch {
            for (work in queue) {
                when (work) {
                    is Work.Marker -> work.done.complete(Unit)
                    is Work.Identity -> onIdentityNow(work.subject)
                }
            }
        }
    }

    /** Wait for every identity change queued so far. Never from inside a handler. */
    private suspend fun drain() {
        if (consumer == null) return
        val done = CompletableDeferred<Unit>()
        if (queue.trySend(Work.Marker(done)).isSuccess) done.await()
    }

    /** The machine's events, handled one batch at a time and in order, off whatever thread ran the pump. */
    private fun queueEvents(events: List<SyncEvent>) {
        synchronized(eventLock) {
            val prev = eventTail
            eventTail = scope.launch {
                prev?.join()
                onEvents(events)
            }
        }
    }

    /** Wait for the batches the machine has raised so far (safe inside a handler). */
    private suspend fun drainEvents() {
        synchronized(eventLock) { eventTail }?.join()
    }

    // ── identity (A-1, A-2, A-4) ─────────────────────────────────────────────────────────────────

    private suspend fun onIdentityNow(target: String?) {
        attach()
        val h = startedHost() ?: return
        if (target != null) {
            if (target != subject) signIn(target)
        } else if (subject != null) {
            // A readable "no session": the principal is gone with the account (a sign-out elsewhere, a released device).
            leave(h)
        }
    }

    private suspend fun signIn(target: String) {
        val h = host()
        if (!h.isStarted()) return
        // Another person: the first leaves (unsynced edits dropped, then forgotten) before this one starts. The device
        // credential is already the new person's, so nothing is sent for the old one.
        val old = subject
        if (old != null && old != target) leave(h)
        // Once per install, before the first principal arrives so the values enter at the floor and a newer cloud
        // value wins. The marker is written after the sign-in succeeded (A-6).
        val importing = h.offerLocal(config.importable())
        subject = target
        val result = h.withMachine { it.signIn(target) }
        if (result is CallResult.Failed) {
            subject = null
            return
        }
        h.resume()
        if (importing) h.markImported()
        // Never awaits the pump: its exchanges take as long as the network.
        h.kick()
        settle()
    }

    /** The principal leaves without a flush: unsynced edits dropped, the old synced values out of memory before anything waits. */
    private suspend fun leave(h: CloudSyncHost) {
        subject = null
        h.withMachine { it.signOut(discardUnsynced = true) }
        h.touch()
        drainEvents()
        settle()
    }

    /**
     * The identity client's pre-sign-out hook (the old token is still current): bounded flush while the machine
     * is signed in and the root is held, then the ring forgets, THEN the machine signs out and the data is purged
     * (A-3). A forget that fails stops the sign-out (D-13): its error is returned before the machine is touched
     * or anything is purged, so everything stays as it was and a retry forgets again.
     */
    suspend fun beforeSignOut() {
        withContext(dispatcher) {
            drain()
            explicitForget = true
            try {
                val h = startedHost()?.takeIf { subject != null }
                if (h != null) {
                    h.flush(SYNC_SIGNOUT_FLUSH_MS.toLong())
                    drainEvents()
                }
                withContext(NonCancellable) { forgetRing() }
                if (h != null) {
                    h.withMachine { it.signOut() }
                    h.touch()
                    // Still waiting on a flush the vanished root cannot do: leave now (what was left is reported).
                    h.withMachine { if (it.subject != null) it.signOut(discardUnsynced = true) }
                    h.touch()
                    drainEvents()
                }
                subject = null
                withContext(NonCancellable) { purge() }
            } finally {
                explicitForget = false
            }
        }
    }

    private suspend fun purge() {
        try {
            host().purge()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emit(CloudSyncEvent.PurgeFailed)
        }
    }

    // ── the machine's events (A-4, A-5) ──────────────────────────────────────────────────────────

    private suspend fun onEvents(events: List<SyncEvent>) {
        val leftReasons = events.filterIsInstance<SyncEvent.SignedOut>().map { it.reason }
        val left = leftReasons.isNotEmpty()
        // The root leaves memory before anything else runs.
        val forgotten = if (left && !explicitForget) startForget() else null
        for (e in events) {
            when (e) {
                is SyncEvent.SignedOut -> subject = null
                is SyncEvent.Change -> config.noteSyncChange(e.keys, e.origin)
                else -> {}
            }
            // Offered below, after the forget.
            if (e is SyncEvent.SignInOffered && left) continue
            if (e is SyncEvent.SignInOffered) {
                emit(CloudSyncEvent.SignInOffered(safeSignInUrl(e.signInUrl, originString())))
                continue
            }
            emit(CloudSyncEvent.of(e))
        }
        if (forgotten != null) {
            forgotten.join()
            val offers = events.filterIsInstance<SyncEvent.SignInOffered>().map { it.signInUrl }
            val wants = leftReasons.any { it == "accountRequired" || it == "subjectChanged" }
            if (wants || offers.isNotEmpty()) {
                for (u in offers.ifEmpty { listOf(null) }) emit(CloudSyncEvent.SignInOffered(safeSignInUrl(u, originString())))
            }
        }
    }

    private fun originString(): String {
        val b = core.endpoints.baseUrl
        val u = runCatching { URI(b) }.getOrNull() ?: return b
        val scheme = u.scheme ?: return b
        val host = u.host ?: return b
        return "$scheme://$host" + if (u.port != -1) ":${u.port}" else ""
    }

    /** Set while a forget the machine's own sign-out asked for has not succeeded: retried, never dropped silently (D-13). */
    private var forgetPending = false
    private var forgetAttempts = 0

    /**
     * Ring first, then the purge; single-flight so two events never forget twice at once. A forget that fails
     * (a locked keystore) leaves the root where it was, purges nothing, logs a static line and is retried: after
     * a delay (three times) and at the next attach, touch or flush.
     */
    private fun startForget(): Job {
        forgetJob?.let { return it }
        val job = scope.launch {
            val ok = withContext(NonCancellable) {
                try {
                    forgetRing()
                    true
                } catch (e: Exception) {
                    false
                }
            }
            if (ok) {
                forgetPending = false
                forgetAttempts = 0
                withContext(NonCancellable) { purge() }
            } else {
                forgetPending = true
                java.util.logging.Logger.getLogger("im.plrs.key.sdk").warning("Cloud Sync: the key ring root could not be removed; it will be retried.")
                if (forgetAttempts < RETRY_DELAYS_MS.size) {
                    val wait = RETRY_DELAYS_MS[forgetAttempts++]
                    scope.launch {
                        delay(wait)
                        if (forgetPending) startForget()
                    }
                }
            }
            forgetJob = null
        }
        forgetJob = job
        return job
    }

    /** A touch from the host (the app came back): retries a forget that failed, and nudges the machine. Never throws for a product without Sync. */
    suspend fun touch() {
        withContext(dispatcher) {
            if (!core.enabled(ServiceSlug.sync)) return@withContext
            attach()
            if (forgetPending) startForget()
            startedHost()?.kick()
        }
    }

    /** Wait for a forget the machine's events started. */
    private suspend fun settle() {
        forgetJob?.join()
    }

    // ── the config port ──────────────────────────────────────────────────────────────────────────

    private suspend fun activeHost(): CloudSyncHost? = withContext(dispatcher) { startedHost()?.takeIf { subject != null } }

    private inner class Port : ConfigSyncPort {
        override suspend fun active(): Boolean = activeHost() != null

        override suspend fun set(key: String, value: JsonElement): CallResult {
            val h = activeHost() ?: return CallResult.Failed("signed-out")
            // A document that changed since the machine was built is routed first (A-6).
            h.refreshDocumentIfChanged()
            val r = h.withMachine { it.set(key, value) }
            // One pump reports the edit's events (nothing is due before the debounce); the call does not wait for it.
            h.kick()
            return r
        }

        override suspend fun clear(key: String): CallResult {
            val h = activeHost() ?: return CallResult.Failed("signed-out")
            h.refreshDocumentIfChanged()
            val r = h.withMachine { it.clear(key) }
            h.kick()
            return r
        }

        override suspend fun get(key: String): ReadResult? = activeHost()?.withMachine { it.get(key) }

        override suspend fun state(key: String): SettingSyncState {
            val h = activeHost() ?: return SettingSyncState.local
            val sync = h.withMachine { it.settingState(key).sync }
            return SettingSyncState.entries.firstOrNull { it.name == sync } ?: SettingSyncState.local
        }
    }
}

/** The client's own wiring of a host: its transport, state directory, discovery document and key ring. */
internal fun liveCloudSyncDeps(
    core: CoreContext,
    keyring: SyncKeyring,
    config: ConfigClient,
    stateDir: java.io.File,
): CloudSyncHostDeps = CloudSyncHostDeps(
    core.product,
    stateDir,
    { req -> CloudSyncTransport.send(core, req) },
    keyring.codec,
    { config.syncDocument() },
).also { d ->
    d.keyringUnlocked = { keyring.unlocked }
    d.attachKeyring = { keyring.attach(it) }
    d.syncEnabled = { core.enabled(ServiceSlug.sync) }
    d.discovery = {
        val f = core.discoveryDocument()?.services?.get(ServiceSlug.sync)?.takeIf { it.enabled }
        val said = (f?.extras?.get("encryption") as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        f?.let { SyncDiscovery(said?.takeIf { it == "e2e" || it == "server" }) }
    }
    d.fetchSchema = { config.schemaJson() }
    d.subject = { core.storedSubject() }
}

/** A state directory for a store without one (memory): private to the process, removed on exit. */
internal fun privateTempDir(): java.io.File {
    val dir = java.nio.file.Files.createTempDirectory("pkey-sync-").toFile()
    dir.deleteOnExit()
    return dir
}
