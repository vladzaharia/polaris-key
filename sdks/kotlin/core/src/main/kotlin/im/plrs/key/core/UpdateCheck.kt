// `update.decide()`'s shared core — plans/P3-01.md §2.5 steps 2–18 and "After a refusal", with
// plans/P4-13.md §2.5's content steps 10–14 and plans/P4-19.md §2.7's delegation entries. Ported by
// P6-08 from Swift's `UpdateCheck.swift`; client-core's `check.ts` is the reference.
//
// Every SDK must behave the same after a refusal, so the order, the fallback and the error map live
// here once for Kotlin. The function does no I/O of its own: the caller hands it the two fetches
// (the feed for a requested channel, a record by hash) and the cache slices, and gets back the
// `UpdateCheck` plus the slices to write. Step 1 (discovery), the options refusals
// (`not-configured`, `invalid-options`) and the write itself stay with the update client (:update).
// It never throws: a failure with nothing to decide from comes back as `Failed`.

package im.plrs.key.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** One fetch's outcome: a body, or `network-error` / the Worker's wire code. */
public sealed interface FetchOutcome {
    public data class Ok(val body: String) : FetchOutcome
    public data class Failed(val code: String) : FetchOutcome
}

/** One entry of `UpdateCheck.errors` (§2.5's error map). */
public data class UpdateCheckError(val code: String, val detail: String? = null) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("code", JsonPrimitive(code))
            put("detail", detail?.let { JsonPrimitive(it) } ?: JsonNull)
        }
}

/** What the update client's `decide()` answers (§2.5 "After a refusal"). */
public data class UpdateCheck(
    /** The canonical channel: the `channel` claim of the feed the decision used. */
    val channel: String,
    val decision: UpdateDecision,
    val feed: FeedSource,
    val record: RecordSource,
    val errors: List<UpdateCheckError>,
) {
    /** Where the decision's feed came from. */
    public enum class FeedSource(public val wire: String) { network("network"), committed("committed") }

    /** Where the decision's record came from. */
    public enum class RecordSource(public val wire: String) { network("network"), cache("cache"), none("none") }

    /** The stage machine's `decide.done` for the decision. */
    val boot: BootEvent.Decision get() = bootDecision(decision)

    /** The `UpdateCheck` as the transcripts spell it. */
    public val json: JsonObject
        get() = buildJsonObject {
            put("channel", JsonPrimitive(channel))
            put("decision", decision.json)
            put("feed", JsonPrimitive(feed.wire))
            put("record", JsonPrimitive(record.wire))
            put("errors", JsonArray(errors.map { it.json }))
        }
}

/** [runUpdateCheck]'s inputs. */
public data class UpdateCheckInput(
    /** The channel name the host REQUESTED (it may be an alias, such as `latest`). */
    val channel: String,
    val expectedAud: String,
    /** The EFFECTIVE product trust set. */
    val trust: TrustSet,
    /** `pinnedReleaseKeys`: never empty here. */
    val releaseKeys: TrustSet,
    /** The effective clock, `max(system, highWaterMark)`. */
    val now: Long,
    /** The device id (`X-PKey-Device`): the rollout bucket's install id. Null leaves the bucket null. */
    val installId: String?,
    val installed: InstalledBuild,
    val outlet: UpdateOutlet,
    val subkind: String?,
    val staged: StagedUpdate? = null,
    val skipVersion: String? = null,
    val methods: List<String>,
    /** The `feeds` slice as stored. Each entry is re-verified here (the reload path). */
    val feeds: Map<String, String>,
    /** The `releaseRecords` slice as stored. */
    val releaseRecords: Map<String, String>,
    /** The content decision's inputs (plans/P4-13.md §2.5 steps 10–14). Null: no content decision. */
    val content: UpdateCheckContent? = null,
)

/** What a host with packs hands the update check (plans/P4-13.md §2.5, §2.6). */
public class UpdateCheckContent(
    /** The running build's content stamp, with its holds (null when unusable). */
    public val stamp: UpdateContentStamp,
    /** The pack state's active installs, embedded baselines included, by pack id. */
    public val active: Map<String, ReleasePin>,
    /** The host's engine (`godot-<major>.<minor>`, null outside Godot). */
    public val engine: String?,
    public val axes: Map<String, List<String>>,
    /** The stored, verified revocations, by target. */
    public val revoked: Map<String, VerifiedRevocation>,
    /** Packs whose revocations must be re-learned. */
    public val relearn: List<String> = emptyList(),
    /** Whether a verified replacement record has a variant for this host. */
    public val selectsVariant: (variants: List<JsonElement>) -> Boolean,
    /** The delegated releases the pack engine knows: record hash → its pack and delegation hash. */
    public val delegated: Map<String, DelegatedRelease> = emptyMap(),
)

/** A revocation this check fetched and verified, with its compact JWS, to store. */
public data class LearnedRevocation(val revocation: VerifiedRevocation, val jws: String)

/** With `content`: the revocations a check learned and the packs whose `relearn` it cleared. */
public data class UpdateCheckRevocations(val learned: List<LearnedRevocation>, val relearnCleared: List<String>)

/** A completed run: the answer, the verified documents it used, and the slices to write back. */
public data class UpdateCheckRun(
    val check: UpdateCheck,
    val feed: ChannelFeedDoc,
    val record: ReleaseRecordDoc?,
    val feeds: Map<String, String>,
    val releaseRecords: Map<String, String>,
    val revocations: UpdateCheckRevocations?,
)

public sealed interface UpdateCheckOutcome {
    public data class Ok(val run: UpdateCheckRun) : UpdateCheckOutcome

    /** Nothing to decide from: the error to raise. */
    public data class Failed(val error: UpdateCheckError) : UpdateCheckOutcome
}

/** The step-3–8 refusal's entry in `errors`, or null for `not-newer` (nothing is reported). */
private fun feedError(reason: FeedRefusal): UpdateCheckError? = when (reason) {
    FeedRefusal.notNewer -> null
    FeedRefusal.rollback -> UpdateCheckError(ErrorCode.feedRollback)
    else -> UpdateCheckError(ErrorCode.feedRejected, reason.wire)
}

/**
 * Steps 2–18 of plans/P3-01.md §2.5, with its refusal rules: the committed feeds re-verified first
 * (the reload path, which gives the floors); a fetched body equal to a committed feed step 5 binds
 * to the request changes nothing; otherwise the fetched feed is verified and, when accepted,
 * committed under its claim; after a transport failure, `not-newer` or a refusal, the decision uses
 * the first committed feed among `feeds[claim]`, `feeds[requested]` and the alias target; the record
 * comes from the cache or the network, hash before signature.
 */
public suspend fun runUpdateCheck(
    input: UpdateCheckInput,
    fetchFeed: suspend (String) -> FetchOutcome,
    fetchRecord: suspend (String) -> FetchOutcome,
): UpdateCheckOutcome {
    val requested = input.channel
    val platform = input.installed.platform
    val errors = ArrayList<UpdateCheckError>()

    val committed = reloadFeeds(input.feeds, input.trust, input.expectedAud, platform)
    var feeds: Map<String, String> = committed.feeds.mapValues { it.value.jws }
    val feedDocs = LinkedHashMap(committed.feeds.mapValues { it.value.feed })

    fun fallback(claim: String?): CommittedFeed? {
        for (k in listOfNotNull(claim) + boundChannels(requested)) committed.feeds[k]?.let { return it }
        return null
    }

    // Steps 2–9.
    val feed: ChannelFeedDoc
    var feedSource = UpdateCheck.FeedSource.network
    when (val fetched = fetchFeed(requested)) {
        is FetchOutcome.Ok -> {
            val body = fetched.body
            val same = boundChannels(requested).mapNotNull { committed.feeds[it] }.firstOrNull { it.jws == body }
            if (same != null) {
                feed = same.feed
            } else {
                when (val v = verifyFeed(body, VerifyFeedOptions(input.trust, input.expectedAud, requested, platform, input.now, true, committed.floors))) {
                    is VerifyFeedResult.Ok -> {
                        feed = v.feed
                        feeds = commitFeed(feeds, requested, v.feed.channel, body)
                        if (v.feed.channel != requested) feedDocs.remove(requested)
                        feedDocs[v.feed.channel] = v.feed
                    }
                    is VerifyFeedResult.Refused -> {
                        val error = feedError(v.reason)
                        val prior = fallback(v.channel)
                            ?: return UpdateCheckOutcome.Failed(error ?: UpdateCheckError(ErrorCode.feedRejected, v.reason.wire))
                        if (error != null) errors += error
                        feed = prior.feed
                        feedSource = UpdateCheck.FeedSource.committed
                    }
                }
            }
        }
        is FetchOutcome.Failed -> {
            val prior = fallback(null) ?: return UpdateCheckOutcome.Failed(UpdateCheckError(fetched.code))
            errors += UpdateCheckError(fetched.code)
            feed = prior.feed
            feedSource = UpdateCheck.FeedSource.committed
        }
    }

    // Steps 10–16.
    val target = feedTarget(feed.app.targets, platform)
    var record: ReleaseRecordDoc? = null
    var recordSource = UpdateCheck.RecordSource.none
    var recordJws: String? = null
    if (target != null) {
        val pin = target.release
        val opts = VerifyReleaseRecordOptions(
            input.releaseKeys, input.trust, input.expectedAud, pin.sha256,
            ReleaseRecordPin(deliverable = "app", version = pin.version, seq = pin.seq),
        )
        val cached = input.releaseRecords[pin.sha256]
        if (cached != null) {
            verifyReleaseRecord(cached, opts).record?.let {
                record = it
                recordSource = UpdateCheck.RecordSource.cache
                recordJws = cached
            }
        }
        if (record == null) {
            when (val fetched = fetchRecord(pin.sha256)) {
                is FetchOutcome.Failed -> errors += UpdateCheckError(fetched.code)
                is FetchOutcome.Ok -> when (val r = verifyReleaseRecord(fetched.body, opts)) {
                    is VerifyReleaseRecordResult.Ok -> {
                        record = r.record
                        recordSource = UpdateCheck.RecordSource.network
                        recordJws = fetched.body
                    }
                    is VerifyReleaseRecordResult.Refused ->
                        errors += if (r.step == ReleaseRecordStep.crossCheck) {
                            UpdateCheckError(ErrorCode.recordMismatch)
                        } else {
                            UpdateCheckError(ErrorCode.recordRejected, r.step.wire)
                        }
                    // An app record never takes the delegated path (plans/P4-19.md §2.4): no
                    // delegation is passed here, so this does not occur.
                    is VerifyReleaseRecordResult.Delegated -> errors += UpdateCheckError(ErrorCode.recordRejected, "jws")
                }
            }
        }
    }

    // A record is kept only while a committed feed's target for this platform pins it.
    val pinned = feedDocs.values.mapNotNull { feedTarget(it.app.targets, platform)?.release?.sha256 }.toSet()
    val candidates = LinkedHashMap(input.releaseRecords)
    val rj = recordJws
    if (rj != null && target != null) candidates[target.release.sha256] = rj
    val releaseRecords = reloadReleaseRecords(candidates, input.releaseKeys, input.trust, input.expectedAud, pinned).mapValues { it.value.jws }

    // Steps 17–18.
    val entry = outletEntry(target, input.outlet)
    val rollout = entry?.rollout
    val bucket: Long? = if (rollout != null && input.installId != null) rolloutBucket(rollout.salt, input.installId) else null

    var contentInput: UpdateContentInput? = null
    var revocations: UpdateCheckRevocations? = null
    input.content?.let { content ->
        val steps = contentSteps(input, content, feed.content, feedSource, errors, fetchRecord)
        contentInput = steps.first
        revocations = steps.second
    }

    val decision = decideUpdate(
        UpdateDecisionInput(
            now = input.now, feed = feed, record = record, installed = input.installed, outlet = input.outlet,
            subkind = input.subkind, staged = input.staged, skipVersion = input.skipVersion, bucket = bucket,
            methods = input.methods, content = contentInput,
        ),
    )
    return UpdateCheckOutcome.Ok(
        UpdateCheckRun(
            UpdateCheck(feed.channel, decision, feedSource, recordSource, errors.toList()),
            feed, record, feeds, releaseRecords, revocations,
        ),
    )
}

/**
 * plans/P4-13.md §2.5 content steps 10–13: the relevant revocations (fetched and verified against
 * the pinned release keys, at most `MAX_FEED_REVOCATIONS` per check, superseding by
 * [newerRevocation]), their replacements, the gate buckets, and the decision's content input.
 */
private suspend fun contentSteps(
    input: UpdateCheckInput,
    c: UpdateCheckContent,
    fc: FeedContent,
    feedSource: UpdateCheck.FeedSource,
    errors: MutableList<UpdateCheckError>,
    fetchRecord: suspend (String) -> FetchOutcome,
): Pair<UpdateContentInput, UpdateCheckRevocations> {
    val platform = input.installed.platform
    val engine = input.installed.engine ?: ""

    // H: the active pack records, the stamp's pins and holds, and the feed targets §2.6 selects.
    val h = HashSet<String>()
    c.active.values.forEach { h += it.sha256 }
    c.stamp.pins.forEach { h += it.release.sha256 }
    (c.stamp.holds ?: emptyList()).forEach { h += it.release.sha256 }
    val packsH = HashSet(c.active.keys)
    c.stamp.pins.forEach { packsH += it.pack }
    c.stamp.expects.forEach { packsH += it.pack }
    (c.stamp.holds ?: emptyList()).forEach { packsH += it.pack }
    val delegations = c.delegated.values.map { it.delegation }.toSet()
    fc.packSets?.let { ps ->
        val targets = selectPackRows(ps, c.stamp.contentApi, platform, engine, c.axes)
        packsH += targets.keys
        for (t in targets.values) {
            h += t
            for (o in (ps.outlets ?: emptyMap()).values) {
                for ((g, gate) in o.gates ?: emptyMap()) if (g == t) gate.fallback?.let { h += it }
            }
        }
    }

    // Step 11.
    fun relevant(entry: FeedRevocation): Boolean =
        if (entry.kind == "delegation") entry.target in delegations || packsH.any { coversPack(entry.pack, it) } else entry.target in h
    val stored = LinkedHashMap(c.revoked)
    val learned = ArrayList<LearnedRevocation>()
    val known = HashSet<String>()
    var fetches = 0
    for (entry in fc.revocations ?: emptyList()) {
        if (!relevant(entry)) continue
        val have = stored[entry.target]
        if (have != null && have.record == entry.record) {
            known += entry.record
            continue
        }
        if (fetches >= MAX_FEED_REVOCATIONS) break
        fetches++
        val body = when (val fetched = fetchRecord(entry.record)) {
            is FetchOutcome.Failed -> {
                errors += UpdateCheckError(fetched.code)
                continue
            }
            is FetchOutcome.Ok -> fetched.body
        }
        val r = verifyRevocation(body, VerifyRevocationOptions(input.releaseKeys, input.trust, input.expectedAud, entry))
        val rev = r.revocation
        if (rev == null) {
            errors += UpdateCheckError(ErrorCode.recordRejected, r.step?.wire)
            continue
        }
        known += entry.record
        if (have == null || newerRevocation(rev, have) == rev) {
            stored[entry.target] = rev
            learned += LearnedRevocation(rev, body)
        }
    }

    // Step 12: the replacements of the relevant stored revocations.
    val revInput = ArrayList<ContentRevocationInput>()
    for (target in stored.keys.sorted()) {
        val rev = stored.getValue(target)
        var usable = false
        val replacement = if (target in delegations) null else rev.replacement
        if (replacement != null && target in h && !stored.containsKey(replacement.sha256)) {
            val fetched = fetchRecord(replacement.sha256)
            if (fetched is FetchOutcome.Ok) {
                val v = verifyReleaseRecord(
                    fetched.body,
                    VerifyReleaseRecordOptions(
                        input.releaseKeys, input.trust, input.expectedAud, replacement.sha256,
                        ReleaseRecordPin(kind = "pack", deliverable = rev.pack, version = replacement.version, seq = replacement.seq),
                    ),
                )
                v.record?.let { usable = c.selectsVariant(it.json["variants"].arrayValue ?: emptyList()) }
            }
        }
        revInput += ContentRevocationInput(target, rev.pack, replacement, usable)
    }
    val targets = stored.keys.toSet()
    for (record in c.delegated.keys.sorted()) {
        val d = c.delegated.getValue(record)
        if (recordRevoked(record, d.delegation, targets) == RecordRevokedBy.delegation) {
            revInput += ContentRevocationInput(record, d.pack, null, false)
        }
    }

    // Step 13: the bucket of every gate salt.
    val buckets = LinkedHashMap<String, Long?>()
    for (o in (fc.packSets?.outlets ?: emptyMap()).values) {
        for (gate in (o.gates ?: emptyMap()).values) {
            val rollout = gate.rollout ?: continue
            if (buckets.containsKey(rollout.salt)) continue
            buckets[rollout.salt] = input.installId?.let { rolloutBucket(rollout.salt, it) }
        }
    }

    // `relearn` clears only on a fresh, network-verified feed with a usable `revocations` member.
    val relearnCleared = ArrayList<String>()
    val revs = fc.revocations
    if (feedSource == UpdateCheck.FeedSource.network && revs != null) {
        for (p in c.relearn) {
            if (revs.filter { it.pack == p && relevant(it) }.all { it.record in known }) relearnCleared += p
        }
    }

    return UpdateContentInput(c.stamp, c.active, c.axes, revInput, buckets) to UpdateCheckRevocations(learned, relearnCleared)
}

/**
 * What the update client asks of a host's pack facet (plans/P4-13.md §2.5): the content decision's
 * inputs, the delta menu of the feed each check committed (plans/P4-29.md §2.4 step 1), and the
 * revocations a check verified. The packs facet (:packs' `PacksClient`) implements it and the
 * umbrella client hands it to the update client, so :update and :packs never see each other.
 */
public interface UpdateContentHost {
    /** The update check's content input; null when the host configured no content stamp. */
    public suspend fun contentInput(): UpdateCheckContent?

    /** The delta menu of the feed a check committed or fell back to (`feedContent`'s `deltas`). */
    public fun noteFeedDeltas(deltas: FeedDeltas?)

    /** Keep the revocations an update check verified. */
    public suspend fun recordRevocations(revocations: UpdateCheckRevocations)
}
