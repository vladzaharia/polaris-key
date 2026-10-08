// One-call boot (`ui.boot`, notes/SDK-PARITY-PASS.md §3.4; SP-20): the host side of :core's boot
// stage machine (`ui.stages`), as plain coroutine code with no Android dependency, so the
// :conformance replayer drives it on the JVM and :ui's PolarisBootState is a thin holder over it.
//
//   shell    discovery, when the build pinned no `expectedServices` or holds no token; then, on a
//            fresh install (no token) of a product whose `core.registration` is `open`, the keyless
//            registration, so the sync pass that follows already carries the token
//            (conformance/transcripts/boot-cold-register.json)
//   guard    the app boot guard (`client.bootGuard()`, over the default slots where present)
//   sync     `client.sync()` (offline when every document the product runs failed, or it threw)
//   gate     the status; a device that needs activation under an `open` policy registers keylessly
//            and syncs again first
//   decide   `client.update.decide()` when the licence is usable (none when not configured)
//   fetch    the content stamp's required and essential packs (`client.packs.bootFetch`)
//   mount    the product's
//
// BootDriver runs the loop: `run` until the boot settles (`client.boot()`) or `launch` for the life
// of a screen (waiting at stops until a retry). A stage whose work is still running when an outside
// event moves the machine on (a host's `fail` or `sync.timeout`) is cancelled, not awaited.

package im.plrs.key.sdk

import im.plrs.key.core.BootConfirmation
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.BootState
import im.plrs.key.core.BootTransition
import im.plrs.key.core.BOOT_OK_SECONDS
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.RegistrationPolicy
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.bootConfirmation
import im.plrs.key.core.bootTransition
import im.plrs.key.core.initialBootState
import im.plrs.key.core.isUsable
import im.plrs.key.packs.BootConsentPolicy
import im.plrs.key.update.BootGuard
import im.plrs.key.update.DirUpdateSlots
import im.plrs.key.update.UpdateSlots
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext

/** What a fetch reports back while it runs. */
public interface PolarisFetchReporter {
    /** Bytes fetched so far of the total. */
    public fun progress(done: Long, total: Long)

    /** Ask the player before fetching [bytes]; true to go ahead. Suspends until they answer. */
    public suspend fun consent(bytes: Long, metered: Boolean): Boolean
}

/** Each stage's work. Every method has the do-nothing answer by default except [sync] and [gate]. */
public interface PolarisBootHost {
    public suspend fun shell() {}
    public suspend fun guard(): BootEvent.GuardResult = BootEvent.GuardResult.ok
    public suspend fun sync(): BootEvent.SyncResult
    public suspend fun gate(): LicenseStatus
    public suspend fun decide(): BootEvent.Decision = BootEvent.Decision.none

    /** Fetch what the boot needs; answers the result and the pack ids installed afterwards. */
    public suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> =
        BootEvent.FetchResult.ok to emptyList()

    public suspend fun mount() {}

    /**
     * The stage-matrix v2 confirmation once the boot settles on [outcome] (`update.bootguard`): the
     * host marks the launch healthy now, after BOOT_OK_SECONDS of `ready`, or never. Called once,
     * off the boot's own path, so a delay here holds nothing up.
     */
    public suspend fun confirm(outcome: BootOutcome) {}
}

private inline fun <T> quietly(block: () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

/** The wait before boot's attempt number [failures] + 1: 1 s doubling to a 30 s cap (SP-51). */
internal fun bootBackoffMillis(failures: Int): Long = minOf(30_000L, 1_000L shl (failures - 1).coerceIn(0, 5))

/**
 * The default update slots: `<stateDirectory>/update-slots` when the host has created it (a host that
 * stages its own payloads there), else null (an installer- or store-updated app stages nothing). It
 * looks at the disk: call it (and [bootHost], whose default guard uses it) off the main thread.
 */
public fun PolarisKeyClient.defaultUpdateSlots(): UpdateSlots? {
    val dir = core.store.stateDirectory?.let { File(it, "update-slots") } ?: return null
    return if (dir.isDirectory) DirUpdateSlots(dir) else null
}

/**
 * The umbrella client as a boot host (see the file header). Pass [fetch] or [mount] to do them
 * yourself; [registration] false never registers keylessly; each update decision goes to [onCheck],
 * so an update prompt can offer it.
 */
public fun PolarisKeyClient.bootHost(
    decide: Boolean = true,
    fetch: (suspend (PolarisFetchReporter) -> Pair<BootEvent.FetchResult, List<String>>)? = null,
    mount: (suspend () -> Unit)? = null,
    guard: BootGuard? = bootGuard(defaultUpdateSlots()),
    consent: BootConsentPolicy = BootConsentPolicy.metered,
    metered: () -> Boolean = { false },
    onCheck: ((UpdateCheck) -> Unit)? = null,
    registration: Boolean = true,
): PolarisBootHost {
    val client = this
    var lastCheck: UpdateCheck? = null

    suspend fun registrationOpen(): Boolean =
        registration && client.core.discoveryDocument()?.core?.registration == RegistrationPolicy.`open`

    // SP-51: a sync that failed or went offline is retried with exponential backoff (1 s, 2 s, 4 s,
    // up to 30 s), so a boot that keeps failing never becomes a request storm.
    var failedSyncs = 0

    return object : PolarisBootHost {
        override suspend fun shell() {
            val fresh = client.core.token() == null
            if (!client.servicesPinned || fresh) quietly { client.discover() }
            if (fresh && registrationOpen()) quietly { client.register() }
        }

        override suspend fun guard(): BootEvent.GuardResult {
            val g = guard ?: return BootEvent.GuardResult.ok
            return g.run().result
        }

        override suspend fun confirm(outcome: BootOutcome) {
            val g = guard ?: return
            // SP-50: the guard's state file is read and written on Dispatchers.IO.
            if (withContext(Dispatchers.IO) { g.confirm(outcome) } == BootConfirmation.afterOkSeconds) {
                delay(BOOT_OK_SECONDS * 1000L)
                withContext(Dispatchers.IO) { g.confirmNow() }
                // A healthy launch also confirms the running pack set (CONTENT §10 step 7).
                if (client.packs.configured) quietly { client.packs.confirm() }
            }
        }

        override suspend fun sync(): BootEvent.SyncResult {
            if (failedSyncs > 0) delay(bootBackoffMillis(failedSyncs))
            val result = quietly { client.sync() }
            val ran = result?.documents?.values?.filter { it != DocOutcome.Skipped }.orEmpty()
            val offline = result == null || (ran.isNotEmpty() && ran.all { it == DocOutcome.Error })
            failedSyncs = if (offline || result?.unauthorized == true) failedSyncs + 1 else 0
            return if (offline) BootEvent.SyncResult.offline else BootEvent.SyncResult.ok
        }

        override suspend fun gate(): LicenseStatus {
            val status = client.status().status
            if (status != LicenseStatus.needsActivation || !registrationOpen()) return status
            // Reacquire keylessly (the policy allows any device), then read the status again.
            if (quietly { client.register() } is RegisterResult.Ok) quietly { client.sync(force = true) }
            return client.status().status
        }

        override suspend fun decide(): BootEvent.Decision {
            if (!decide || !isUsable(client.status().status)) return BootEvent.Decision.none
            return try {
                val check = client.update.decide(skipVersion = withContext(Dispatchers.IO) { guard?.skipVersion })
                lastCheck = check
                onCheck?.invoke(check)
                check.boot
            } catch (e: CancellationException) {
                throw e
            } catch (e: PolarisException) {
                BootEvent.Decision.none
            }
        }

        override suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> {
            fetch?.let { return it(reporter) }
            if (!client.packs.configured) return BootEvent.FetchResult.ok to emptyList()
            val install = (lastCheck?.decision as? UpdateDecision.Packs)?.install
            val out = client.packs.bootFetch(
                send = { e -> if (e is BootEvent.FetchProgress) reporter.progress(e.done, e.total) },
                consent = consent,
                metered = metered(),
                answer = { bytes, m -> reporter.consent(bytes, m) },
                install = install,
            )
            return out.result to out.installed
        }

        override suspend fun mount() {
            mount?.invoke()
        }
    }
}

/**
 * The boot loop over :core's stage machine. [onTransition] sees every accepted transition (inside
 * [send], before [state] moves), so a holder can fold the emits into what its screens render.
 * [answer], when given, answers a consent request itself; otherwise [answerConsent] does.
 */
public class BootDriver(
    options: BootOptions = BootOptions(),
    private val answer: (suspend (bytes: Long, metered: Boolean) -> Boolean)? = null,
    private val onTransition: (BootTransition) -> Unit = {},
) {
    private val _state = MutableStateFlow(initialBootState(options))
    public val state: StateFlow<BootState> = _state.asStateFlow()
    private var consentAnswer: CompletableDeferred<Boolean>? = null

    /** Send [event] to the machine; answers the emits (empty when the event was ignored). */
    @Synchronized
    public fun send(event: BootEvent): List<BootEmit> {
        val transition = bootTransition(_state.value, event)
        if (transition.emits.isEmpty()) return emptyList()
        onTransition(transition)
        _state.value = transition.state
        return transition.emits
    }

    /** Answer a pending consent request (the consent card's buttons). */
    public fun answerConsent(accept: Boolean) {
        consentAnswer?.complete(accept)
    }

    /** Retry from a stop or a waiting gate. */
    public fun retry() {
        send(BootEvent.Retry)
    }

    /** Continue offline from a playable offline stop. */
    public fun playOffline() {
        send(BootEvent.PlayOffline)
    }

    /** [run] in [scope] for the life of a screen: waits at stops for a retry; [host]'s confirm runs in [scope]. */
    public fun launch(scope: CoroutineScope, host: PolarisBootHost): Job = scope.launch { run(host, confirmIn = scope) }

    /**
     * Start the machine and, at every working stage, do that stage's work with [host] and send its
     * result. Returns at `ready` (or `background`); at any other stop returns when [untilSettled],
     * else waits there until a retry (or the licence becoming usable, for the gate) moves it on.
     * Once the boot first settles, [host]'s `confirm` runs once in [confirmIn] (none when null).
     */
    public suspend fun run(host: PolarisBootHost, untilSettled: Boolean = false, confirmIn: CoroutineScope? = null): BootState {
        var confirmed = false
        send(BootEvent.Start)
        while (true) {
            currentCoroutineContext().ensureActive()
            val state = _state.value
            // A consent the fetch is waiting on is mid-stage, not a settle: nothing is confirmed there.
            val consentWait = state.stage == BootStage.fetch && state.outcome == BootOutcome.waiting
            if (state.outcome != BootOutcome.running && !consentWait && !confirmed) {
                confirmed = true
                val outcome = state.outcome
                confirmIn?.launch {
                    // A confirmation that fails leaves the launch counted; the boot goes on.
                    quietly { host.confirm(outcome) }
                }
            }
            if (state.stage == BootStage.ready || state.stage == BootStage.background) return state
            if (state.outcome != BootOutcome.running) {
                if (untilSettled) return state
                _state.first { it != state }
                continue
            }
            val event = try {
                workUnlessMoved(state.stage, host)
            } catch (e: CancellationException) {
                throw e
            } catch (e: PolarisException) {
                BootEvent.Fail(e.code)
            } catch (e: Exception) {
                BootEvent.Fail(ErrorCode.internalError)
            }
            when (event) {
                Moved -> continue
                is BootEvent -> if (send(event).isEmpty()) _state.first { it != state }
                else -> return state
            }
        }
    }

    private object Moved

    /** [stage]'s work, or [Moved] when an outside event moved the machine to another stage first. */
    private suspend fun workUnlessMoved(stage: BootStage, host: PolarisBootHost): Any? = coroutineScope {
        val work = async { work(stage, host) }
        val moved = async { _state.first { it.stage != stage } }
        select<Any?> {
            work.onAwait { moved.cancel(); it }
            moved.onAwait { work.cancel(); Moved }
        }
    }

    private suspend fun work(stage: BootStage, host: PolarisBootHost): BootEvent? = when (stage) {
        BootStage.idle -> BootEvent.Start
        BootStage.shell -> {
            host.shell()
            BootEvent.ShellDone
        }
        BootStage.guard -> BootEvent.GuardDone(host.guard())
        BootStage.sync -> BootEvent.SyncDone(host.sync())
        BootStage.gate -> BootEvent.GateStatus(host.gate())
        BootStage.decide -> BootEvent.DecideDone(host.decide())
        BootStage.fetch -> {
            val (result, installed) = host.fetch(reporter)
            BootEvent.FetchDone(result, installed)
        }
        BootStage.mount -> {
            host.mount()
            BootEvent.MountDone
        }
        BootStage.ready, BootStage.background, BootStage.offline, BootStage.blocked, BootStage.error -> null
    }

    private val reporter = object : PolarisFetchReporter {
        override fun progress(done: Long, total: Long) {
            send(BootEvent.FetchProgress(done, total))
        }

        override suspend fun consent(bytes: Long, metered: Boolean): Boolean {
            val pending = CompletableDeferred<Boolean>()
            consentAnswer = pending
            if (send(BootEvent.FetchConsent(bytes, metered)).isEmpty()) {
                consentAnswer = null
                return true
            }
            val accepted = answer?.invoke(bytes, metered) ?: pending.await()
            consentAnswer = null
            // Back to running: the fetch goes ahead from zero.
            if (accepted) send(BootEvent.FetchProgress(0, bytes))
            return accepted
        }
    }
}

/** `client.boot()`'s options. */
public data class ClientBootOptions(
    /** Pack ids that must be present before mount (added to the content stamp's). */
    val requiredPacks: List<String> = emptyList(),
    /** The stage machine's `allowOffline` / `allowGrace`. */
    val allowOffline: Boolean = true,
    val allowGrace: Boolean = true,
    /** Register keylessly where discovery's `core.registration` is `open` (shell and gate). */
    val registration: Boolean = true,
    /** When to ask before downloading required content. */
    val consent: BootConsentPolicy = BootConsentPolicy.metered,
    /** Whether the network is metered, as the host knows it. */
    val metered: Boolean = false,
    /** The player's answer to `consent_needed`. Default: decline (nothing downloads unasked). */
    val answer: suspend (bytes: Long, metered: Boolean) -> Boolean = { _, _ -> false },
    /** Confirm a `ready` launch after BOOT_OK_SECONDS (an outcome that confirms `now` always does). */
    val autoConfirm: Boolean = true,
    /** The product's mount; none by default. */
    val mount: (suspend () -> Unit)? = null,
    /** Every accepted transition, with its emits (`stage_changed` first). */
    val onStage: ((BootTransition) -> Unit)? = null,
)

/** `client.boot()`'s answer. */
public data class BootResult(
    /** `ready`, `waiting` (the gate or a consent needs the player), `blocked`, `offline` or `error`. */
    val outcome: BootOutcome,
    val state: BootState,
    /** The gate's status at the end. */
    val license: LicenseState,
    /** The update decision, when one was made. */
    val decision: UpdateCheck?,
    /** Every emit, in order. */
    val emits: List<BootEmit>,
)

/**
 * Drive the boot stage machine to its first stop over [bootHost] (see the file header) and answer
 * the outcome. Never prompts: a gate that needs a key or a sign-in ends `waiting` with the status,
 * and the host renders its activation screen.
 */
public suspend fun PolarisKeyClient.boot(options: ClientBootOptions = ClientBootOptions()): BootResult {
    // SP-50: the content stamp and the default update slots are on disk; read them off the main thread.
    val (stampRequired, stampEssential) = withContext(Dispatchers.IO) {
        if (packs.configured) quietly { packs.bootOptions() } ?: (emptyList<String>() to emptyList()) else emptyList<String>() to emptyList()
    }
    val bootOptions = BootOptions(
        allowOffline = options.allowOffline,
        allowGrace = options.allowGrace,
        requiredPacks = (stampRequired + options.requiredPacks).distinct(),
        essentialPacks = stampEssential,
    )
    var decision: UpdateCheck? = null
    val emits = ArrayList<BootEmit>()
    val host = withContext(Dispatchers.IO) {
        bootHost(
            mount = options.mount,
            consent = options.consent,
            metered = { options.metered },
            onCheck = { decision = it },
            registration = options.registration,
        )
    }
    val driver = BootDriver(bootOptions, answer = options.answer) { t ->
        emits += t.emits
        options.onStage?.invoke(t)
    }
    val state = driver.run(host, untilSettled = true)
    val confirmation = bootConfirmation(state.outcome)
    if (confirmation == BootConfirmation.now || (confirmation == BootConfirmation.afterOkSeconds && options.autoConfirm)) {
        scope.launch { quietly { host.confirm(state.outcome) } }
    }
    return BootResult(state.outcome, state, status(), decision, emits.toList())
}
