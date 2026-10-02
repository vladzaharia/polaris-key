// `update.decide()`'s shared core — plans/P3-01.md §2.5 steps 2–18 and "After a refusal".
//
// Every SDK must behave the same after a refusal, so the order, the fallback and the error map
// live here once for Swift. The function does no I/O of its own: the caller hands it the two
// fetches (the feed for a requested channel, a record by hash) and the cache slices, and gets
// back the `UpdateCheck` plus the slices to write. Step 1 (discovery), the options refusals
// (`not-configured`, `invalid-options`) and the write itself stay with `UpdateClient`.
//
// It never throws. A failure with nothing to decide from comes back as `.failed(error)`, which
// the caller raises. client-core's `check.ts` is the reference.

import Foundation

/// One fetch's outcome. A transport failure or a non-2xx answer carries `network-error`, or the
/// Worker's wire code when the answer names one (`feed_not_composable`, …).
public enum FetchOutcome: Sendable, Equatable {
    case ok(String)
    case failed(code: String)
}

/// One entry of `UpdateCheck.errors` (§2.5's error map).
public struct UpdateCheckError: Sendable, Equatable {
    public let code: String
    /// The refused step (`jws`, `claims`, `channel`, `selector`, `freshness`, `hash`), or nil.
    public let detail: String?

    public init(code: String, detail: String? = nil) {
        self.code = code
        self.detail = detail
    }

    public var json: JSONValue {
        .object(["code": .string(code), "detail": detail.map(JSONValue.string) ?? .null])
    }
}

/// What `UpdateClient.decide()` answers (§2.5 "After a refusal").
public struct UpdateCheck: Sendable, Equatable {
    /// Where the decision's feed came from.
    public enum FeedSource: String, Sendable, Equatable {
        /// The fetched copy was committed, or equals the committed one.
        case network
        /// The decision used the earlier, committed copy instead.
        case committed
    }

    /// Where the decision's record came from.
    public enum RecordSource: String, Sendable, Equatable {
        case network, cache, none
    }

    /// The canonical channel: the `channel` claim of the feed the decision used. A host that
    /// stages an update records THIS as `StagedUpdate.channel`, never the requested name.
    public let channel: String
    public let decision: UpdateDecision
    public let feed: FeedSource
    public let record: RecordSource
    public let errors: [UpdateCheckError]

    public init(
        channel: String, decision: UpdateDecision, feed: FeedSource, record: RecordSource,
        errors: [UpdateCheckError]
    ) {
        self.channel = channel
        self.decision = decision
        self.feed = feed
        self.record = record
        self.errors = errors
    }

    /// The stage machine's `decide.done` for the decision.
    public var boot: BootEvent.Decision { bootDecision(decision) }

    /// The `UpdateCheck` as the transcripts spell it.
    public var json: JSONValue {
        .object([
            "channel": .string(channel), "decision": decision.json,
            "feed": .string(feed.rawValue), "record": .string(record.rawValue),
            "errors": .array(errors.map(\.json)),
        ])
    }
}

/// `runUpdateCheck`'s inputs.
public struct UpdateCheckInput: Sendable {
    /// The channel name the host REQUESTED (it may be an alias, such as `latest`).
    public var channel: String
    public var expectedAud: String
    /// The EFFECTIVE product trust set (pins ∪ manifest keys).
    public var trust: TrustSet
    /// `pinnedReleaseKeys`: never empty here (the caller raises `not-configured` first).
    public var releaseKeys: TrustSet
    /// The effective clock, `max(system, highWaterMark)`.
    public var now: Int
    /// The device id, as sent in `X-PKey-Device`: the rollout bucket's install id. Nil leaves
    /// the bucket nil (out of every client rollout).
    public var installId: String?
    public var installed: InstalledBuild
    public var outlet: UpdateOutlet
    public var subkind: String?
    public var staged: StagedUpdate?
    public var skipVersion: String?
    public var methods: [String]
    /// The `feeds` slice as stored. Each entry is re-verified here (the reload path).
    public var feeds: [String: String]
    /// The `releaseRecords` slice as stored.
    public var releaseRecords: [String: String]
    /// The content decision's inputs (plans/P4-13.md §2.5 steps 10–14, §2.6). Nil: no content
    /// decision, every answer is P3-01's.
    public var content: UpdateCheckContent?

    public init(
        channel: String, expectedAud: String, trust: TrustSet, releaseKeys: TrustSet, now: Int,
        installId: String?, installed: InstalledBuild, outlet: UpdateOutlet, subkind: String?,
        staged: StagedUpdate? = nil, skipVersion: String? = nil, methods: [String],
        feeds: [String: String], releaseRecords: [String: String], content: UpdateCheckContent? = nil
    ) {
        self.channel = channel
        self.expectedAud = expectedAud
        self.trust = trust
        self.releaseKeys = releaseKeys
        self.now = now
        self.installId = installId
        self.installed = installed
        self.outlet = outlet
        self.subkind = subkind
        self.staged = staged
        self.skipVersion = skipVersion
        self.methods = methods
        self.feeds = feeds
        self.releaseRecords = releaseRecords
        self.content = content
    }
}

/// What a host with packs hands the update check (plans/P4-13.md §2.5, §2.6).
public struct UpdateCheckContent: Sendable {
    /// The running build's content stamp, with its holds (`stampHolds`: nil when unusable).
    public var stamp: UpdateContentStamp
    /// The pack state's active installs, embedded baselines included, by pack id.
    public var active: [String: ReleasePin]
    /// The host's engine (`godot-<major>.<minor>`, nil outside Godot) and variant axes.
    public var engine: String?
    public var axes: [String: [String]]
    /// The stored, verified revocations, by target (the pack engine's `revocations()`).
    public var revoked: [String: VerifiedRevocation]
    /// Packs whose revocations must be re-learned (the engine's `relearn`).
    public var relearn: [String]
    /// Whether a verified replacement record has a variant for this host (`selectVariant` over
    /// its `variants` with `engine` and `axes`). Core cannot see the packs target, so the host
    /// hands its selection in; `PacksClient.contentInput()` does.
    public var selectsVariant: @Sendable (_ variants: [JSONValue]) -> Bool

    public init(
        stamp: UpdateContentStamp, active: [String: ReleasePin], engine: String?,
        axes: [String: [String]], revoked: [String: VerifiedRevocation], relearn: [String] = [],
        selectsVariant: @escaping @Sendable (_ variants: [JSONValue]) -> Bool
    ) {
        self.stamp = stamp
        self.active = active
        self.engine = engine
        self.axes = axes
        self.revoked = revoked
        self.relearn = relearn
        self.selectsVariant = selectsVariant
    }
}

/// A revocation this check fetched and verified, with its compact JWS, to store (the pack
/// engine's `recordRevocations`).
public struct LearnedRevocation: Sendable, Equatable {
    public let revocation: VerifiedRevocation
    public let jws: String

    public init(revocation: VerifiedRevocation, jws: String) {
        self.revocation = revocation
        self.jws = jws
    }
}

/// With `content`: the revocations a check learned and the packs whose `relearn` it cleared.
public struct UpdateCheckRevocations: Sendable, Equatable {
    public let learned: [LearnedRevocation]
    public let relearnCleared: [String]
}

/// A completed run: the answer, the verified documents it used, and the slices to write back
/// (Core's read-modify-write). Only verified, committed artifacts are in the slices.
public struct UpdateCheckRun: Sendable, Equatable {
    public let check: UpdateCheck
    public let feed: ChannelFeedDoc
    public let record: ReleaseRecordDoc?
    public let feeds: [String: String]
    public let releaseRecords: [String: String]
    /// With `content`: what to store and which `relearn` entries to clear.
    public let revocations: UpdateCheckRevocations?
}

public enum UpdateCheckOutcome: Sendable, Equatable {
    case ok(UpdateCheckRun)
    /// Nothing to decide from: the error to raise.
    case failed(UpdateCheckError)
}

/// The step-3–8 refusal's entry in `errors`, or nil for `not-newer` (nothing is reported).
private func feedError(_ reason: FeedRefusal) -> UpdateCheckError? {
    switch reason {
    case .notNewer: return nil
    case .rollback: return UpdateCheckError(code: ErrorCode.feedRollback)
    default: return UpdateCheckError(code: ErrorCode.feedRejected, detail: reason.rawValue)
    }
}

/// Steps 2–18 of plans/P3-01.md §2.5, with its refusal rules:
///
/// - the committed feeds are re-verified first (the reload path), which gives the floors;
/// - a fetched body equal to a committed feed that step 5 binds to the request changes nothing;
/// - otherwise the fetched feed is verified (steps 3–8) and, when accepted, committed under its
///   claim, removing the requested name's entry after an alias answer (step 9);
/// - after a transport failure, `not-newer` or a refusal at steps 3–8, the decision uses the
///   first committed feed among `feeds[claim]` (only when the fetched feed passed step 5),
///   `feeds[requested]` and `feeds[CHANNEL_ALIASES[requested]]`; with none, `.failed`;
/// - the record comes from the cache or the network, hash before signature, and a record that
///   cannot be fetched or is refused is nil for this call.
public func runUpdateCheck(
    _ input: UpdateCheckInput,
    fetchFeed: @Sendable (String) async -> FetchOutcome,
    fetchRecord: @Sendable (String) async -> FetchOutcome
) async -> UpdateCheckOutcome {
    let requested = input.channel
    let platform = input.installed.platform
    var errors: [UpdateCheckError] = []

    // The reload path: the committed feeds that still verify, and the floors they set.
    let committed = reloadFeeds(
        input.feeds, trust: input.trust, expectedAud: input.expectedAud, platform: platform)
    var feeds: [String: String] = committed.feeds.mapValues(\.jws)
    // The decoded twin of `feeds`, so the records can be pruned to what a committed feed pins.
    var feedDocs: [String: ChannelFeedDoc] = committed.feeds.mapValues(\.feed)

    func fallback(_ claim: String?) -> CommittedFeed? {
        for k in (claim.map { [$0] } ?? []) + boundChannels(requested) {
            if let c = committed.feeds[k] { return c }
        }
        return nil
    }

    // Steps 2–9.
    let feed: ChannelFeedDoc
    var feedSource = UpdateCheck.FeedSource.network
    switch await fetchFeed(requested) {
    case .ok(let body):
        // Step 2: an unchanged body decides from the committed copy.
        if let same = boundChannels(requested).lazy.compactMap({ committed.feeds[$0] })
            .first(where: { $0.jws == body })
        {
            feed = same.feed
        } else {
            let v = verifyFeed(
                body,
                options: VerifyFeedOptions(
                    trust: input.trust, expectedAud: input.expectedAud, channel: requested,
                    platform: platform, now: input.now, checkFreshness: true,
                    floors: committed.floors))
            switch v {
            case .ok(let accepted):
                feed = accepted
                feeds = commitFeed(feeds, requested: requested, claim: accepted.channel, jws: body)
                if accepted.channel != requested { feedDocs[requested] = nil }
                feedDocs[accepted.channel] = accepted
            case .refused(let reason, let claim):
                let error = feedError(reason)
                guard let prior = fallback(claim) else {
                    return .failed(
                        error ?? UpdateCheckError(code: ErrorCode.feedRejected, detail: reason.rawValue))
                }
                if let error { errors.append(error) }
                feed = prior.feed
                feedSource = .committed
            }
        }
    case .failed(let code):
        guard let prior = fallback(nil) else { return .failed(UpdateCheckError(code: code)) }
        errors.append(UpdateCheckError(code: code))
        feed = prior.feed
        feedSource = .committed
    }

    // Steps 10–16.
    let target = feedTarget(feed.app.targets, platform: platform)
    var record: ReleaseRecordDoc?
    var recordSource = UpdateCheck.RecordSource.none
    var recordJws: String?
    if let target {
        let pin = target.release
        let opts = VerifyReleaseRecordOptions(
            releaseKeys: input.releaseKeys, productTrust: input.trust,
            expectedAud: input.expectedAud, expectedHash: pin.sha256,
            pin: ReleaseRecordPin(deliverable: "app", version: pin.version, seq: pin.seq))
        if let cached = input.releaseRecords[pin.sha256],
            let r = verifyReleaseRecord(cached, options: opts).record
        {
            record = r
            recordSource = .cache
            recordJws = cached
        }
        if record == nil {
            switch await fetchRecord(pin.sha256) {
            case .failed(let code):
                errors.append(UpdateCheckError(code: code))
            case .ok(let body):
                switch verifyReleaseRecord(body, options: opts) {
                case .ok(let r):
                    record = r
                    recordSource = .network
                    recordJws = body
                case .refused(.crossCheck):
                    errors.append(UpdateCheckError(code: ErrorCode.recordMismatch))
                case .refused(let step):
                    errors.append(UpdateCheckError(code: ErrorCode.recordRejected, detail: step.rawValue))
                }
            }
        }
    }

    // A record is kept only while a committed feed's target for this platform pins it.
    var pinned = Set<String>()
    for doc in feedDocs.values {
        if let t = feedTarget(doc.app.targets, platform: platform) { pinned.insert(t.release.sha256) }
    }
    var candidates = input.releaseRecords
    if let recordJws, let target { candidates[target.release.sha256] = recordJws }
    let releaseRecords = reloadReleaseRecords(
        candidates, releaseKeys: input.releaseKeys, productTrust: input.trust,
        expectedAud: input.expectedAud, pinned: pinned
    ).mapValues(\.jws)

    // Steps 17–18.
    let entry = outletEntry(target, outlet: input.outlet)
    var bucket: Int?
    if let rollout = entry?.rollout, let installId = input.installId {
        bucket = rolloutBucket(salt: rollout.salt, installId: installId)
    }
    // plans/P4-13.md §2.5 content steps 10–14. The feed and the record carry their own non-wire
    // pointers, so the decision applies the token rule to their content members itself.
    var contentInput: UpdateContentInput?
    var revocations: UpdateCheckRevocations?
    if let content = input.content {
        let steps = await contentSteps(
            input, content, feed.content, feedSource: feedSource, errors: &errors, fetchRecord: fetchRecord)
        contentInput = steps.input
        revocations = steps.revocations
    }

    let decision = decideUpdate(
        UpdateDecisionInput(
            now: input.now, feed: feed, record: record, installed: input.installed,
            outlet: input.outlet, subkind: input.subkind, staged: input.staged,
            skipVersion: input.skipVersion, bucket: bucket, methods: input.methods,
            content: contentInput))

    return .ok(
        UpdateCheckRun(
            check: UpdateCheck(
                channel: feed.channel, decision: decision, feed: feedSource, record: recordSource,
                errors: errors),
            feed: feed, record: record, feeds: feeds, releaseRecords: releaseRecords,
            revocations: revocations))
}

/// plans/P4-13.md §2.5 content steps 10–13: the relevant revocations (fetched and verified
/// against the pinned release keys, at most `MAX_FEED_REVOCATIONS` per check, superseding by
/// `newerRevocation`), their replacements (fetched, verified as pack records, not revoked, and
/// with a variant for this host), the gate buckets, and the decision's content input. A failed
/// fetch retries at the next check; a failed verification is ignored and never trusted.
private func contentSteps(
    _ input: UpdateCheckInput, _ c: UpdateCheckContent, _ fc: FeedContent,
    feedSource: UpdateCheck.FeedSource, errors: inout [UpdateCheckError],
    fetchRecord: @Sendable (String) async -> FetchOutcome
) async -> (input: UpdateContentInput, revocations: UpdateCheckRevocations) {
    let platform = input.installed.platform
    let engine = input.installed.engine ?? ""

    // H: the active pack records, the stamp's pins and holds, and the feed targets §2.6 selects
    // (gate fallbacks included).
    var H = Set<String>()
    for pin in c.active.values { H.insert(pin.sha256) }
    for p in c.stamp.pins { H.insert(p.release.sha256) }
    for h in c.stamp.holds ?? [] { H.insert(h.release.sha256) }
    if let ps = fc.packSets {
        let targets = selectPackRows(
            ps, contentApi: c.stamp.contentApi, platform: platform, engine: engine, axes: c.axes)
        for h in targets.values {
            H.insert(h)
            for o in (ps.outlets ?? [:]).values {
                for (g, gate) in o.gates ?? [:] where g == h {
                    if let f = gate.fallback { H.insert(f) }
                }
            }
        }
    }

    // Step 11.
    var stored = c.revoked
    var learned: [LearnedRevocation] = []
    // The feed entries step 11 considers (target in H) that are now known: already stored with
    // that record, or fetched and verified in this check (a newer stored one may still win).
    var known = Set<String>()
    var fetches = 0
    for entry in fc.revocations ?? [] {
        guard H.contains(entry.target) else { continue }
        let have = stored[entry.target]
        if let have, have.record == entry.record {
            known.insert(entry.record)
            continue
        }
        if fetches >= MAX_FEED_REVOCATIONS { break }
        fetches += 1
        let body: String
        switch await fetchRecord(entry.record) {
        case .failed(let code):
            errors.append(UpdateCheckError(code: code))
            continue
        case .ok(let b): body = b
        }
        let r = verifyRevocation(
            body,
            options: VerifyRevocationOptions(
                releaseKeys: input.releaseKeys, productTrust: input.trust,
                expectedAud: input.expectedAud, entry: entry))
        guard let rev = r.revocation else {
            errors.append(UpdateCheckError(code: ErrorCode.recordRejected, detail: r.step?.rawValue))
            continue
        }
        known.insert(entry.record)
        if have == nil || newerRevocation(rev, have!) == rev {
            stored[entry.target] = rev
            learned.append(LearnedRevocation(revocation: rev, jws: body))
        }
    }

    // Step 12: the replacements of the relevant stored revocations.
    var revInput: [ContentRevocationInput] = []
    for target in stored.keys.sorted() {
        let rev = stored[target]!
        var usable = false
        if let rep = rev.replacement, H.contains(target), stored[rep.sha256] == nil,
            case .ok(let body) = await fetchRecord(rep.sha256)
        {
            let v = verifyReleaseRecord(
                body,
                options: VerifyReleaseRecordOptions(
                    releaseKeys: input.releaseKeys, productTrust: input.trust,
                    expectedAud: input.expectedAud, expectedHash: rep.sha256,
                    pin: ReleaseRecordPin(kind: "pack", deliverable: rev.pack, version: rep.version, seq: rep.seq)))
            if let record = v.record {
                usable = c.selectsVariant(record.json.objectValue?["variants"]?.arrayValue ?? [])
            }
        }
        revInput.append(
            ContentRevocationInput(target: target, pack: rev.pack, replacement: rev.replacement, replacementUsable: usable))
    }

    // Step 13: the bucket of every gate salt.
    var buckets: [String: Int?] = [:]
    for o in (fc.packSets?.outlets ?? [:]).values {
        for gate in (o.gates ?? [:]).values {
            guard let rollout = gate.rollout, buckets[rollout.salt] == nil else { continue }
            buckets[rollout.salt] = .some(input.installId.map { rolloutBucket(salt: rollout.salt, installId: $0) })
        }
    }

    // `relearn` clears only on a fresh, network-verified feed with a usable `revocations` member,
    // once step 11 has fetched, verified and stored every revocation it considers for that pack
    // (the entries whose target is in H). Entries for releases outside H (an older release the
    // device does not hold) are not considered and never keep a pack in `relearn`.
    var relearnCleared: [String] = []
    if feedSource == .network, let revs = fc.revocations {
        for p in c.relearn {
            let all = revs.filter { $0.pack == p && H.contains($0.target) }.allSatisfy { known.contains($0.record) }
            if all { relearnCleared.append(p) }
        }
    }

    return (
        UpdateContentInput(
            stamp: c.stamp, active: c.active, axes: c.axes, revocations: revInput, buckets: buckets),
        UpdateCheckRevocations(learned: learned, relearnCleared: relearnCleared)
    )
}
