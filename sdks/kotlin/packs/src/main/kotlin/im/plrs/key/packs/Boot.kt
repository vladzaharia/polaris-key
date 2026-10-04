// The stage machine's host side for packs (plans/P4-01.md §2.10, §5 order 1; client-core
// `packs/boot.ts`; Swift's `Boot.swift` the structural model): the boot's FETCH stage driven by the
// pack engine. `bootPackOptions` turns the content stamp's `expects` into `requiredPacks` and
// `essentialPacks`; `runBootFetch` sends the events the machine accepts in `fetch` —
// `fetch.consent {bytes, metered}`, `fetch.progress {done, total}` and `fetch.done {result,
// installed}`. `stage-matrix.json` pins what the machine does with them.

package im.plrs.key.packs

import im.plrs.key.core.BootEvent
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PackTarget
import kotlinx.coroutines.CancellationException

/** The boot's pack options from the stamp: required expects, and essential ones that are not required. */
public fun bootPackOptions(stamp: AppContent?): Pair<List<String>, List<String>> {
    val expects = stamp?.expects ?: emptyList()
    return expects.filter { it.required }.map { it.pack } to expects.filter { !it.required && it.delivery == "essential" }.map { it.pack }
}

/** When to ask before downloading. */
public enum class BootConsentPolicy { always, metered, never }

/** [runBootFetch]'s options. */
public class RunBootFetchOptions(
    /** The running build's content stamp. */
    public val stamp: AppContent?,
    /** Delivers each event to the host's stage machine (`bootTransition`). */
    public val send: (BootEvent) -> Unit,
    public val consent: BootConsentPolicy = BootConsentPolicy.metered,
    /** Whether the network is metered, as the host knows it. */
    public val metered: Boolean = false,
    /** The player's answer to `consent_needed`: true to download. */
    public val answer: (suspend (bytes: Long, metered: Boolean) -> Boolean)? = null,
    /** A `packs` decision's `install` list: required/essential entries install here, the rest come back in `background`. */
    public val install: List<PackTarget>? = null,
)

/** [runBootFetch]'s answer. */
public data class BootFetchResult(val result: BootEvent.FetchResult, val installed: List<String>, val background: List<PackTarget>)

/**
 * Run the FETCH stage: estimate the required and essential packs that are not current, ask when the
 * policy says so, download them with progress, and report what is installed. `ok` when every wanted
 * pack installed, `declined`, `offline` for a `network-error`, else `failed`.
 */
public suspend fun runBootFetch(engine: PackEngine, opts: RunBootFetchOptions): BootFetchResult {
    val (requiredPacks, essentialPacks) = bootPackOptions(opts.stamp)
    val wanted = ArrayList<String>()
    for (id in requiredPacks + essentialPacks) if (id !in wanted) wanted += id
    val blocking = wanted.toSet()
    val targets = LinkedHashMap<String, PackTarget>()
    val background = ArrayList<PackTarget>()
    for (t in opts.install ?: emptyList()) if (t.pack in blocking) targets[t.pack] = t else background += t
    val metered = opts.metered
    val pins = LinkedHashMap<String, String>()
    for (p in opts.stamp?.pins ?: emptyList()) if (!pins.containsKey(p.pack)) pins[p.pack] = p.sha256
    for ((id, t) in targets) pins[id] = t.release.sha256
    fun installedNow(): List<String> {
        val running = try {
            engine.state().running
        } catch (e: Exception) {
            emptyMap()
        }
        return wanted.filter { id -> running[id] != null && running[id]!!.recordSha256 == pins[id] }
    }
    fun done(result: BootEvent.FetchResult): BootFetchResult {
        val installed = installedNow()
        opts.send(BootEvent.FetchDone(result, installed))
        return BootFetchResult(result, installed, background)
    }

    var est = engine.estimate(wanted.filter { !targets.containsKey(it) })
    if (targets.isNotEmpty()) {
        val t = engine.estimateReleases(wanted.mapNotNull { targets[it] })
        est = PackEstimate(est.bytes + t.bytes, est.packs + t.packs, est.refused + t.refused)
    }
    val ask = est.bytes > 0 && (opts.consent == BootConsentPolicy.always || (opts.consent == BootConsentPolicy.metered && metered))
    if (ask) {
        opts.send(BootEvent.FetchConsent(est.bytes, metered))
        val yes = opts.answer?.invoke(est.bytes, metered) ?: false
        if (!yes) return done(BootEvent.FetchResult.declined)
    }
    val total = est.bytes
    opts.send(BootEvent.FetchProgress(0, total))
    var base = 0L
    var last = 0L
    val lock = Any()
    val off = engine.on { p ->
        if (p.phase != "download") return@on
        val event: BootEvent? = synchronized(lock) {
            val now = minOf(total, base + p.done)
            if (now > last) {
                last = now
                BootEvent.FetchProgress(now, total)
            } else null
        }
        if (event != null) opts.send(event)
    }
    try {
        var result = BootEvent.FetchResult.ok
        for (id in est.packs) {
            try {
                val t = targets[id]
                if (t != null) engine.ensureReleases(listOf(t)) else engine.ensure(listOf(id))
            } catch (e: CancellationException) {
                throw e
            } catch (e: PackException) {
                result = if (e.code == ErrorCode.networkError) BootEvent.FetchResult.offline else BootEvent.FetchResult.failed
            } catch (e: Exception) {
                result = BootEvent.FetchResult.failed
            }
            synchronized(lock) { base = last }
        }
        if (est.refused.isNotEmpty() && result == BootEvent.FetchResult.ok) {
            result = if (est.refused.any { it.second == ErrorCode.networkError }) BootEvent.FetchResult.offline else BootEvent.FetchResult.failed
        }
        val l = synchronized(lock) { last }
        if (result == BootEvent.FetchResult.ok && l < total) opts.send(BootEvent.FetchProgress(total, total))
        return done(result)
    } finally {
        off()
    }
}
