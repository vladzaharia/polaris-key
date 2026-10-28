// Lifecycle-aware refresh for Android (SP-K08, notes/SDK-PARITY-PASS.md §3.11 "Refresh"): one
// Application.ActivityLifecycleCallbacks that
//
//   - tracks the current activity, so AndroidOptions.activity needs no host code
//     (`AndroidOptions(activity = lifecycle::currentActivity)`);
//   - syncs when the app comes to the foreground (the first started activity after every activity
//     stopped), at most once per [minForegroundInterval] — Core's ETags and backoff still apply, so a
//     foreground sync that has nothing new costs a 304;
//   - asks a ProgressiveInstallDriver (a Play flexible update) to re-read its state on resume, so an
//     update that finished downloading while the app was away becomes "Restart to finish".
//
// Cloud Sync (U-07.K10): the last activity stopping runs one bounded `cloudSync.flush()`, and coming back
// to the foreground touches it. There is no WorkManager (Q-5).
//
// It needs no androidx dependency: process foregrounding is counted from activity starts and stops,
// as ProcessLifecycleOwner does. A periodic background sync (WorkManager) is the host's own worker
// calling `client.sync()`; the SDK ships no WorkManager dependency.

package im.plrs.key.android

import android.app.Activity
import android.app.Application
import android.os.Bundle
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.update.ProgressiveInstallDriver
import java.lang.ref.WeakReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS

/** Foreground sync and the current activity for one [PolarisKeyClient]; see the file comment. */
public class PolarisKeyLifecycle internal constructor(
    /** Seconds between two foreground syncs; a return sooner than this does not sync again. */
    private val minForegroundInterval: Long,
    private val clock: () -> Long,
    private val scope: CoroutineScope,
) : Application.ActivityLifecycleCallbacks {
    @Volatile private var current: WeakReference<Activity>? = null
    @Volatile private var started = 0
    @Volatile private var lastForegroundSync = Long.MIN_VALUE / 2
    @Volatile private var client: PolarisKeyClient? = null

    /** The resumed (else the last started) activity, or null. Pass it as AndroidOptions.activity. */
    public fun currentActivity(): Activity? = current?.get()

    /** Whether any activity is started (the app is in the foreground). */
    public val inForeground: Boolean get() = started > 0

    /** The client foreground syncs refresh; set it once it is built (it may be built after [install]). */
    public fun attach(client: PolarisKeyClient) {
        this.client = client
    }

    /** One foreground pass: a sync (throttled) and the install driver's resume. */
    internal fun onForeground() {
        val c = client ?: return
        val now = clock()
        val due = now - lastForegroundSync >= minForegroundInterval
        if (due) lastForegroundSync = now
        // Cloud Sync: nudge the machine and retry a key ring forget that failed (no WorkManager, Q-5).
        scope.launch { quietly { c.cloudSync.touch() } }
        scope.launch {
            if (due) quietly { c.sync() }
            (c.update.installDriver as? ProgressiveInstallDriver)?.let { quietly { it.resume() } }
        }
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Offline or refused: the next foreground or refresh tries again.
        }
    }

    override fun onActivityStarted(activity: Activity) {
        current = WeakReference(activity)
        started += 1
        if (started == 1) onForeground()
    }

    override fun onActivityResumed(activity: Activity) {
        current = WeakReference(activity)
    }

    override fun onActivityStopped(activity: Activity) {
        started = (started - 1).coerceAtLeast(0)
        if (started == 0) onBackground()
    }

    /** The last activity stopped: one bounded Cloud Sync flush, so what the person edited is sent before the process can freeze. */
    internal fun onBackground() {
        val c = client ?: return
        scope.launch {
            quietly { withTimeoutOrNull(BACKGROUND_FLUSH_MILLIS) { c.cloudSync.flush() } }
        }
    }

    override fun onActivityDestroyed(activity: Activity) {
        if (current?.get() === activity) current = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    public companion object {
        /** The bound of the flush when the app goes to the background: the sign-out flush window plus a second. */
        internal const val BACKGROUND_FLUSH_MILLIS: Long = SYNC_SIGNOUT_FLUSH_MS + 1_000L

        /** The default throttle: one foreground sync per minute at most. */
        public const val DEFAULT_MIN_FOREGROUND_INTERVAL: Long = 60

        /**
         * Register the callbacks on [application] (call it from `Application.onCreate`, before the
         * first activity starts) and [attach] the client when it exists.
         */
        public fun install(
            application: Application,
            client: PolarisKeyClient? = null,
            minForegroundInterval: Long = DEFAULT_MIN_FOREGROUND_INTERVAL,
        ): PolarisKeyLifecycle {
            val lifecycle = PolarisKeyLifecycle(
                minForegroundInterval,
                { System.currentTimeMillis() / 1000 },
                CoroutineScope(SupervisorJob() + Dispatchers.Default),
            )
            client?.let { lifecycle.attach(it) }
            application.registerActivityLifecycleCallbacks(lifecycle)
            return lifecycle
        }
    }
}
