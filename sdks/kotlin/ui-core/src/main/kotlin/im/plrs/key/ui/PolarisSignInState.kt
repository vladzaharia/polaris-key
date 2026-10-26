// The Compose-free RFC 8628 device-code state holder. Android, desktop and custom renderers share
// its lifecycle: a leaving screen pauses polling without discarding the code, while cancellation
// and restart always obtain a fresh code.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.identity.SignInSession
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Where the sign-in flow is. */
public sealed interface PolarisSignInUi {
    /** Asking the server for a code. */
    public data object Starting : PolarisSignInUi

    /** A code to show; [nowSeconds] ticks for the countdown. */
    public data class Showing(val prompt: SignInPrompt, val nowSeconds: Long) : PolarisSignInUi {
        /** Seconds left before the code expires. */
        public val secondsLeft: Long get() = (prompt.expiresAt - nowSeconds).coerceAtLeast(0)

        /** The fraction of the code's life left, 1 → 0. */
        public val fractionLeft: Float
            get() = if (prompt.expiresIn <= 0) 0f else (secondsLeft.toFloat() / prompt.expiresIn).coerceIn(0f, 1f)
    }

    public data object Done : PolarisSignInUi
    public data object Expired : PolarisSignInUi
    public data object Failed : PolarisSignInUi

    /** The person pressed Deny, or the provider failed: the Worker's one generic `error` answer. */
    public data object Denied : PolarisSignInUi
}

/** The SDK calls sign-in makes. [PolarisKeyClient.signInActions] adapts the umbrella client. */
public interface PolarisSignInActions {
    public suspend fun begin(): SignInPrompt
    public suspend fun wait(prompt: SignInPrompt): SignInResult
}

/** The umbrella client's identity service as sign-in actions: one [SignInSession] per `begin`, waited by its prompt. */
public fun PolarisKeyClient.signInActions(deviceName: String? = null): PolarisSignInActions {
    val identity = this.identity
    val sessions = java.util.concurrent.ConcurrentHashMap<SignInPrompt, SignInSession>()
    return object : PolarisSignInActions {
        override suspend fun begin(): SignInPrompt {
            val session = identity.signIn.start(im.plrs.key.identity.SignInOptions(deviceName = deviceName))
            sessions[session.prompt] = session
            return session.prompt
        }

        override suspend fun wait(prompt: SignInPrompt): SignInResult {
            val session = sessions[prompt] ?: return SignInResult.Error("no sign-in session for this code.")
            // A paused screen cancels this coroutine and waits again on the same prompt, so the session stays until it settles.
            return try {
                val outcome = session.wait()
                sessions.remove(prompt)
                when (outcome) {
                    is SignInOutcome.SignedIn -> SignInResult.Ready
                    SignInOutcome.Expired, SignInOutcome.Cancelled -> SignInResult.Expired
                    is SignInOutcome.Pending, is SignInOutcome.Choose -> SignInResult.Error("sign-in did not settle.")
                }
            } catch (e: SignInError) {
                sessions.remove(prompt)
                SignInResult.Error(e.message ?: "", e.code)
            }
        }
    }
}

/**
 * The sign-in state holder. [start] asks for a code, shows it and waits for the person. Hold it
 * where it outlives a renderer so a rotation or navigation return resumes the same code.
 */
public class PolarisSignInState(
    private val actions: PolarisSignInActions,
    private val scope: CoroutineScope,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
    /** Called once when sign-in completes (the SDK has already synced). */
    private val onSignedIn: () -> Unit = {},
) {
    private val _ui = MutableStateFlow<PolarisSignInUi>(PolarisSignInUi.Starting)
    public val ui: StateFlow<PolarisSignInUi> = _ui.asStateFlow()
    private var job: Job? = null

    /** The code being followed, so a re-shown screen polls it again. */
    private var prompt: SignInPrompt? = null

    /** The countdown ran out on screen while the poll still ran: a late success still completes. */
    private var expiredOnScreen = false

    /**
     * Begin once. The first call obtains a code; after a renderer paused the state, it resumes the
     * same code. A completed, expired or failed flow starts a new sign-in.
     */
    public fun start() {
        if (job?.isActive == true) return
        val shown = prompt
        val now = _ui.value
        val ended = !expiredOnScreen && (now == PolarisSignInUi.Done || now == PolarisSignInUi.Expired || now == PolarisSignInUi.Failed || now == PolarisSignInUi.Denied)
        when {
            _ui.value == PolarisSignInUi.Starting || ended -> begin()
            shown != null && (_ui.value is PolarisSignInUi.Showing || expiredOnScreen) -> job = scope.launch { follow(shown) }
        }
    }

    /** Drop the current code and ask for a new one ("Get a new code" / "Try again"). */
    public fun restart() {
        job?.cancel()
        prompt = null
        expiredOnScreen = false
        begin()
    }

    /** Stop polling because the person cancelled; a later [start] always requests a new code. */
    public fun cancel() {
        job?.cancel()
        job = null
        prompt = null
        expiredOnScreen = false
        _ui.value = PolarisSignInUi.Starting
    }

    /** Stop polling while the screen is away; [start] resumes the same code and countdown. */
    public fun pause() {
        job?.cancel()
        job = null
    }

    private fun begin() {
        _ui.value = PolarisSignInUi.Starting
        job = scope.launch {
            val shown = try {
                actions.begin()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.value = PolarisSignInUi.Failed
                return@launch
            }
            prompt = shown
            _ui.value = PolarisSignInUi.Showing(shown, clock())
            follow(shown)
        }
    }

    /** The countdown and poll for [shown]; screen expiry leaves the poll running for a late success. */
    private suspend fun follow(shown: SignInPrompt): Unit = coroutineScope {
        fun tick() {
            val now = clock()
            val current = _ui.value
            if (current !is PolarisSignInUi.Showing) return
            if (shown.expiresAt - now <= 0) {
                expiredOnScreen = true
                _ui.value = PolarisSignInUi.Expired
            } else {
                _ui.value = current.copy(nowSeconds = now)
            }
        }
        tick()
        val ticker = launch {
            while (isActive) {
                delay(1_000)
                tick()
            }
        }
        val result = try {
            actions.wait(shown)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            SignInResult.Error(e.message ?: "")
        }
        ticker.cancel()
        prompt = null
        expiredOnScreen = false
        _ui.value = when (result) {
            SignInResult.Ready -> PolarisSignInUi.Done
            SignInResult.Expired -> PolarisSignInUi.Expired
            is SignInResult.Error -> if (result.code == ErrorCode.signInDenied) PolarisSignInUi.Denied else PolarisSignInUi.Failed
        }
        if (result == SignInResult.Ready) onSignedIn()
    }
}
