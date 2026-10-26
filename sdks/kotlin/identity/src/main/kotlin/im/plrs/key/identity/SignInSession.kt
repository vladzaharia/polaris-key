// `identity.signIn.start(options)` and the `SignInSession` it returns (SDK identity v2, I-10b.17).
//
//   val session = client.identity.signIn.start(SignInOptions(deviceName = "Deck"))
//   show(session.userCode, session.verificationUriComplete)   // the code, the page, the QR
//   when (val outcome = session.wait()) { ... }               // the paced poll, until it settles
//
// `start` is one request (`POST /<p>/identity/auth/device/start`); `wait()` is the paced device-code
// poll, or with `once = true` exactly one probe poll with no pause (the answer may be `Pending`). A refusal
// of the sign-in (the player pressed Deny, the provider failed) is a typed [SignInError]; an expired
// code, a cancelled session and a signed-in device are outcomes. A product that does not run
// Identity answers `PolarisException(service-unavailable)` before any request. A device-code sign-in
// yields the signed-in identity's OWN licence and nothing else. Java callers: `PolarisKeyFutures`.

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

/** How the player signs in. Only the device code today; the redirect channel is I-10b.18. */
public enum class SignInChannel { DeviceCode }

/** What `signIn.start` takes. */
public data class SignInOptions @JvmOverloads constructor(
    val channel: SignInChannel = SignInChannel.DeviceCode,
    /** The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1); null sends the default. */
    val deviceName: String? = null,
    /** Show the verification page through this as soon as the session starts; null shows nothing (the host draws the code, or calls `reopen()`). */
    val opener: AccountOpener? = null,
)

/** Where a session stands. `wait()` returns the settled ones; `session.outcome` reads `Pending` until then. */
public sealed interface SignInOutcome {
    /** `pending`, `signedIn`, `cancelled` or `expired`. */
    public val kind: String

    /** Not finished: wait [interval] seconds before the next poll ([slowDown]: the Worker asked for a longer one). Only `wait(once = true)` answers it. */
    public data class Pending(val interval: Long, val slowDown: Boolean = false) : SignInOutcome {
        override val kind: String get() = "pending"
    }

    /** Signed in: the device token is stored and the post-acquisition sync has run. [subject] is the pairwise subject the Worker reported, if it did. */
    public data class SignedIn(val subject: String? = null) : SignInOutcome {
        override val kind: String get() = "signedIn"
    }

    public data object Cancelled : SignInOutcome {
        override val kind: String get() = "cancelled"
    }

    public data object Expired : SignInOutcome {
        override val kind: String get() = "expired"
    }
}

/**
 * A sign-in the Worker refused or that failed: [code] is `sign-in-denied` (the player pressed Deny),
 * `sign-in-failed` (it failed after approval) or the Worker's own code.
 */
public class SignInError(public val code: String, message: String) : Exception(message) {
    override fun toString(): String = "SignInError($code): $message"
}

/** `client.identity.signIn`. */
public class SignInNamespace internal constructor(private val client: IdentityClient) {
    /**
     * Ask for a device code and return its session. Throws `PolarisException` (`service-unavailable`
     * when the product runs no Identity, `sign-in-unavailable`, `network-error`, ...). With
     * [SignInOptions.opener] the page is shown before this returns.
     */
    public suspend fun start(options: SignInOptions = SignInOptions()): SignInSession {
        val prompt = client.startDeviceCode(options.deviceName)
        val session = SignInSession(client, prompt, options.opener)
        if (options.opener != null) session.reopen()
        return session
    }
}

/** One device-code sign-in: the code to show, and the wait that settles it. */
public class SignInSession internal constructor(
    private val client: IdentityClient,
    /** The code, the URIs and the clock the host shows. */
    public val prompt: SignInPrompt,
    private val opener: AccountOpener?,
) {
    private val lock = Any()
    private var cancelled = false
    private var running: Deferred<SignInPoll>? = null
    private var settled: Result<SignInOutcome>? = null
    private var pace: Long = prompt.interval

    /** What the player types on the verification page, e.g. `WDJB-MJHT`. */
    public val userCode: String get() = prompt.userCode

    /** The page the player opens and types the code into. */
    public val verificationUri: String get() = prompt.verificationUri

    /** The same page with the code pre-filled: the payload for a QR code or a link. */
    public val verificationUriComplete: String get() = prompt.verificationUriComplete

    /** Seconds the code lives for, as the server advertised it. */
    public val expiresIn: Long get() = prompt.expiresIn

    /** The minimum seconds between polls, as the server advertised it. */
    public val interval: Long get() = prompt.interval

    /** When the code expires on this client's clock (epoch seconds). */
    public val expiresAt: Long get() = prompt.expiresAt

    /** The label the sign-in page shows: the Worker's echo, else the label sent. */
    public val deviceName: String? get() = prompt.deviceName

    /** `Pending` until the session settles. */
    public val outcome: SignInOutcome
        get() = synchronized(lock) {
            settled?.getOrNull() ?: if (cancelled) SignInOutcome.Cancelled else SignInOutcome.Pending(pace)
        }

    /** Show the verification page again, through the opener given to `start` or the client's. False when no opener could open it. */
    public suspend fun reopen(): Boolean {
        val open = opener ?: client.opener ?: return false
        return try {
            open.open(prompt.verificationUriComplete)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
    }

    /** Stop the sign-in: the paced poll ends, `wait()` returns `Cancelled`, nothing binds. */
    public fun cancel() {
        val job = synchronized(lock) {
            if (settled != null || cancelled) return
            cancelled = true
            running
        }
        job?.cancel()
    }

    /**
     * Poll until the sign-in settles. With [once] one poll with no leading pause: the answer is
     * `Pending` while the person is still at it. Throws [SignInError] when it was refused or failed,
     * and CancellationException when the calling coroutine is cancelled (the session keeps going;
     * call [cancel] to end it). A settled session answers the same outcome again.
     */
    public suspend fun wait(once: Boolean = false): SignInOutcome {
        synchronized(lock) {
            // `once` is a probe: it asks the Worker again even after a refusal.
            if (!once) settled?.let { return it.getOrThrow() }
            if (cancelled) return SignInOutcome.Cancelled
        }
        val ended: SignInPoll = try {
            coroutineScope {
                val job = async {
                    if (once) client.pollDeviceCode(prompt, synchronized(lock) { pace }) else client.waitDeviceCode(prompt)
                }
                synchronized(lock) { running = job }
                // `cancel()` raced in before `running` was set.
                if (synchronized(lock) { cancelled }) job.cancel()
                try {
                    job.await()
                } finally {
                    synchronized(lock) { if (running === job) running = null }
                }
            }
        } catch (e: CancellationException) {
            if (synchronized(lock) { cancelled } && coroutineContext.isActive) return settle(Result.success(SignInOutcome.Cancelled))
            throw e
        }
        return when (ended) {
            SignInPoll.Pending -> SignInOutcome.Pending(synchronized(lock) { pace })
            is SignInPoll.SlowDown -> SignInOutcome.Pending(
                synchronized(lock) { pace = maxOf(pace, ended.interval); pace }, slowDown = true,
            )
            is SignInPoll.Ready -> settle(Result.success(SignInOutcome.SignedIn(ended.subject)))
            SignInPoll.Expired -> settle(Result.success(SignInOutcome.Expired))
            is SignInPoll.Error -> {
                val error = SignInError(ended.code ?: ErrorCode.signInFailed, ended.message)
                if (once) throw error
                settle(Result.failure(error))
            }
        }
    }

    private fun settle(result: Result<SignInOutcome>): SignInOutcome {
        val kept = synchronized(lock) {
            if (settled == null) settled = result
            settled!!
        }
        return kept.getOrThrow()
    }
}
