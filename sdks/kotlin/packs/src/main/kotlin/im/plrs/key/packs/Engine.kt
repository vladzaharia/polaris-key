// The pack pipeline (CONTENT §10; plans/P4-01.md §2.6, §2.9): preflight, journal, fetch, verify,
// commit, activate, confirm and resume, over injected ports. client-core `packs/engine.ts` (P4-06)
// is the reference; Swift's `Engine.swift` the structural model, ported with its state safety: a
// state read is "missing" only on not-found; a torn document is quarantined with GC held and the
// hold's snapshot persisted and reused; an unreadable document blocks every write; an install whose
// payload check throws stays in the document, out of use and out of GC; and a fresh commit carries
// such an active over to previous, re-verified at rollback.
//
// For each pack id `ensure` asks for:
//
//  1. the content stamp's pin (a host without a stamp has no packs, §2.8);
//  2. the pinned pack record, fetched by hash and verified against the pinned release keys with
//     `pin: {kind: "pack", deliverable, version, seq}` (a delegated record through its delegation);
//  3. its type, its entitlement, and `selectVariant`;
//  4. the target files index when the layout is `tree` or a release of the pack is installed;
//     `planTarget` and `plan` (the feed's delta menu merged, plans/P4-29.md §2.4);
//  5. a journal, then each object fetched with `Range`/`If-Range` into staging, resumed from what is
//     staged (re-hashed, never trusted), checkpointed;
//  6. the applier; on a refusal, the next fallback (`full` always last; at most one feed delta);
//  7. commit, activation (`hot` now; `restart` at the next boot), and garbage collection.
//
// Concurrency: every mutating call runs under one mutex (Swift's serialised actor queue); the
// read-only calls (`state`, `open`, `packSetId`, `isAvailable`, `revocations`, `revokedBy`,
// `delegatedReleases`) read @Volatile immutable snapshots and never wait for an install.

package im.plrs.key.packs

import im.plrs.key.core.DelegatedRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FeedDelta
import im.plrs.key.core.LearnedRevocation
import im.plrs.key.core.MAX_DELEGATIONS_PER_CHECK
import im.plrs.key.core.MAX_FILES_INDEX_BYTES
import im.plrs.key.core.PackTarget
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RecordRevokedBy
import im.plrs.key.core.ReleasePin
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.ReleaseRecordStep
import im.plrs.key.core.VerifiedRevocation
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.arrayValue
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.delegation
import im.plrs.key.core.delegationHashOf
import im.plrs.key.core.newerRevocation
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.packMatch
import im.plrs.key.core.record
import im.plrs.key.core.recordHash
import im.plrs.key.core.recordRevoked
import im.plrs.key.core.stringValue
import im.plrs.key.core.variantKey
import im.plrs.key.core.verifyReleaseRecord
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** SHA-256 of the empty string: an empty object is legitimately zero bytes long. */
private const val EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

private sealed interface Preflight {
    class Current(val install: PackInstall) : Preflight
    class Plan(val planned: Planned) : Preflight
}

private class Planned(
    val body: String,
    val recordSha256: String,
    val record: PackRecordDoc,
    val variant: PackVariant,
    val installs: List<PackInstall>,
    val seeds: Map<String, InstalledPayload>,
    val planId: String,
    val index: FilesIndexDoc?,
    val plan: PlanResult,
    val delegation: String?,
    val chunk: ChunkContext?,
    val feedIds: Set<String>,
)

private class SeedEntry(val location: String, val payloadSha256: String, val seed: ChunkSeed)
private class ChunkContext(val index: ChunkIndexDoc, val seeds: List<SeedEntry>)

private enum class FetchOutcome { ok, interrupted, mismatch }

/** A mutable progress counter (Swift's `inout (done, total)`). */
private class Progress(var done: Long, val total: Long)

/** The pack engine. */
public class PackEngine(private val opts: PackEngineOptions) {
    private val handlerTable = ConcurrentHashMap<String, PackHandler>()
    private val listeners = ConcurrentHashMap<Long, (PackProgress) -> Unit>()
    private var listenerSeq = 0L
    private val op = Mutex()

    @Volatile private var embedded: Map<String, PackInstall> = emptyMap()
    @Volatile private var running: Map<String, PackInstall> = emptyMap()
    @Volatile private var unverifiable: Set<String> = emptySet()
    private var deferredActive: Map<String, PackInstall> = emptyMap()
    private var deferredPrevious: Map<String, PackInstall> = emptyMap()
    @Volatile private var stateIssue: String? = null
    private var gcHold = false
    private var holdSnapshot: Pair<Set<String>, Set<String>>? = null
    private val unverifiedPrevious = HashSet<String>()
    @Volatile private var doc: PackStateDoc? = null
    @Volatile private var revDoc: RevocationsDoc = emptyRevocations()
    @Volatile private var revVerified: Map<String, VerifiedRevocation> = emptyMap()
    @Volatile private var revJws: Map<String, String> = emptyMap()
    @Volatile private var revIssue: String? = null
    private var revFile = false
    private val preflightPlans = HashMap<String, Pair<String, String>>()
    private val delegationBodies = HashMap<String, String>()
    private var delegationBudget = MAX_DELEGATIONS_PER_CHECK
    @Volatile private var delegatedKnown: Map<String, DelegatedRelease> = emptyMap()
    private val seedIndexTried = HashSet<String>()
    private val providesMemo = ProvidesMemo()

    init {
        // Built in (P4-16): `data.json` and `l10n.table` with their default options.
        handlerTable[FilesTreeHandler.type] = FilesTreeHandler
        handlerTable["data.json"] = DataJsonHandler()
        handlerTable["l10n.table"] = L10nTableHandler()
        for (h in opts.handlers) handlerTable[h.type] = h
    }

    /** Add or replace a handler for a pack type. Throws `invalid-options` outside the vocabulary. */
    public fun registerHandler(handler: PackHandler) {
        if (handler.type.isEmpty() || (handler.layout != "tree" && handler.layout != "container") ||
            (handler.activation != "hot" && handler.activation != "restart")
        ) {
            throw PackException(ErrorCode.invalidOptions, "registerHandler needs {type, layout tree|container, activation hot|restart, supports}.")
        }
        handlerTable[handler.type] = handler
    }

    /** Progress events; returns the unsubscribe function. */
    public fun on(listener: (PackProgress) -> Unit): () -> Unit {
        val id = synchronized(listeners) { ++listenerSeq }
        listeners[id] = listener
        return { listeners.remove(id) }
    }

    private fun handler(type: String): PackHandler? = handlerTable[type]

    private fun emit(e: PackProgress) {
        for (l in listeners.values) {
            try {
                l(e)
            } catch (x: Exception) {
                // A listener never fails an install.
            }
        }
    }

    /**
     * Load the state (re-verifying every entry), register the host's embedded baselines, activate what
     * this boot runs, persist the document and collect garbage. Run once, before `ensure`. Returns the
     * embedded baselines that were refused, by marker step.
     */
    public suspend fun load(embeddedList: List<EmbeddedBaseline> = emptyList()): List<Pair<String, String>> = op.withLock { loadNow(embeddedList) }

    private suspend fun loadNow(embeddedList: List<EmbeddedBaseline>): List<Pair<String, String>> {
        val refused = ArrayList<Pair<String, String>>()
        val emb = LinkedHashMap(embedded)
        for (e in embeddedList) {
            when (val r = verifyEmbedded(e)) {
                is EmbeddedVerdict.Ok -> emb[r.install.packId] = r.install
                is EmbeddedVerdict.Refused -> refused += e.location to r.step
            }
        }
        embedded = emb
        val st = opts.state
        var text: String? = null
        var unreadable = false
        try {
            text = st.read()
        } catch (e: Exception) {
            unreadable = true
        }
        val torn = !unreadable && text != null && text.isNotBlank() && !looksLikeState(text)
        if (torn) {
            try {
                st.quarantine(text!!)
            } catch (e: Exception) {
                unreadable = true
            }
        }
        val held = !unreadable && (torn || (try { st.quarantined() } catch (e: Exception) { true }))
        stateIssue = if (unreadable) "unreadable" else if (held) "torn" else null
        gcHold = unreadable
        if (held) {
            val listed = holdList(st)
            if (listed != null) holdSnapshot = listed.first.toSet() to listed.second.toSet() else gcHold = true
        }
        stateIssue?.let { emit(PackProgress("", "state-issue", 0, 0, it)) }
        val parsed = parsePackState(if (torn) null else text)
        val deferred = HashSet<PackInstall>()
        val unverifiableNow = HashSet<String>()
        val storage = opts.storage
        val reloaded = reloadPackState(
            parsed,
            PackStateVerifier(
                install = { i ->
                    if (!verifyStoredRecord(i.record, i.recordSha256, i.packId, i, i.delegation)) {
                        false
                    } else {
                        try {
                            storage.verify(i)
                        } catch (e: Exception) {
                            // The payload could not be read: kept in the document and out of GC, but out
                            // of the running set and the planner.
                            unverifiableNow += i.location
                            deferred += i
                            false
                        }
                    }
                },
                journal = { j -> verifyStoredRecord(j.record, j.recordSha256, j.packId, null, j.delegation) },
            ),
        )
        unverifiable = unverifiable + unverifiableNow
        deferredActive = parsed.active.filter { it.value in deferred }
        deferredPrevious = parsed.previous.filter { it.value in deferred }
        doc = reloaded
        loadRevocations(unreadable)
        for (id in reloaded.active.keys.sorted()) {
            val i = reloaded.active.getValue(id)
            if (!installRevoked(i)) activate(i)
        }
        for ((id, e) in embedded) if (!running.containsKey(id) && !embeddedRefused(e)) running = running + (id to e)
        if (!unreadable) persist()
        collect()
        return refused
    }

    /** The install state and this process's running set. */
    public fun state(): PacksSnapshot {
        val d = requireLoaded()
        val inflight = d.inflight.mapValues { (_, j) ->
            PacksSnapshot.Inflight(j.planId, j.strategy, j.objects.sumOf { it.done }, j.objects.sumOf { it.bytes })
        }
        return PacksSnapshot(d.active, d.previous, inflight, running, d.confirmedBootSeq, d.bootSeq, stateIssue)
    }

    /** The bytes of a pack's running install, or null. */
    public fun open(packId: String): InstalledPayload? = running[packId]?.let { opts.storage.installed(it) }

    /** `packSetId` of the running set (plans/P4-01.md §2.9), for `devices/report`'s `content`. */
    public fun packSetId(): String? = packSetId(running.values.map { PackSetEntry(it.packId, it.recordSha256) })

    /** Save compatibility (P4-20): whether a release in the ACTIVE (running) set provides [contentId]. */
    public suspend fun isAvailable(contentId: String): Boolean {
        requireLoaded()
        val granted = opts.entitlements()
        for (i in running.values) {
            val facts = synchronized(providesMemo) { providesMemo.facts(ProvidesMemo.key(i.packId, i.recordSha256), i.record) }
            if (facts.answers(contentId, granted)) return true
        }
        return false
    }

    /**
     * The pack whose TARGET release provides [contentId] ([targets], or the stamp's pins), so a game can
     * `estimate` and `ensure` it. Revoked, unverifiable and unentitled targets never answer.
     */
    public suspend fun packFor(contentId: String, targets: List<PackTarget>? = null): PackProvider? = op.withLock {
        requireLoaded()
        resetDelegationBudget()
        val list = targets ?: (opts.stamp?.pins ?: emptyList()).map { PackTarget(it.pack, ReleasePin(it.sha256, it.seq, it.version)) }
        val granted = opts.entitlements()
        val delegated = delegatedReleases()
        for (t in list) {
            if (revokedBy(t.release.sha256, delegated[t.release.sha256]?.delegation) != null) continue
            val f = targetFacts(t)
            if (f != null && f.answers(contentId, granted)) return@withLock PackProvider(t.pack, t.release)
        }
        null
    }

    private suspend fun targetFacts(t: PackTarget): ProvidesFacts? {
        val sha = t.release.sha256
        val key = ProvidesMemo.key(t.pack, sha)
        synchronized(providesMemo) { providesMemo.get(key) }?.let { return it }
        val d = doc ?: return null
        for (i in listOfNotNull(d.active[t.pack], d.previous[t.pack], running[t.pack], embedded[t.pack])) {
            if (i.recordSha256 == sha && i.packId == t.pack) return synchronized(providesMemo) { providesMemo.facts(key, i.record) }
        }
        val (body, _, _) = try {
            fetchVerified(t.pack, t.release)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        return synchronized(providesMemo) { providesMemo.facts(key, body) }
    }

    /** Mark this boot healthy (CONTENT §10 step 7). */
    public suspend fun confirm(): Unit = op.withLock {
        refuseUnreadable()
        doc = confirmBoot(requireLoaded())
        persist()
    }

    /** Re-point a pack at `previous`. A hot pack switches now; a restart pack at the next boot. */
    public suspend fun rollback(packId: String): Boolean = op.withLock { rollbackNow(packId) }

    private suspend fun rollbackNow(packId: String): Boolean {
        refuseUnreadable()
        val d = requireLoaded()
        val before = d.active[packId]
        val prev = d.previous[packId]
        // plans/P4-13.md §2.5: never back to a revoked release.
        if (prev != null && installRevoked(prev)) return false
        if (prev != null && packId in unverifiedPrevious) {
            var ok = verifyStoredRecord(prev.record, prev.recordSha256, packId, prev, prev.delegation)
            if (ok) ok = try { opts.storage.verify(prev) } catch (e: Exception) { false }
            if (!ok) return false
            unverifiedPrevious -= packId
        }
        val (next, rolledBack) = rollbackInstall(d, packId)
        if (!rolledBack) return false
        doc = next
        persist()
        val now = next.active.getValue(packId)
        if (now.activation == "hot") {
            val h = handler(now.type)
            if (before != null && h != null) h.deactivate(before)
            activate(now)
        }
        return true
    }

    /** Install the pinned release of each pack, in order. Throws a [PackException] for the first failure. */
    public suspend fun ensure(packIds: List<String>): List<PackInstall> = op.withLock {
        refuseUnreadable()
        resetDelegationBudget()
        packIds.map { ensureOne(it, null) }
    }

    /** Install exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6). */
    public suspend fun ensureReleases(targets: List<PackTarget>): List<PackInstall> = op.withLock {
        refuseUnreadable()
        resetDelegationBudget()
        targets.map { ensureOne(it.pack, it.release) }
    }

    /** Preflight each pack without downloading the payload; the chosen strategies' bytes. */
    public suspend fun estimate(packIds: List<String>): PackEstimate = estimateAll(packIds.map { it to null })

    /** [estimate] for exact releases. */
    public suspend fun estimateReleases(targets: List<PackTarget>): PackEstimate = estimateAll(targets.map { it.pack to it.release })

    private suspend fun estimateAll(items: List<Pair<String, ReleasePin?>>): PackEstimate = op.withLock {
        refuseUnreadable()
        resetDelegationBudget()
        var bytes = 0L
        val packs = ArrayList<String>()
        val refused = ArrayList<Pair<String, String>>()
        for ((id, release) in items) {
            try {
                when (val p = preflight(id, release)) {
                    is Preflight.Current -> {}
                    is Preflight.Plan -> {
                        val chosen = p.planned.plan as? PlanResult.Chosen
                        if (chosen != null) {
                            if (chosen.candidate.strategy == "noop") continue
                            packs += id
                            bytes += chosen.candidate.bytes
                        } else {
                            packs += id
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: PackException) {
                refused += id to e.code
            } catch (e: PolarisException) {
                refused += id to e.code
            } catch (e: Exception) {
                refused += id to ErrorCode.networkError
            }
        }
        PackEstimate(bytes, packs, refused)
    }

    /** Operator recovery after a torn state document: drop the copy held aside and resume GC. */
    public suspend fun recoverState(): Unit = op.withLock {
        requireLoaded()
        if (stateIssue == "unreadable") throw PackException(ErrorCode.packStateUnreadable, "The pack state could not be read; restart once the store is readable.")
        opts.state.clearQuarantine()
        stateIssue = null
        gcHold = false
        holdSnapshot = null
        val rs = opts.revocations
        if (rs != null && revIssue != "unreadable") {
            rs.clearQuarantine()
            if (revDoc.relearn.isNotEmpty()) {
                revDoc = revDoc.copy(relearn = emptyList())
                if (revFile) rs.replace(serializeRevocations(revDoc))
            }
            if (revIssue == "torn") revIssue = null
        }
        collect()
    }

    // ── Revocations (plans/P4-13.md §2.5) ───────────────────────────────────────────────────

    /** The stored and this process's verified revocations. */
    public fun revocations(): RevocationsSnapshot {
        val revoked = LinkedHashMap(revDoc.revoked)
        for ((t, r) in revVerified) if (!revoked.containsKey(t)) revoked[t] = StoredRevocation(revJws[t] ?: "", r.pack, r.version, r.seq, r.record, r.issuedAt)
        return RevocationsSnapshot(revoked, revVerified, revDoc.relearn, revIssue)
    }

    /** Keep revocations a fresh check verified (plans/P4-13.md §2.5 step 11). */
    public suspend fun recordRevocations(learned: List<LearnedRevocation>, relearnCleared: List<String> = emptyList()): Unit = op.withLock {
        requireLoaded()
        var next = revDoc
        var changed = false
        val verified = LinkedHashMap(revVerified)
        val jws = LinkedHashMap(revJws)
        for (l in learned) {
            val t = l.revocation.target
            val prev = verified[t]
            if (prev == null || newerRevocation(l.revocation, prev) === l.revocation) {
                verified[t] = l.revocation
                jws[t] = l.jws
            }
            val r = storeRevocation(next, l.revocation, l.jws)
            next = r.first
            changed = changed || r.second
        }
        val c = clearRelearn(next, relearnCleared)
        next = c.first
        changed = changed || c.second
        // The cap may have dropped a target: it is forgotten here too.
        for (t in verified.keys.toList()) if (!next.revoked.containsKey(t) && revDoc.revoked.containsKey(t)) verified.remove(t)
        revDoc = next
        revVerified = verified
        revJws = jws
        try {
            if (changed) persistRevocations()
        } catch (e: Exception) {
            // A failed write never keeps a revoked release running.
            unmountRevoked()
            throw e
        }
        unmountRevoked()
    }

    /** Whether a release is revoked (stored, or verified in this process). */
    public fun isRevoked(recordSha256: String): Boolean = revDoc.revoked.containsKey(recordSha256) || revVerified.containsKey(recordSha256)

    /** Why a release is revoked (plans/P4-19.md §2.3): `record`, `delegation`, or null. */
    public fun revokedBy(recordSha256: String, delegationSha256: String?): RecordRevokedBy? =
        recordRevoked(recordSha256, delegationSha256, revDoc.revoked.keys + revVerified.keys)

    private fun installRevoked(i: PackInstall): Boolean = revokedBy(i.recordSha256, installDelegation(i)) != null

    /** The delegated releases this engine knows (plans/P4-19.md §2.7): record hash → pack and delegation hash. */
    public fun delegatedReleases(): Map<String, DelegatedRelease> {
        val out = LinkedHashMap(delegatedKnown)
        val d = doc
        val installs = (d?.active?.values ?: emptyList()) + (d?.previous?.values ?: emptyList()) + running.values
        for (i in installs) installDelegation(i)?.let { out[i.recordSha256] = DelegatedRelease(i.packId, it) }
        return out
    }

    private fun resetDelegationBudget() {
        delegationBudget = MAX_DELEGATIONS_PER_CHECK
    }

    /** The embedded-baseline refusals (plans/P4-13.md §2.5). */
    private fun embeddedRefused(e: PackInstall): Boolean {
        if (isRevoked(e.recordSha256)) return true
        if (e.packId in revDoc.relearn) return true
        if (revIssue == "unreadable" && doc?.revocationsStored == true && (e.packId in stampPacks() || embedded.containsKey(e.packId))) return true
        return false
    }

    private fun stampPacks(): Set<String> = (opts.stamp?.pins ?: emptyList()).map { it.pack }.toSet()

    private suspend fun loadRevocations(stateUnreadable: Boolean) {
        val rs = opts.revocations ?: return
        val text = try {
            rs.read()
        } catch (e: Exception) {
            revIssue = "unreadable"
            return
        } ?: return
        revFile = true
        val parsed = if (text.isBlank()) null else parseRevocations(text)
        if (parsed == null) {
            try {
                rs.quarantine(text)
            } catch (e: Exception) {
                revIssue = "unreadable"
                return
            }
            revIssue = "torn"
            val relearn = stampPacks() + embedded.keys
            revDoc = RevocationsDoc(emptyMap(), relearn.sortedWith { a, b -> compareUtf8Bytes(a, b) })
            if (!stateUnreadable) writeRevocations()
            return
        }
        val r = reloadRevocations(parsed, opts.releaseKeys, opts.productTrust(), opts.product)
        revDoc = r.doc
        revVerified = revVerified + r.verified
        if (r.changed && !stateUnreadable) {
            writeRevocations()
        } else if (!stateUnreadable && !isEmptyRevocations(revDoc) && doc?.revocationsStored != true) {
            try {
                persistFlag()
            } catch (e: Exception) {
                // The next sibling write retries it.
            }
        }
    }

    private fun persistRevocations() {
        if (opts.revocations == null) return
        if (revIssue == "unreadable" || stateIssue == "unreadable") return
        if (!revFile && isEmptyRevocations(revDoc)) return
        writeRevocations()
    }

    private fun writeRevocations() {
        val rs = opts.revocations ?: return
        if (!requireLoaded().revocationsStored) persistFlag()
        rs.replace(serializeRevocations(revDoc))
        revFile = true
    }

    private fun persistFlag() {
        val before = requireLoaded()
        doc = before.copy(revocationsStored = true)
        try {
            persist()
        } catch (e: Exception) {
            doc = before
            throw e
        }
    }

    private suspend fun unmountRevoked() {
        for ((id, i) in running) {
            if (!installRevoked(i)) continue
            if (i.activation == "hot") {
                val h = handler(i.type)
                if (h != null) {
                    try {
                        h.deactivate(i)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // A handler failure never keeps a revoked release running.
                    }
                }
            }
            running = running - id
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    private fun requireLoaded(): PackStateDoc = doc ?: throw PackException(ErrorCode.notConfigured, "Call load() before using packs.")

    private fun holdList(st: PackStateStore): Pair<List<String>, List<String>>? {
        if (st.keepsHoldList) {
            val saved = try {
                st.readHoldList()
            } catch (e: Exception) {
                return null
            }
            if (saved != null) {
                val d = parseJson(saved).objectValue ?: return null
                val locs = d["locations"].arrayValue ?: return null
                val plans = d["plans"].arrayValue ?: return null
                val ls = locs.mapNotNull { it.stringValue }
                val ps = plans.mapNotNull { it.stringValue }
                if (ls.size != locs.size || ps.size != plans.size) return null
                return ls to ps
            }
        }
        val listed = try {
            opts.storage.list()
        } catch (e: Exception) {
            return null
        }
        if (st.keepsHoldList) {
            val text = canonicalJson(
                buildJsonObject {
                    put("locations", JsonArray(listed.first.map { JsonPrimitive(it) }))
                    put("plans", JsonArray(listed.second.map { JsonPrimitive(it) }))
                },
            )
            try {
                st.writeHoldList(text)
            } catch (e: Exception) {
                return null
            }
        }
        return listed
    }

    private fun refuseUnreadable() {
        requireLoaded()
        if (stateIssue == "unreadable") {
            throw PackException(ErrorCode.packStateUnreadable, "The pack state could not be read, so nothing is fetched, written or installed this process.")
        }
    }

    private fun persist() {
        if (stateIssue == "unreadable") {
            throw PackException(ErrorCode.packStateUnreadable, "The pack state could not be read, so nothing is written or installed this process.")
        }
        val d = requireLoaded()
        val active = deferredActive + d.active
        val previous = LinkedHashMap(deferredPrevious + d.previous)
        for (id in active.keys) if (previous[id]?.recordSha256 == active[id]?.recordSha256) previous.remove(id)
        opts.state.replace(serializePackState(d.copy(active = active, previous = previous)))
    }

    private suspend fun activate(i: PackInstall) {
        val h = handler(i.type)
        if (h != null) {
            val storage = opts.storage
            h.activate(i, PackPayloadReader { storage.installed(i) })
        }
        running = running + (i.packId to i)
    }

    /** Steps 12–16 again over a stored record, with its own pack id as the pin. */
    private suspend fun verifyStoredRecord(jws: String, sha256: String, packId: String, install: PackInstall?, delegation: String? = null): Boolean {
        val r = verifyReleaseRecord(jws, VerifyReleaseRecordOptions(opts.releaseKeys, opts.productTrust(), opts.product, sha256, delegation = delegation))
        val rec = r.record ?: return false
        if (rec.kind != "pack" || rec.deliverable != packId) return false
        val pack = PackRecordDoc.from(rec.json) ?: return false
        if (install != null) {
            val v = pack.variants.firstOrNull { variantKey(it.variant) == install.variant } ?: return false
            if (pack.version != install.version || pack.seq != install.seq || v.payload.sha256 != install.payloadSha256 ||
                v.payload.size != install.payloadSize || pack.type != install.type
            ) {
                return false
            }
        }
        return true
    }

    private sealed interface EmbeddedVerdict {
        class Ok(val install: PackInstall) : EmbeddedVerdict
        class Refused(val step: String) : EmbeddedVerdict
    }

    private suspend fun verifyEmbedded(e: EmbeddedBaseline): EmbeddedVerdict {
        val m = verifyMarker(e.marker, opts.releaseKeys, opts.productTrust(), opts.product)
        if (m !is VerifyMarkerResult.Ok) return EmbeddedVerdict.Refused((m as VerifyMarkerResult.Rejected).step)
        val match = matchEmbedded(m.packId, m.record, m.recordSha256, e.payload, opts.stamp)
        val k = match.getOrElse { return EmbeddedVerdict.Refused((it as MarkerException).refusal.step) }
        val v = m.record.variants[k]
        return EmbeddedVerdict.Ok(
            PackInstall(
                m.packId, m.release, m.recordSha256, m.version, m.record.seq, m.record.type, variantKey(v.variant), v.files.layout,
                v.payload.sha256, v.payload.size, activationOf(m.record, handler(m.record.type)), e.location, true, m.record.issuedAt,
            ),
        )
    }

    /** The installs of a pack the planner can reuse: active, previous and the embedded copy. */
    private fun installsOf(packId: String): List<PackInstall> {
        val d = requireLoaded()
        val out = ArrayList<PackInstall>()
        val seen = HashSet<String>()
        for (i in listOf(d.active[packId], embedded[packId], d.previous[packId])) if (i != null && seen.add(i.location)) out += i
        return out
    }

    /** Step 2 for one pin: the record fetched by hash and verified (a delegated one through its delegation). */
    private suspend fun fetchVerified(packId: String, release: ReleasePin): Triple<String, PackRecordDoc, String?> {
        val body = when (val f = opts.fetchRecord(release.sha256)) {
            is RecordFetchResult.Ok -> f.body
            is RecordFetchResult.Failed -> throw PackException(f.code, "Fetching $packId's record failed (${f.code}).", packId = packId)
        }
        var delegation: String? = null
        val h = delegationHashOf(body)
        if (h != null && delegatedAllowed(packId, release.sha256)) delegation = fetchDelegation(packId, h)
        val v = verifyReleaseRecord(
            body,
            VerifyReleaseRecordOptions(
                opts.releaseKeys, opts.productTrust(), opts.product, release.sha256,
                ReleaseRecordPin(kind = "pack", deliverable = packId, version = release.version, seq = release.seq), delegation,
            ),
        )
        val d = v.delegation
        if (d != null) {
            delegatedKnown = delegatedKnown + (release.sha256 to DelegatedRelease(packId, d.sha256))
            if (revokedBy(release.sha256, d.sha256) != null) {
                throw PackException(ErrorCode.packRevoked, "$packId@${release.version} was signed under a delegation its developer revoked.", "delegation", packId = packId)
            }
        }
        val delegated = if (d != null) delegation else null
        val record = when (v) {
            is VerifyReleaseRecordResult.Refused ->
                if (v.step == ReleaseRecordStep.crossCheck) {
                    throw PackException(ErrorCode.recordMismatch, "$packId's record is not the pinned release.", packId = packId)
                } else {
                    throw PackException(ErrorCode.recordRejected, "$packId's record was refused at ${v.step.wire}.", v.step.wire, packId = packId)
                }
            else -> PackRecordDoc.from(v.record!!.json)
                ?: throw PackException(ErrorCode.recordRejected, "$packId's record was refused at claims.", "claims", packId = packId)
        }
        return Triple(body, record, delegated)
    }

    /** Steps 1–4 for one pack: what is already current, or the verified record, variant, seeds, index and plan. */
    private suspend fun preflight(packId: String, want: ReleasePin?): Preflight {
        val d = requireLoaded()
        val stamp = opts.stamp ?: throw PackException(ErrorCode.notConfigured, "This build ships no content stamp, so it has no packs.", packId = packId)
        val stampPin = stamp.pins.firstOrNull { it.pack == packId }
        val pin = want?.let { ContentPin(packId, it.sha256, it.seq, it.version) } ?: stampPin
            ?: throw PackException(ErrorCode.packNotPinned, "The content stamp pins no release of $packId.", packId = packId)
        if (isRevoked(pin.sha256)) throw PackException(ErrorCode.packRevoked, "$packId@${pin.version} was revoked by its developer.", packId = packId)

        val current = d.active[packId]
        if (current != null && current.recordSha256 == pin.sha256) {
            if (installRevoked(current)) {
                throw PackException(ErrorCode.packRevoked, "$packId@${pin.version} was signed under a delegation its developer revoked.", "delegation", packId = packId)
            }
            return Preflight.Current(current)
        }
        val emb = embedded[packId]
        if (emb != null && emb.recordSha256 == pin.sha256 && current == null && !embeddedRefused(emb)) return Preflight.Current(emb)

        // 2. The pinned record, by hash, against the pinned release keys.
        val (body, record, delegated) = fetchVerified(packId, ReleasePin(pin.sha256, pin.seq, pin.version))

        // 3. Type, entitlement, variant.
        val h = handler(record.type)
        if (h == null || !h.supports(record.formatVersion) || (record.activation != null && record.activation != "hot" && record.activation != "restart")) {
            throw PackException(ErrorCode.packTypeUnsupported, "$packId is a ${record.type} v${record.formatVersion} pack, which this SDK cannot hold.", packId = packId)
        }
        val ent = record.entitlement
        if (ent != null) {
            val granted = opts.entitlements()
            if (granted != null && ent !in granted) throw PackException(ErrorCode.packNotEntitled, "$packId needs the $ent entitlement.", packId = packId)
        }
        val rawVariants = record.json["variants"].arrayValue ?: JsonArray(emptyList())
        val k = (selectVariant(rawVariants, opts.prefs) as? SelectVariantResult.Index)?.index
            ?: throw PackException(ErrorCode.packNoVariant, "No variant of $packId is eligible here.", packId = packId)
        val variant = record.variants[k]
        if (variant.files.layout != h.layout) {
            throw PackException(ErrorCode.packTypeUnsupported, "$packId's variant is a ${variant.files.layout}, not a ${h.layout}.", packId = packId)
        }

        // 4. The index, the target, the plan.
        val seeds = LinkedHashMap<String, InstalledPayload>()
        val installs = ArrayList<PackInstall>()
        for (i in installsOf(packId)) {
            val p = try {
                opts.storage.installed(i)
            } catch (e: Exception) {
                null
            }
            if (p != null) {
                seeds[i.location] = p
                installs += i
            }
        }
        val prior = d.inflight[packId]
        val early = preflightPlans[packId]
        val priorUsable = prior != null && prior.recordSha256 == pin.sha256 && prior.variant == variantKey(variant.variant) && journalDeltaKnown(prior, variant)
        val planId = when {
            prior != null && priorUsable -> prior.planId
            early != null && early.second == pin.sha256 -> early.first
            else -> opts.newPlanId()
        }
        preflightPlans[packId] = planId to pin.sha256
        var index: FilesIndexDoc? = null
        val needIndex = variant.files.layout == "tree" || seeds.values.any { it.files != null }
        val indexOk = indexReadable(variant.files) && variant.files.bytes <= MAX_FILES_INDEX_BYTES
        if (needIndex && !indexOk && variant.files.layout == "tree") {
            throw PackException(ErrorCode.filesIndexInvalid, "$packId's files index is unreadable here or over the size limit.", packId = packId)
        }
        if (needIndex && indexOk) {
            val ok = downloadInto(planId, packId, variant.files.sha256, variant.files.bytes, null)
            if (ok) {
                val staged = opts.storage.stagedObject(planId, variant.files.sha256)
                val zstd = opts.zstd
                when (val r = parseFilesIndex(readAll(staged.source()), variant.files, variant.payload, { f, s -> zstd.decode(f, s) })) {
                    is ParseFilesIndexResult.Ok -> index = r.index
                    is ParseFilesIndexResult.Refused ->
                        if (variant.files.layout == "tree") throw PackException(r.error, "$packId's files index was refused.", path = r.path, packId = packId)
                }
            } else if (variant.files.layout == "tree") {
                throw PackException(ErrorCode.networkError, "Fetching $packId's files index failed.", packId = packId)
            }
        }
        // plans/P4-19.md §2.5: a delegated release's extension rule over the files index, before any payload.
        if (delegated != null) {
            val idx = index ?: throw PackException(ErrorCode.filesIndexInvalid, "$packId's files index is required for a delegated release.", packId = packId)
            for (f in idx.files) {
                if (dataOnlyPathRefusal(f.path) != null) {
                    throw PackException(ErrorCode.packNotDataOnly, "$packId holds ${f.path}, which a delegated content key may not ship.", DataOnlyRule.extension.wire, f.path, packId)
                }
            }
        }
        // P4-11's fetch rule: the target chunk index is staged and parsed before planning.
        var chunk: ChunkContext? = null
        val chunksRef = usableChunksRef(variant)
        if ("chunk" in opts.strategies && opts.supportsRange && delegated == null && variant.files.layout == "container" &&
            chunksRef != null && opts.storage.chunkIndexes != null
        ) {
            val list = chunkSeeds(packId, installs, seeds)
            if (list.isNotEmpty()) {
                val ok = downloadInto(planId, packId, chunksRef.sha256, chunksRef.bytes, null)
                val bytes = if (ok) try {
                    readAll(opts.storage.stagedObject(planId, chunksRef.sha256).source())
                } catch (e: Exception) {
                    null
                } else null
                if (bytes != null) {
                    val zstd = opts.zstd
                    val parsed = parseChunkIndex(bytes, chunksRef, variant.payload, { f, s -> zstd.decode(f, s) })
                    if (parsed is ParseChunkIndexResult.Ok) chunk = ChunkContext(parsed.index, list)
                }
            }
        }
        // plans/P4-29.md §2.4 steps 1–2 and 6: the committed feed's menu, plus a resumed journal's own feed delta.
        var merged = withFeedDeltas(variant, opts.feedDeltas?.invoke())
        val feedIds = merged.feedIds.toHashSet()
        val fd = prior?.feedDelta
        if (prior != null && priorUsable && prior.strategy == "delta" && fd != null) {
            val again = withFeedDeltas(merged.variant, mapOf(variant.payload.sha256 to listOf(fd)))
            feedIds += again.feedIds
            merged = MergedVariant(again.variant, feedIds.toList())
        }
        var target = planTarget(merged.variant, pin.sha256, index, chunk?.index?.planIndex)
        val budget = opts.oneShotBudget
        val full = variant.full
        if (budget != null && target.full != null && full != null && !(full.codec == "zstd" && opts.zstd.canStream) && full.bytes + full.size > budget) {
            target = target.copy(full = null)
        }
        val plannerInstalled = installs.map { i ->
            PlanInstalled(
                i.recordSha256, i.payloadSha256,
                chunk?.seeds?.firstOrNull { it.location == i.location }?.seed?.index?.records?.map { it.id },
                seeds[i.location]?.files?.map { it.sha256 },
            )
        }.toMutableList()
        for (e in chunk?.seeds ?: emptyList()) {
            if (installs.none { it.location == e.location }) plannerInstalled += PlanInstalled("", "seed:" + e.payloadSha256, e.seed.index.records.map { it.id }, null)
        }
        val caps = PlanCaps(
            if (opts.supportsRange) opts.strategies else opts.strategies.filter { it != "chunk" },
            opts.patchMethods, opts.transports, opts.memBudget,
            try { opts.storage.freeDisk() } catch (e: Exception) { 0L },
        )
        val p = plan(target, plannerInstalled, caps)
        if (p is PlanResult.Error) throw PackException(p.code, "No way to install $packId: ${p.code}.", packId = packId)
        return Preflight.Plan(Planned(body, pin.sha256, record, merged.variant, installs, seeds, planId, index, p, delegated, chunk, feedIds))
    }

    /** The chunk seeds for a pack (P4-11), deduplicated by payload. Stored indexes are parsed again here. */
    private fun chunkSeeds(packId: String, own: List<PackInstall>, opened: Map<String, InstalledPayload>): List<SeedEntry> {
        val store = opts.storage.chunkIndexes ?: return emptyList()
        val d = doc ?: return emptyList()
        val others = (d.active.keys + d.previous.keys).filter { it != packId }.sortedWith { a, b -> compareUtf8Bytes(a, b) }
        val candidates = ArrayList(own)
        for (id in others) listOfNotNull(d.active[id], d.previous[id]).forEach { candidates += it }
        for (id in embedded.keys.sortedWith { a, b -> compareUtf8Bytes(a, b) }) if (id != packId) candidates += embedded.getValue(id)
        val out = ArrayList<SeedEntry>()
        val payloads = HashSet<String>()
        val locations = HashSet<String>()
        val zstd = opts.zstd
        for (i in candidates) {
            if (i.layout != "container" || i.payloadSha256 in payloads) continue
            if (i.location in locations || i.location in unverifiable) continue
            if (isRevoked(i.recordSha256)) continue
            val ref = installChunksRef(i) ?: continue
            val stored = try { store.get(ref.sha256) } catch (e: Exception) { null } ?: continue
            val parsed = parseChunkIndex(stored, ref, PackPayload(i.payloadSize, i.payloadSha256), { f, s -> zstd.decode(f, s) })
            if (parsed !is ParseChunkIndexResult.Ok) continue
            val p = opened[i.location] ?: try { opts.storage.installed(i) } catch (e: Exception) { null }
            val source = p?.payload ?: continue
            if (source.size != i.payloadSize) continue
            payloads += i.payloadSha256
            locations += i.location
            out += SeedEntry(i.location, i.payloadSha256, ChunkSeed(parsed.index, source))
        }
        return out
    }

    /** After a pack is ensured (P4-11): keep the chunk index of every root install that lacks one. Best effort. */
    private suspend fun storeSeedIndexes() {
        val store = opts.storage.chunkIndexes ?: return
        if ("chunk" !in opts.strategies || !opts.supportsRange) return
        val d = doc ?: return
        val have = (try { store.list() } catch (e: Exception) { emptyList() }).toHashSet()
        val zstd = opts.zstd
        for (i in d.active.values + d.previous.values + embedded.values) {
            if (i.layout != "container") continue
            val ref = installChunksRef(i) ?: continue
            if (ref.sha256 in have || ref.sha256 in seedIndexTried) continue
            seedIndexTried += ref.sha256
            val res = try {
                opts.fetchObject(ObjectRequest(ref.sha256, 0, null))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                continue
            }
            if (res.status != 200) {
                res.body.close()
                continue
            }
            val stored = java.io.ByteArrayOutputStream()
            var over = false
            try {
                while (true) {
                    val c = res.body.next() ?: break
                    if (stored.size() + c.size > ref.bytes) {
                        over = true
                        break
                    }
                    stored.write(c)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                continue
            } finally {
                res.body.close()
            }
            if (over || stored.size().toLong() != ref.bytes) continue
            val bytes = stored.toByteArray()
            val parsed = parseChunkIndex(bytes, ref, PackPayload(i.payloadSize, i.payloadSha256), { f, s -> zstd.decode(f, s) })
            if (parsed !is ParseChunkIndexResult.Ok) continue
            try {
                store.put(ref.sha256, bytes)
                have += ref.sha256
            } catch (e: Exception) {
                // Best effort.
            }
        }
    }

    /** The chunk strategy (P4-11): `applyChunk` over the staged index, resumed from the run journal. */
    private suspend fun applyChunkPlan(planId: String, packId: String, variant: PackVariant, chunk: ChunkContext, total: Long): ChunkVerdict {
        val ref = usableChunksRef(variant)
        if (ref == null || variant.files.layout != "container") return ChunkVerdict.Failed(ErrorCode.chunksRefMismatch)
        val storage = opts.storage
        val out = storage.output(planId, "container", resume = true)
        val sink = out.sink
        val read = out.read
        if (sink == null || read == null) return ChunkVerdict.Failed(ErrorCode.chunksRefMismatch)
        val seeds = chunk.seeds.map { it.seed }
        val seeded = HashSet<String>()
        seeds.forEach { s -> s.index.records.forEach { seeded += it.id } }
        val runs = chunkRuns(chunk.index.records) { it in seeded }.size
        val journal = storage.runJournal
        val done = readRunJournal(try { journal?.read(planId) } catch (e: Exception) { null }, ref.sha256, runs).toHashSet()
        val base = ref.bytes
        emit(PackProgress(packId, "download", minOf(base, total), total))
        val r = applyChunk(
            variant, seeds,
            ApplyChunkPorts(
                objects = { sha256 ->
                    val o = storage.stagedObject(planId, sha256)
                    if (o.size() > 0) o.source() else null
                },
                zstd = opts.zstd,
                fetchRange = chunkRangeFetch(opts.fetchObject),
                output = object : ChunkOutput {
                    override fun write(offset: Long, bytes: ByteArray) = sink.write(offset, bytes)
                    override fun read(offset: Long, length: Int): ByteArray = read(offset, length)
                },
            ),
            repair = true,
            completedRuns = done.toSet(),
            onRunDone = { k ->
                done += k
                try {
                    journal?.write(planId, writeRunJournal(ref.sha256, runs, done))
                } catch (e: Exception) {
                    // Best effort: a journal that cannot be written only costs refetching.
                }
            },
            onProgress = { fetched -> emit(PackProgress(packId, "download", minOf(total, base + fetched), total)) },
        )
        return r.verdict
    }

    /** Keep a chunk plan's staged target index in the seed store (best effort). */
    private fun keepStagedIndex(planId: String, variant: PackVariant) {
        val store = opts.storage.chunkIndexes ?: return
        val ref = usableChunksRef(variant) ?: return
        try {
            val o = opts.storage.stagedObject(planId, ref.sha256)
            if (o.size() != ref.bytes) return
            store.put(ref.sha256, readAll(o.source()))
        } catch (e: Exception) {
            // Best effort.
        }
    }

    /** §2.4's delegated surface: never the stamp's pin or hold for the pack, never a revocation's replacement. */
    private fun delegatedAllowed(packId: String, sha256: String): Boolean {
        if (opts.stamp?.pins?.any { it.pack == packId && it.sha256 == sha256 } == true) return false
        if (opts.holds.any { it.pack == packId && it.release.sha256 == sha256 }) return false
        if (revVerified.values.any { it.replacement?.sha256 == sha256 }) return false
        return true
    }

    /** A delegation record by hash: this process's copy, else fetched (at most `MAX_DELEGATIONS_PER_CHECK` per call). */
    private suspend fun fetchDelegation(packId: String, hash: String): String {
        delegationBodies[hash]?.let { return it }
        if (delegationBudget <= 0) {
            throw PackException(ErrorCode.networkError, "$packId's delegation was not fetched: this call reached its delegation bound; the next one retries.", "delegation", packId = packId)
        }
        delegationBudget--
        return when (val f = opts.fetchRecord(hash)) {
            is RecordFetchResult.Failed -> throw PackException(f.code, "Fetching $packId's delegation failed (${f.code}).", "delegation", packId = packId)
            is RecordFetchResult.Ok -> {
                if (recordHash(f.body) == hash) delegationBodies[hash] = f.body
                f.body
            }
        }
    }

    private suspend fun ensureOne(packId: String, target: ReleasePin?): PackInstall {
        try {
            val install = ensureOneInner(packId, target)
            storeSeedIndexes()
            return install
        } catch (e: PackException) {
            // plans/P4-13.md §2.5: an embedded baseline refused for `relearn` that cannot be fetched.
            val want = target?.sha256 ?: opts.stamp?.pins?.firstOrNull { it.pack == packId }?.sha256
            val emb = embedded[packId]
            if (e.code != ErrorCode.packRevoked && emb != null && emb.recordSha256 == want && !isRevoked(emb.recordSha256) && embeddedRefused(emb)) {
                throw PackException(
                    ErrorCode.packRevoked,
                    "$packId's embedded copy is refused until a fresh feed re-teaches its revocations, and it cannot be fetched (${e.code}).",
                    "relearn", packId = packId,
                )
            }
            throw e
        }
    }

    private suspend fun ensureOneInner(packId: String, target: ReleasePin?): PackInstall {
        val pre = when (val p = preflight(packId, target)) {
            is Preflight.Current -> {
                val current = p.install
                if (current.embedded != true && !running.containsKey(packId) && current.activation == "hot") activate(current)
                return current
            }
            is Preflight.Plan -> p.planned
        }
        val variant = pre.variant
        preflightPlans.remove(packId)
        val candidates: List<PlanCandidate> = when (val plan = pre.plan) {
            is PlanResult.Chosen -> {
                if (plan.candidate.strategy == "noop") {
                    val same = pre.installs.first { it.payloadSha256 == variant.payload.sha256 }
                    // Amendment A1: a delegated release reusing an install re-sniffs that install's files.
                    if (pre.delegation != null) {
                        val files = pre.seeds[same.location]?.files
                            ?: throw PackException(ErrorCode.packNotDataOnly, "$packId's reused install cannot be re-checked by the data-only rule.", DataOnlyRule.content.wire, packId = packId)
                        for (f in files) {
                            val rule = dataOnlyFileRefusal(f.path, readAll(f.source))
                            if (rule != null) {
                                throw PackException(ErrorCode.packNotDataOnly, "$packId holds ${f.path}, which a delegated content key may not ship (${rule.wire}).", rule.wire, f.path, packId)
                            }
                        }
                    }
                    return commit(packId, pre.body, pre.recordSha256, pre.record, variant, same.location, pre.planId, true, pre.delegation)
                }
                listOf(plan.candidate) + plan.fallbacks
            }
            is PlanResult.Platform -> throw PackException(ErrorCode.planTransportUnsupported, "$packId is platform-bound.", packId = packId)
            is PlanResult.Error -> throw PackException(plan.code, "No way to install $packId: ${plan.code}.", packId = packId)
        }

        // 5–6. Each candidate in turn. plans/P4-29.md §2.4 step 5: at most one feed-offered delta.
        var firstFailure: PackException? = null
        var feedTried = false
        for (cand in candidates) {
            val fromFeed = cand.strategy == "delta" && cand.delta != null && cand.delta in pre.feedIds
            if (fromFeed && feedTried) continue
            val feedDelta = if (fromFeed) feedEntryOf(variant, cand.delta!!) else null
            if (fromFeed && feedDelta == null) continue
            if (fromFeed) feedTried = true
            val objects: List<Pair<String, Long>> = (
                if (cand.strategy == "chunk") {
                    if (pre.chunk != null && pre.delegation == null) usableChunksRef(variant)?.let { listOf(it.sha256 to it.bytes) } else null
                } else {
                    objectsFor(cand.strategy, cand.delta, variant, pre.index, pre.seeds)
                }
                ) ?: continue
            val journal = PackJournal(
                pre.planId, packId, pre.body, pre.recordSha256, variantKey(variant.variant), cand.strategy, cand.delta,
                objects.map { JournalObject(it.first, it.second, 0) }, opts.now(), pre.delegation, feedDelta,
            )
            doc = beginInstall(requireLoaded(), journal)
            persist()
            val total = if (cand.strategy == "chunk") maxOf(cand.bytes, objects.firstOrNull()?.second ?: 0) else objects.sumOf { it.second }
            val progress = Progress(0, total)
            emit(PackProgress(packId, "download", 0, total))
            var fetched = true
            for (o in objects) {
                if (!downloadInto(pre.planId, packId, o.first, o.second, progress)) {
                    // A feed delta that cannot be fetched falls back like any other failure of that candidate.
                    if (fromFeed) {
                        fetched = false
                        break
                    }
                    throw PackException(ErrorCode.networkError, "Fetching $packId's objects failed; the next ensure resumes.", packId = packId)
                }
            }
            val result: ApplyResult
            var refusal: DataOnlyRefusalSeen? = null
            val chunkCtx = pre.chunk
            if (!fetched) {
                result = ApplyResult(ApplyVerdict.Failed(ErrorCode.networkError))
            } else if (cand.strategy == "chunk" && chunkCtx != null) {
                val v = applyChunkPlan(pre.planId, packId, variant, chunkCtx, total)
                emit(PackProgress(packId, "apply", total, total))
                result = when (v) {
                    is ChunkVerdict.Ok -> {
                        keepStagedIndex(pre.planId, variant)
                        ApplyResult(ApplyVerdict.Container(v.counters.sha256, v.counters.size))
                    }
                    is ChunkVerdict.Failed -> {
                        if (v.error == ErrorCode.networkError && v.detail == "interrupted") {
                            throw PackException(ErrorCode.networkError, "Fetching $packId's chunks failed; the next ensure resumes.", "chunk", packId = packId)
                        }
                        ApplyResult(ApplyVerdict.Failed(v.error))
                    }
                }
            } else {
                emit(PackProgress(packId, "apply", total, total))
                val applied = apply(pre.planId, packId, cand.strategy, cand.delta, variant, pre.seeds, pre.delegation != null)
                result = applied.first
                refusal = applied.second
            }
            if (refusal != null) {
                doc = abandonInstall(requireLoaded(), packId)
                persist()
                try {
                    opts.storage.removeStaging(pre.planId)
                } catch (e: Exception) {
                    // Collected later.
                }
                throw PackException(
                    ErrorCode.packNotDataOnly,
                    "$packId holds ${refusal.path}, which a delegated content key may not ship (${refusal.rule.wire}).",
                    refusal.rule.wire, refusal.path, packId,
                )
            }
            if (result.verdict.ok) {
                val location = opts.storage.commit(pre.planId, packId, variant.payload.sha256, variant.files.layout, result.index ?: pre.index)
                typeCheck(packId, pre.record, variant, location, pre.planId, pre.delegation)
                val install = commit(packId, pre.body, pre.recordSha256, pre.record, variant, location, pre.planId, false, pre.delegation)
                emit(PackProgress(packId, "done", total, total))
                return install
            }
            val failed = result.verdict as ApplyVerdict.Failed
            if (firstFailure == null) {
                firstFailure = PackException(failed.error, "Installing $packId by ${cand.strategy} failed: ${failed.error}.", cand.strategy, failed.path, packId)
            }
            try {
                opts.storage.removeStaging(pre.planId)
            } catch (e: Exception) {
                // Collected later.
            }
        }
        doc = abandonInstall(requireLoaded(), packId)
        persist()
        try {
            opts.storage.removeStaging(pre.planId)
        } catch (e: Exception) {
            // Collected later.
        }
        throw firstFailure ?: PackException(ErrorCode.planNoStrategy, "No way to install $packId.", packId = packId)
    }

    /** The objects a strategy fetches, in order; null when the strategy cannot run here. */
    private fun objectsFor(strategy: String, delta: String?, variant: PackVariant, index: FilesIndexDoc?, seeds: Map<String, InstalledPayload>): List<Pair<String, Long>>? {
        val files = variant.files
        val idx = files.sha256 to files.bytes
        val gaps = if (files.layout == "container") files.gaps?.let { listOf(it.sha256 to it.bytes) } ?: emptyList() else emptyList()
        return when (strategy) {
            "full" -> {
                val full = variant.full ?: return null
                if (files.layout == "tree") listOf(idx, full.sha256 to full.bytes) else listOf(full.sha256 to full.bytes)
            }
            "delta" -> when (val d = variant.deltas.firstOrNull { it.id != null && it.id == delta }) {
                is PackDelta.Payload -> listOf(d.artifact.sha256 to d.artifact.bytes)
                is PackDelta.Files -> listOf(idx) + gaps + listOf(d.patch.sha256 to d.patch.bytes, d.data.sha256 to d.data.bytes)
                else -> null
            }
            "file" -> {
                val i = index ?: return null
                val held = HashSet<String>()
                seeds.values.forEach { s -> s.files?.forEach { held += it.sha256 } }
                val blobs = ArrayList<Pair<String, Long>>()
                val seen = HashSet<String>()
                for (f in i.files) if (f.sha256 !in held && seen.add(f.blob.sha256)) blobs += f.blob.sha256 to f.blob.bytes
                listOf(idx) + gaps + blobs
            }
            else -> null
        }
    }

    private fun apply(
        planId: String,
        packId: String,
        strategy: String,
        delta: String?,
        variant: PackVariant,
        seeds: Map<String, InstalledPayload>,
        dataOnly: Boolean,
    ): Pair<ApplyResult, DataOnlyRefusalSeen?> {
        val out = opts.storage.output(planId, variant.files.layout)
        var tree = out.tree
        var guarded: DataOnlyTreeSink? = null
        if (dataOnly && tree != null) {
            guarded = DataOnlyTreeSink(tree)
            tree = guarded
        }
        val result = applyWith(planId, packId, strategy, delta, variant, seeds, PackOutput(out.sink, tree))
        return result to guarded?.seen
    }

    private fun applyWith(
        planId: String,
        packId: String,
        strategy: String,
        delta: String?,
        variant: PackVariant,
        seeds: Map<String, InstalledPayload>,
        out: PackOutput,
    ): ApplyResult {
        val storage = opts.storage
        val objects: ObjectPort = { sha256 ->
            val o = storage.stagedObject(planId, sha256)
            if (o.size() > 0 || sha256 == EMPTY_SHA256) o.source() else null
        }
        val ports = ApplyPorts(objects, opts.zstd, out.sink, out.tree)
        if (strategy == "full") return applyFull(variant, ports)
        val installed = seeds.values.flatMap { it.files ?: emptyList() }
        if (strategy == "file") return applyFile(variant, null, installed, ports)
        val k = variant.deltas.indexOfFirst { it.id != null && it.id == delta }
        if (k < 0) return ApplyResult(ApplyVerdict.Failed(ErrorCode.deltaArtifactMismatch))
        if (variant.deltas[k] is PackDelta.Files) return applyFile(variant, k, installed, ports)
        var base: ByteSource? = null
        for (i in installsOf(packId)) {
            if (base == null && i.payloadSha256 == variant.deltas[k].from) base = seeds[i.location]?.payload
        }
        val b = base ?: return ApplyResult(ApplyVerdict.Failed(ErrorCode.deltaBaseMismatch))
        return applyDelta(variant, k, b, ports)
    }

    /** The handler's type check over a newly staged payload now in the store (P4-16). */
    private suspend fun typeCheck(packId: String, record: PackRecordDoc, variant: PackVariant, location: String, planId: String, delegation: String?) {
        val h = handler(record.type) ?: return
        val provisional = PackInstall(
            packId, "", "", record.version, record.seq, record.type, variantKey(variant.variant), variant.files.layout,
            variant.payload.sha256, variant.payload.size, activationOf(record, h), location, null, opts.now(), delegation,
        )
        val refusal: PackCheckRefusal? = try {
            val got = opts.storage.installed(provisional)
            if (got != null) {
                val p = sortedPayload(got)
                h.check(StagedPack(packId, record, variant, location, p.files ?: emptyList(), p.payload))
            } else {
                PackCheckRefusal("unreadable", message = "the stored payload cannot be read back")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            PackCheckRefusal("check", message = e.toString())
        }
        val r = refusal ?: return
        val detail = if (isPackToken(r.detail)) r.detail else "check"
        doc = abandonInstall(requireLoaded(), packId)
        persist()
        try {
            opts.storage.removeStaging(planId)
        } catch (e: Exception) {
            // Collected later.
        }
        collect()
        val at = r.path?.let { ", $it" } ?: ""
        val tail = r.message?.let { ": $it" } ?: "."
        throw PackException(ErrorCode.packTypeCheckFailed, "$packId failed its ${record.type} check ($detail$at)$tail", detail, r.path, packId)
    }

    /** Commit: the pointer swap, activation, garbage collection. */
    private suspend fun commit(
        packId: String,
        recordJws: String,
        recordSha256: String,
        record: PackRecordDoc,
        variant: PackVariant,
        location: String,
        stagingPlan: String,
        reused: Boolean,
        delegation: String?,
    ): PackInstall {
        val install = PackInstall(
            packId, recordJws, recordSha256, record.version, record.seq, record.type, variantKey(variant.variant), variant.files.layout,
            variant.payload.sha256, variant.payload.size, activationOf(record, handler(record.type)), location,
            if (embedded[packId]?.location == location) true else null, opts.now(), delegation,
        )
        val carried = deferredActive[packId]
        deferredActive = deferredActive - packId
        deferredPrevious = deferredPrevious - packId
        val before = running[packId]
        var next = commitInstall(requireLoaded(), install)
        if (carried != null && carried.recordSha256 != install.recordSha256) {
            next = next.copy(previous = next.previous + (packId to carried))
            unverifiedPrevious += packId
        } else {
            unverifiedPrevious -= packId
        }
        doc = next
        persist()
        if (!reused) {
            try {
                opts.storage.removeStaging(stagingPlan)
            } catch (e: Exception) {
                // Collected later.
            }
        }
        if (install.activation == "hot") {
            val h = handler(record.type)
            if (before != null && before.location != location && h != null) h.deactivate(before)
            activate(install)
        }
        collect()
        return install
    }

    /** Remove every stored location and staging area no root holds. */
    private fun collect() {
        if (gcHold) return
        val d = doc ?: return
        val roots = gcRoots(d, embedded.values + running.values)
        val locations = roots.locations + unverifiable
        val listed = try {
            opts.storage.list()
        } catch (e: Exception) {
            return
        }
        val held = holdSnapshot
        for (loc in listed.first) {
            if (loc !in locations && held?.first?.contains(loc) != true) {
                try {
                    opts.storage.remove(loc)
                } catch (e: Exception) {
                    // Next time.
                }
            }
        }
        for (plan in listed.second) {
            if (plan !in roots.plans && held?.second?.contains(plan) != true) {
                try {
                    opts.storage.removeStaging(plan)
                } catch (e: Exception) {
                    // Next time.
                }
            }
        }
        // P4-11: a stored seed index no root install's record names goes too.
        val store = opts.storage.chunkIndexes ?: return
        val stored = try { store.list() } catch (e: Exception) { return }
        val keep = HashSet<String>()
        val installs = d.active.values + d.previous.values + deferredActive.values + deferredPrevious.values + embedded.values + running.values
        for (i in installs) installChunksRef(i)?.let { keep += it.sha256 }
        for (sha in stored) {
            if (sha !in keep) {
                try {
                    store.remove(sha)
                } catch (e: Exception) {
                    // Next time.
                }
            }
        }
    }

    /**
     * Stage one object: resume from what is staged (re-hashed, never trusted), fetch the rest with
     * `Range` and `If-Range`, checkpoint the journal. True when the staged object then has the ref's
     * length and SHA-256; a mismatch resets it and refetches once.
     */
    private suspend fun downloadInto(planId: String, packId: String, sha256: String, bytes: Long, progress: Progress?): Boolean {
        val staged = try {
            opts.storage.stagedObject(planId, sha256)
        } catch (e: Exception) {
            return false
        }
        repeat(2) {
            try {
                var have = staged.size()
                if (have > bytes) {
                    staged.reset()
                    have = 0
                }
                val hasher = PackHasher()
                if (have > 0) {
                    val src = staged.source()
                    var at = 0L
                    while (at < have) {
                        val chunk = src.read(at, minOf(READ_CHUNK.toLong(), have - at).toInt())
                        if (chunk.isEmpty()) break
                        hasher.update(chunk)
                        at += chunk.size
                    }
                }
                val counted = if (progress != null) have else 0
                if (progress != null) {
                    progress.done += counted
                    emit(PackProgress(packId, "download", progress.done, progress.total))
                }
                val outcome: FetchOutcome
                if (have < bytes) {
                    val res = try {
                        opts.fetchObject(ObjectRequest(sha256, have, if (have > 0) "\"$sha256\"" else null))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        return false
                    }
                    outcome = if (res.status == 200 && have > 0) {
                        // The validator moved, so the server sent the whole object: start over.
                        if (progress != null) progress.done -= counted
                        staged.reset()
                        fetchInto(staged, res, sha256, bytes, PackHasher(), 0, planId, packId, progress)
                    } else if (res.status == 206 && have > 0 && rangeStartsAt(res.contentRange, have)) {
                        fetchInto(staged, res, sha256, bytes, hasher, have, planId, packId, progress)
                    } else if (res.status == 200) {
                        fetchInto(staged, res, sha256, bytes, hasher, 0, planId, packId, progress)
                    } else {
                        res.body.close()
                        return false
                    }
                } else {
                    outcome = if (hasher.digest() == sha256) FetchOutcome.ok else FetchOutcome.mismatch
                }
                when (outcome) {
                    FetchOutcome.ok -> return true
                    FetchOutcome.interrupted -> return false
                    FetchOutcome.mismatch -> {
                        if (progress != null) progress.done -= minOf(try { staged.size() } catch (e: Exception) { 0L }, bytes)
                        staged.reset()
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return false
            }
        }
        return false
    }

    private suspend fun fetchInto(
        staged: StagedObject,
        res: ObjectResponse,
        sha256: String,
        bytes: Long,
        hasher: PackHasher,
        from: Long,
        planId: String,
        packId: String,
        progress: Progress?,
    ): FetchOutcome {
        var have = from
        var sinceCheckpoint = 0L
        val every = opts.checkpointBytes
        fun save() {
            val d = doc ?: return
            if (d.inflight[packId]?.planId != planId) return
            doc = checkpoint(d, packId, sha256, have)
            persist()
        }
        try {
            while (true) {
                val chunk = res.body.next() ?: break
                if (have + chunk.size > bytes) return FetchOutcome.mismatch
                hasher.update(chunk)
                staged.append(chunk)
                have += chunk.size
                sinceCheckpoint += chunk.size
                if (progress != null) {
                    progress.done += chunk.size
                    emit(PackProgress(packId, "download", progress.done, progress.total))
                }
                if (sinceCheckpoint >= every) {
                    sinceCheckpoint = 0
                    save()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            try {
                save()
            } catch (x: Exception) {
                // Best effort.
            }
            return FetchOutcome.interrupted
        } finally {
            res.body.close()
        }
        try {
            save()
        } catch (e: Exception) {
            return FetchOutcome.interrupted
        }
        return if (have == bytes && hasher.digest() == sha256) FetchOutcome.ok else FetchOutcome.mismatch
    }
}

/** plans/P4-29.md §2.4 step 6: whether a journal's `delta` is one the record or its own `feedDelta` names. */
private fun journalDeltaKnown(j: PackJournal, variant: PackVariant): Boolean {
    if (j.strategy != "delta") return true
    val delta = j.delta ?: return true
    if (variant.deltas.any { it.id == delta }) return true
    return j.feedDelta?.artifactSha256 == delta
}

/** The merged feed entry of a planned feed delta, as the journal keeps it. */
private fun feedEntryOf(variant: PackVariant, id: String): FeedDelta? {
    for (d in variant.deltas) if (d is PackDelta.Payload && d.artifact.sha256 == id) return FeedDelta(d.from, d.method, d.memBytes, d.artifact.sha256, d.artifact.bytes)
    return null
}

private fun rangeStartsAt(contentRange: String?, offset: Long): Boolean {
    val cr = contentRange?.trim() ?: return false
    val m = Regex("bytes ([0-9]+)-[0-9]+/[0-9]+").matchEntire(cr) ?: return false
    return m.groupValues[1].toLongOrNull() == offset
}

/** A record's activation, else its handler's default. */
internal fun activationOf(record: PackRecordDoc, handler: PackHandler?): String {
    val a = record.activation
    if (a == "hot" || a == "restart") return a
    return handler?.activation ?: "restart"
}

/** The delegation hash of a delegated install, or null for a release-signed one. */
private fun installDelegation(i: PackInstall): String? = if (i.delegation != null) delegationHashOf(i.record) else null

// ── P4-11 chunk helpers ─────────────────────────────────────────────────────────────────────────

/** A variant's `chunks` ref when the chunk strategy could read it, else null. */
internal fun usableChunksRef(variant: PackVariant): PackObjectRef? {
    val c = variant.chunks ?: return null
    if (c.format != im.plrs.key.core.CHUNKS_FORMAT || !usableCodec(c.ref.codec)) return null
    if (c.ref.bytes < 0 || c.ref.size < 0 || c.ref.bytes > im.plrs.key.core.MAX_CHUNK_INDEX_BYTES || c.ref.size > im.plrs.key.core.MAX_CHUNK_INDEX_BYTES) return null
    return c.ref
}

/** The usable `chunks` ref of an install's own variant, read from its (verified) record. */
internal fun installChunksRef(i: PackInstall): PackObjectRef? {
    val rec = PackRecordDoc.from(verifiedPayloadOf(i.record)) ?: return null
    val v = rec.variants.firstOrNull { variantKey(it.variant) == i.variant } ?: return null
    if (v.payload.sha256 != i.payloadSha256) return null
    return usableChunksRef(v)
}

/**
 * The run journal (P4-11): which runs of a chunk plan are complete. Ignored (empty) unless `v == 1`,
 * `index` is this plan's chunk index, `runs` is this plan's run count and the bitmap is
 * `ceil(runs / 8)` bytes of lowercase hex.
 */
public fun readRunJournal(text: String?, index: String, runs: Int): Set<Int> {
    if (text == null) return emptySet()
    val o = parseJson(text).objectValue ?: return emptySet()
    val bytes = (runs + 7) / 8
    if (o["v"].longValue != 1L) return emptySet()
    if (o["index"].stringValue != index || o["runs"].longValue != runs.toLong()) return emptySet()
    val bitmap = o["bitmap"].stringValue ?: return emptySet()
    if (bitmap.length != bytes * 2 || !bitmap.all { it in '0'..'9' || it in 'a'..'f' }) return emptySet()
    val bits = hexBytes(bitmap)
    if (bits.size != bytes) return emptySet()
    val done = HashSet<Int>()
    for (k in 0 until runs) if ((bits[k shr 3].toInt() and (1 shl (k and 7))) != 0) done += k
    return done
}

/** The run journal's text for [done]. */
public fun writeRunJournal(index: String, runs: Int, done: Set<Int>): String {
    val bits = ByteArray((runs + 7) / 8)
    for (k in done) if (k in 0 until runs) bits[k shr 3] = (bits[k shr 3].toInt() or (1 shl (k and 7))).toByte()
    return canonicalJson(
        buildJsonObject {
            put("v", im.plrs.key.core.jsonInt(1))
            put("index", JsonPrimitive(index))
            put("runs", im.plrs.key.core.jsonInt(runs.toLong()))
            put("bitmap", JsonPrimitive(hexString(bits)))
        },
    )
}
