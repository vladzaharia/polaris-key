// `identity.signIn.startNearby(options)` (I-45.12; WIRE-CONTRACT-V5 section 12.11.5, 15.6.1): the new device D signs in
// because a signed-in device M nearby approves it. The session joins the two halves: the HTTP routes (NearbyRoutes.kt:
// `start`, `poll`) and the LAN request CC-15 built (`cloudConnect.nearby.request`: the approvers D lists, the code D
// shows, `VOUCH_REQ`). Mirrors sdk-node's `identity/nearbySession.ts`, with the fixes the Python port carries.
//
//   approvers / onApprovers(fn)  who answered nearby: id, label (cleaned), platform
//   choose(id)                   the person tapped one; answers the code to show (`482 913`)
//   code                         the code on screen once chosen
//   result / onResult(fn)        what `VOUCH_RESULT` said. Display only
//   wait(once)                   the paced poll: SignedIn, Expired or Cancelled (Pending with `once`); a refusal throws
//                                `SignInError(sign-in-denied)`
//   confirmAccount()             the person saw the signed-in account and says it is theirs
//   declineAccount()             it is not: the wrap is dropped and the device signs out
//   cancel()                     stop; the LAN request closes
//   ended / onEnd(fn)            the sign-in ended unconfirmed (decline, cancel, the screen deadline): the device is
//                                signed out and holds no token
//
// Rules this file keeps:
//  - the order is `start`, then the LAN request, and the poll is paced from `start`: the first poll is one interval
//    after it. The poll decides the outcome: a token is SignedIn, `timeout` is Expired, `access_denied` throws.
//    `VOUCH_RESULT` never signs anyone in and never ends the wait;
//  - one answer: a token comes once, so the first terminal outcome (or error) is kept and every later `wait()` gets
//    the same one;
//  - the LAN half stays open after SignedIn so a Sync record can still arrive (the wrap), until the person confirms or
//    declines, the request expires (300 s) or `cancel()`. `NearbyRequest.onClose` is deliberately NOT an end: the
//    approver closing the LAN session after `approved` leaves the sign-in awaiting the person (rule 8);
//  - unconfirmed until `confirmAccount()` (rule 12): the token is held under the unconfirmed mark. A decline, a
//    `cancel()` or the `expiresIn`-second screen deadline (a monotonic timer, from the moment the poll answered) ends
//    the sign-in: one idempotent, serialized discard zeroes and drops the wrap, declines and closes the LAN request,
//    asks the Worker to sign out (best effort), and removes the token, its mark and the identity locally whatever the
//    Worker answered. A `ready` poll that lands after such an end discards at once. The stored subject, the `signedIn`
//    event (and so Sync and Connect) wait for `confirmAccount()`;
//  - confirming and ending are one decision under one lock: whichever takes it first wins; the deadline of an
//    abandoned session acts only on its own token and leaves a later sign-in alone;
//  - the request handle, the proofs, the token, the code and the wrap are in no `toString`, log or error message.

@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "ThrowsCount", "ReturnCount", "CyclomaticComplexMethod", "TooManyFunctions")

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.boolValue
import im.plrs.key.core.cleanDisplayLabel
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverInfo
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyRecord
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/** What `signIn.startNearby` takes. */
public data class NearbySignInOptions @JvmOverloads constructor(
    /** The device label the approver is shown (section 12.7.1 and `HELLO`), else the client's default. */
    val deviceName: String? = null,
)

/** One approver D can pick. Display data from an unverified peer: any device on the network can list itself under any label. */
public data class NearbyApprover(val id: String, val label: String?, val platform: String) {
    override fun toString(): String = "NearbyApprover($id)"
}

/** The code on screen (`482 913`); `toString` prints it, because the screen must show it. */
public class NearbyCode(public val code: String) {
    override fun toString(): String = code
}

/** What became of the `KEYRING_WRAP` the approver sent over the LAN. */
public enum class NearbyWrapState { None, Applied, Refused }

private const val KEYRING_WRAP = 0x0030
private const val MAX_RETRY_SECONDS = 60L

/** The lifetime and the interval every recording of `nearby/start` carries (V5 section 12.11.5). */
private const val REPLAY_EXPIRES_SECONDS = 300L
private const val REPLAY_INTERVAL_SECONDS = 3L
private const val MILLIS = 1000L

/** A running nearby sign-in on D (see the file comment). */
public class NearbySignInSession internal constructor(
    private val client: IdentityClient,
    private val started: NearbyStarted,
    private val req: NearbyRequest,
    label: String?,
    private val wrapAdopter: NearbyWrapAdopter?,
) {
    private val core: CoreContext get() = client.core
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Seconds the request lives, as the Worker said (300). */
    public val expiresIn: Long = started.expiresIn

    /** The minimum seconds between polls; a `slow_down` lengthens it. */
    @Volatile public var interval: Long = started.interval
        private set

    /** When the request lapses on THIS client's clock (epoch seconds). */
    public val expiresAt: Long = client.core.flooredNow() + started.expiresIn

    /** The label D sent, or null. */
    public val deviceName: String? = label

    public val channel: String get() = "nearby"

    // One decision lock: the end and the confirmation cannot both win, and the deadline cannot act on a confirmed session.
    private val lock = Any()
    private var cancelled = false
    private var final: Result<SignInOutcome>? = null
    private var signedIn = false
    private var confirming = false
    private var confirmed = false
    private var endedFlag = false
    private var token: String? = null
    private var subject: String? = null
    private var shown: ShownIdentity? = null
    private var held: ByteArray? = null
    private var wrapNow = NearbyWrapState.None
    private var deadline: (() -> Unit)? = null
    private var lanOpen = true
    private var notBeforeMillis: Long = nowMillis() + started.interval * MILLIS
    private var chosen: NearbyCode? = null

    private val abort = CompletableDeferred<Unit>()
    private val waitLock = Mutex()
    private val discardLock = Mutex()
    private val applyLock = Mutex()
    private val onEndFns = CopyOnWriteArrayList<() -> Unit>()
    private val onWrapFns = CopyOnWriteArrayList<(NearbyWrapState) -> Unit>()
    private val offRecord: () -> Unit = req.onRecord { r -> onRecord(r) }

    override fun toString(): String =
        "NearbySignInSession(channel=nearby, expiresIn=$expiresIn, interval=$interval, expiresAt=$expiresAt, deviceName=$deviceName)"

    // ── What the person sees ─────────────────────────────────────────────────────────────────

    /** The approvers that answered, at most 8, labels cleaned. */
    public val approvers: List<NearbyApprover> get() = req.approvers.map(::clean)

    /** Called with the list whenever it changes. Returns the remover. */
    public fun onApprovers(fn: (List<NearbyApprover>) -> Unit): () -> Unit = req.onApprovers { l -> fn(l.map(::clean)) }

    /** The code on screen once an approver is chosen, else null. */
    public val code: NearbyCode? get() = synchronized(lock) { chosen }

    /** What `VOUCH_RESULT` said, for display only: the poll is the authority. */
    public val result: VouchStatus? get() = req.result

    public fun onResult(fn: (VouchStatus) -> Unit): () -> Unit = req.onResult(fn)

    /** The account the poll showed (name, email), once it signed in; for the confirm screen. */
    public val identity: ShownIdentity? get() = synchronized(lock) { shown }

    /** The person tapped this approver. Answers the code to show; the request goes out once it is shown. */
    public suspend fun choose(id: String): NearbyCode {
        val over = synchronized(lock) { final != null || cancelled }
        if (over) throw PolarisException(ErrorCode.signInFailed, "The sign-in is over.")
        val c = NearbyCode(req.choose(id).code)
        synchronized(lock) { chosen = c }
        return c
    }

    // ── Ending ───────────────────────────────────────────────────────────────────────────────

    /** True once the sign-in ended unconfirmed (a decline, a cancel, the screen deadline). */
    public val ended: Boolean get() = synchronized(lock) { endedFlag }

    /** Called once when the sign-in ends unconfirmed, so a screen can leave; called at once when it already ended. Returns the remover. */
    public fun onEnd(fn: () -> Unit): () -> Unit {
        val now = synchronized(lock) {
            if (!endedFlag) onEndFns.add(fn)
            endedFlag
        }
        if (now) {
            guarded(fn)
            return {}
        }
        return { onEndFns.remove(fn) }
    }

    /**
     * Stop. A running `wait()` answers Cancelled; the request simply lapses on the Worker. After SignedIn and before
     * the confirmation it also signs the device out (D-21). Leaving the confirm screen by any route is this.
     */
    public fun cancel() {
        val ended = halt()
        scope.launch {
            closeLan()
            if (ended && synchronized(lock) { signedIn }) discard()
        }
    }

    /**
     * The end of this sign-in: no further poll is honoured, the deadline stops and listeners hear of it (once, and
     * only while unconfirmed). True when THIS call ended it: a confirmation that began first wins.
     */
    private fun halt(): Boolean {
        val stop: (() -> Unit)?
        val fns: List<() -> Unit>
        val won: Boolean
        synchronized(lock) {
            cancelled = true
            stop = deadline
            deadline = null
            if (endedFlag || confirming) {
                won = false
                fns = emptyList()
            } else {
                endedFlag = true
                won = true
                fns = onEndFns.toList()
                onEndFns.clear()
            }
        }
        abort.complete(Unit)
        stop?.invoke()
        fns.forEach(::guarded)
        return won
    }

    /** The confirm screen's deadline: [expiresIn] seconds from the moment the poll answered, on a monotonic timer. */
    private fun armDeadline() {
        val fire = {
            // Discard only when this call ended the sign-in: a confirm that won the lock first stands.
            if (halt()) scope.launch { discard() }
            Unit
        }
        val timer = client.nearbyTimer
        val stop: () -> Unit = if (timer != null) {
            timer(expiresIn.toDouble(), fire)
        } else {
            val job: Job = scope.launch {
                delay(expiresIn * MILLIS)
                fire()
            }
            ({ job.cancel() })
        }
        val late = synchronized(lock) {
            if (cancelled) {
                true
            } else {
                deadline = stop
                false
            }
        }
        if (late) stop()
    }

    /**
     * The one end path for an unconfirmed sign-in; idempotent and serialized. The held wrap is zeroed and dropped, the
     * LAN request declines and closes, the Worker is asked to sign out as a best effort, and whatever it answered the
     * token, its mark and the stored identity go. It acts only on this session's own token.
     */
    private suspend fun discard() = discardLock.withLock {
        synchronized(lock) {
            held?.fill(0)
            held = null
        }
        try {
            req.declineAccount()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The chosen session is gone.
        }
        closeLan()
        val own: String? = synchronized(lock) {
            if (!signedIn) return@withLock
            token.also { token = null }
        }
        val holds = own != null && core.token() == own
        if (!holds) {
            // Another sign-in holds the device now: this session ends without touching it.
            synchronized(lock) { signedIn = false }
            return@withLock
        }
        try {
            client.signOut()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The Worker could not be asked: the device still drops the token below.
        }
        try {
            core.dropHeldToken(own!!)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A token that cannot be removed keeps its mark: the next start drops it.
        }
        synchronized(lock) {
            signedIn = false
            shown = null
        }
    }

    // ── The poll ─────────────────────────────────────────────────────────────────────────────

    /**
     * Poll until the sign-in settles. `once = true` polls exactly once (no leading pause) and may answer Pending;
     * otherwise it is the paced loop. The first terminal answer is kept: a later call gets the same one (the token is
     * handed over once). Throws [SignInError] (`sign-in-denied`) when M refused, `service-unavailable` when the routes
     * went away, and the taxonomy's error for a failure that is not transient.
     */
    public suspend fun wait(once: Boolean = false): SignInOutcome = waitLock.withLock { runWait(once) }

    private suspend fun runWait(once: Boolean): SignInOutcome {
        while (true) {
            synchronized(lock) { final }?.let { return it.getOrThrow() }
            if (!once) {
                pace()?.let { return it }
            } else if (synchronized(lock) { cancelled }) {
                return SignInOutcome.Cancelled
            }
            val p = try {
                client.nearbyRoutes.poll(started)
            } catch (e: PolarisException) {
                if (!once && (e.code == ErrorCode.networkError || e.code == ErrorCode.serverError)) {
                    // Ride out a transient failure at the current interval, or the Worker's Retry-After.
                    val retry = minOf((e.retryAfterSeconds ?: 0).toLong(), MAX_RETRY_SECONDS)
                    notBeforeMillis = nowMillis() + maxOf(interval, retry) * MILLIS
                    continue
                }
                throw e
            }
            notBeforeMillis = nowMillis() + interval * MILLIS
            if (p is NearbyPoll.Ready) {
                // The routes stored the token (unconfirmed). A decline or cancel that got in before this answer
                // discards it at once; nothing is handed to the caller (D-21).
                val late = synchronized(lock) {
                    signedIn = true
                    subject = p.subject
                    token = p.token
                    shown = p.identity
                    cancelled
                }
                if (late) {
                    discard()
                    return SignInOutcome.Cancelled
                }
                armDeadline()
            } else if (synchronized(lock) { cancelled }) {
                return SignInOutcome.Cancelled
            }
            when (p) {
                is NearbyPoll.Ready -> return end(SignInOutcome.SignedIn(p.subject, p.scope, p.licenseId))

                NearbyPoll.Timeout -> return end(SignInOutcome.Expired)

                NearbyPoll.Denied -> fail(SignInError(ErrorCode.signInDenied, "nearby sign-in was refused."))

                NearbyPoll.Unavailable -> fail(
                    PolarisException(
                        ErrorCode.serviceUnavailable,
                        "this product no longer serves nearby sign-in.",
                        unsupported = Unsupported(Feature.identityNearby, UnsupportedReason.product, "this product no longer serves nearby sign-in."),
                    ),
                )

                is NearbyPoll.SlowDown -> {
                    interval = maxOf(interval, p.interval)
                    notBeforeMillis = nowMillis() + interval * MILLIS
                    if (once) return SignInOutcome.Pending(interval, slowDown = true)
                }

                NearbyPoll.Pending -> if (once) return SignInOutcome.Pending(interval)
            }
        }
    }

    private fun nowMillis(): Long = System.nanoTime() / NANOS_PER_MILLI

    /** The outcome that ends the session before a poll (cancelled, lapsed), else null. */
    private fun over(): SignInOutcome? {
        if (synchronized(lock) { cancelled }) return SignInOutcome.Cancelled
        return if (core.flooredNow() >= expiresAt) end(SignInOutcome.Expired) else null
    }

    /** Wait out the interval, which runs from `start` (a `wait()` called late polls at once). */
    private suspend fun pace(): SignInOutcome? {
        over()?.let { return it }
        val lead = maxOf(0L, notBeforeMillis - nowMillis())
        val seconds = minOf((lead + MILLIS - 1) / MILLIS, expiresIn)
        if (seconds > 0) {
            coroutineScope {
                val sleeper = launch { client.sleep(seconds) }
                val watcher = launch {
                    abort.await()
                    sleeper.cancel()
                }
                sleeper.join()
                watcher.cancel()
            }
        }
        return over()
    }

    /** Keep a terminal outcome; everything but a sign-in closes the LAN half now. */
    private fun end(o: SignInOutcome): SignInOutcome {
        val kept = synchronized(lock) {
            if (final == null) final = Result.success(o)
            final!!
        }
        if (o !is SignInOutcome.SignedIn) scope.launch { closeLan() }
        return kept.getOrThrow()
    }

    private fun fail(e: Exception): Nothing {
        synchronized(lock) { if (final == null) final = Result.failure(e) }
        scope.launch { closeLan() }
        throw e
    }

    private suspend fun closeLan() {
        val first = synchronized(lock) {
            val was = lanOpen
            lanOpen = false
            was
        }
        if (!first) return
        offRecord()
        try {
            req.close()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failure to close is not an error.
        }
    }

    // ── After the sign-in ────────────────────────────────────────────────────────────────────

    /** What became of the wrap the approver sent: None until one arrives and is taken (or refused). */
    public val wrap: NearbyWrapState get() = synchronized(lock) { wrapNow }

    /** Called with the wrap state each time it changes (not on the LAN thread; a failure inside [fn] is swallowed). Returns the remover. */
    public fun onWrap(fn: (NearbyWrapState) -> Unit): () -> Unit {
        onWrapFns.add(fn)
        return { onWrapFns.remove(fn) }
    }

    private fun onRecord(r: NearbyRecord) {
        if (r.type != KEYRING_WRAP) return
        val late = synchronized(lock) {
            held?.fill(0)
            held = r.body.copyOf()
            // The engine hands records over only after `confirmAccount()`; a wrap that comes later is taken as it arrives.
            confirmed
        }
        if (late) scope.launch { applyWrap() }
    }

    /** Open the held wrap once through the adopter, never throwing into the LAN callback. */
    private suspend fun applyWrap() = applyLock.withLock {
        val body = synchronized(lock) { held.also { held = null } } ?: return@withLock
        val adopter = wrapAdopter
        // No key ring here: the wrap is dropped, and the normal `unlock()` works later.
        if (adopter == null) {
            body.fill(0)
            return@withLock
        }
        var state = NearbyWrapState.Refused
        try {
            if (adopter.adopt(body)) state = NearbyWrapState.Applied
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The ring refused or the Worker could not be asked: the device stays locked.
        } finally {
            body.fill(0)
        }
        synchronized(lock) { wrapNow = state }
        onWrapFns.toList().forEach { f -> guarded { f(state) } }
        // Nothing else is expected on the channel once the wrap is in.
        if (state == NearbyWrapState.Applied) closeLan()
    }

    /**
     * The person has seen the signed-in account and says it is theirs (rule 12). Only now does the engine hand over
     * the records M sent, the stored subject is written and the `signedIn` event goes out. Throws when the device is not
     * signed in, or when the sign-in ended first. A failure here leaves the sign-in unconfirmed and retryable.
     */
    public suspend fun confirmAccount() {
        val (tok, subj, first) = synchronized(lock) {
            if (endedFlag) throw PolarisException(ErrorCode.signInFailed, "The sign-in ended before it was confirmed.")
            val s = subject
            if (!signedIn || s == null) throw PolarisException(ErrorCode.signInFailed, "Nothing to confirm: the device is not signed in.")
            Triple(token, s, !confirming)
        }
        if (first) {
            val held = tok != null && core.token() == tok
            val stale = synchronized(lock) {
                // One decision under the lock: the end and the confirmation cannot both win.
                if (endedFlag) throw PolarisException(ErrorCode.signInFailed, "The sign-in ended before it was confirmed.")
                if (!held) {
                    true
                } else {
                    confirming = true
                    false
                }
            }
            if (stale) {
                // A later sign-in replaced this one's token: nothing of it is written, nothing signed out.
                if (halt()) discard()
                throw PolarisException(ErrorCode.signInFailed, "The sign-in ended before it was confirmed.")
            }
            val stop = synchronized(lock) { deadline.also { deadline = null } }
            stop?.invoke()
            val ok = try {
                core.confirmUnconfirmedToken(tok!!, subj)
            } catch (e: Throwable) {
                synchronized(lock) { confirming = false }
                throw e
            }
            if (!ok) {
                synchronized(lock) { confirming = false }
                if (halt()) discard()
                throw PolarisException(ErrorCode.signInFailed, "The sign-in ended before it was confirmed.")
            }
            // The person is signed in now: Cloud Sync and Connect hear of it, and the restore key is enrolled.
            client.onSubject(subj)
            try {
                client.afterSignIn()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Best effort, as after every sign-in.
            }
        }
        try {
            // The engine hands over the records it held before this returns.
            req.confirmAccount()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The chosen session is gone: no records, the server copy is the fallback.
        }
        synchronized(lock) { confirmed = true }
        applyWrap()
    }

    /**
     * The account is not the person's: every held record is dropped, the LAN half closes and the device signs out
     * (rule 12). Safe to call more than once.
     */
    public suspend fun declineAccount() {
        halt()
        discard()
    }

    private fun clean(a: NearbyApproverInfo): NearbyApprover = NearbyApprover(a.id, a.label?.let { cleanDisplayLabel(it) }, a.platform)

    private companion object {
        const val NANOS_PER_MILLI = 1_000_000L
    }
}

private inline fun guarded(fn: () -> Unit) {
    try {
        fn()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // A listener never stops the session.
    }
}

/**
 * Begin a nearby sign-in. The Worker request first (`nearby/start`), then the LAN request with the handle it
 * answered. Throws the typed N/A when the product serves no nearby approval, and `nearby-unsupported` when this
 * runtime cannot browse the network (checked before any request).
 */
internal suspend fun IdentityClient.startNearbySignIn(options: NearbySignInOptions): NearbySignInSession {
    val host = nearbyHost.get() ?: throw PolarisException(
        ErrorCode.nearbyUnsupported,
        "Nearby approval is not set up on this client.",
        unsupported = Unsupported(Feature.identityNearby, UnsupportedReason.runtime, "This client has no local-network adapter."),
    )
    // An unsupported runtime never calls a route for it (section 15.6.1 rule 10): checked before `nearby/start`.
    if (!host.runtime(NearbyRole.Requester)) {
        throw PolarisException(
            ErrorCode.nearbyUnsupported,
            "Nearby approval is not available here.",
            detail = "This runtime cannot discover devices on the network.",
            unsupported = Unsupported(Feature.identityNearby, UnsupportedReason.runtime, "This runtime cannot discover devices on the network."),
        )
    }
    val started = nearbyRoutes.start(options.deviceName)
    val label = core.deviceLabel(options.deviceName)?.takeIf { it.isNotEmpty() }
    val req = host.request(NearbyRequestOptions(request = started.request, label = label, expiresIn = started.expiresIn.toDouble()))
    return NearbySignInSession(this, started, req, label, host.wrap)
}

/** `identity.nearby`: whether nearby sign-in can run on this device. */
public class NearbyNamespace internal constructor(private val client: IdentityClient) {
    /**
     * Identity is on, discovery names `nearby` and the role's endpoints, and this runtime can discover devices (CC-15
     * does not answer `nearby-unsupported`). It sends nothing but the discovery read, and never throws: any doubt is false.
     */
    public suspend fun available(role: NearbyRole = NearbyRole.Requester): Boolean = try {
        client.nearbyAvailable(role)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        false
    }

    /**
     * M, a signed-in device: advertise while the person has "Approve a nearby device" open ([NearbyApproverOptions.prompt])
     * or has allowed background approval, and hand each session that reaches the code to [handler] as a [NearbyAsk]
     * (see NearbyApproval.kt). Returns the handle that stops, pauses and resumes it. Throws `account_required` when the
     * device is signed out, the typed N/A when the product serves no nearby approval and `nearby-unsupported` when this
     * runtime cannot discover devices.
     */
    public suspend fun onRequest(handler: NearbyAskHandler, options: NearbyApproverOptions): NearbyApproverHandle =
        client.startNearbyApprover(handler, options)
}

internal suspend fun IdentityClient.nearbyAvailable(role: NearbyRole): Boolean {
    val names = if (role == NearbyRole.Requester) listOf("nearbyStart", "nearbyPoll") else listOf("nearbyApprove")
    discoverIfNeeded()
    core.requireService(im.plrs.key.core.ServiceSlug.identity, Feature.identityNearby)
    val f = core.discoveryDocument()?.services?.get(im.plrs.key.core.ServiceSlug.identity) ?: return false
    if (!f.enabled || f.extras["nearby"].boolValue != true) return false
    if (names.any { f.endpoints[it].isNullOrEmpty() }) return false
    val host = nearbyHost.get() ?: return false
    return host.runtime(role)
}

/** Conformance replay only: sign the nearby proofs by another key or over another value (the `nearby-errors` recording). */
@ConformanceReplayOnly
public fun IdentityClient.replayNearbyProofs(signer: suspend (im.plrs.key.core.DeviceKeyPort, im.plrs.key.core.DeviceProofFields) -> String) {
    nearbyRoutes.signProof = NearbyProofSigner { port, fields -> signer(port, fields) }
}

/** Conformance replay only: back to signing through the key port. */
@ConformanceReplayOnly
public fun IdentityClient.replayNearbyProofsReset() {
    nearbyRoutes.signProof = null
}

/** Conformance replay only: one `nearby/start` (the deviceName per step) answered as the three facts the transcripts hold. */
@ConformanceReplayOnly
public suspend fun IdentityClient.replayNearbyStart(deviceName: String?): NearbyReplayStarted =
    nearbyRoutes.start(deviceName).let { NearbyReplayStarted(it.request, it.expiresIn, it.interval, it.signKey) }

/** The replay's handle on a started request. `request` is a secret: it prints as nothing. */
public class NearbyReplayStarted(public val request: String, public val expiresIn: Long, public val interval: Long, public val signKey: String) {
    override fun toString(): String = "NearbyReplayStarted"
}

/** Conformance replay only: one `nearby/poll`, answered as the transcripts' `result` vocabulary. */
@ConformanceReplayOnly
public suspend fun IdentityClient.replayNearbyPoll(request: String, signKey: String): NearbyReplayPoll =
    when (val p = nearbyRoutes.poll(NearbyStarted(request, REPLAY_EXPIRES_SECONDS, REPLAY_INTERVAL_SECONDS, signKey))) {
        NearbyPoll.Pending -> NearbyReplayPoll("pending")
        is NearbyPoll.SlowDown -> NearbyReplayPoll("slow-down", interval = p.interval)
        NearbyPoll.Timeout -> NearbyReplayPoll("timeout")
        NearbyPoll.Denied -> NearbyReplayPoll("error", reason = "access_denied")
        NearbyPoll.Unavailable -> NearbyReplayPoll("unavailable")
        is NearbyPoll.Ready -> NearbyReplayPoll("ready", scope = p.scope)
    }

public class NearbyReplayPoll(
    public val result: String,
    public val interval: Long? = null,
    public val reason: String? = null,
    public val scope: String? = null,
)
