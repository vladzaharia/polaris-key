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

    public init(
        channel: String, expectedAud: String, trust: TrustSet, releaseKeys: TrustSet, now: Int,
        installId: String?, installed: InstalledBuild, outlet: UpdateOutlet, subkind: String?,
        staged: StagedUpdate? = nil, skipVersion: String? = nil, methods: [String],
        feeds: [String: String], releaseRecords: [String: String]
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
    }
}

/// A completed run: the answer, the verified documents it used, and the slices to write back
/// (Core's read-modify-write). Only verified, committed artifacts are in the slices.
public struct UpdateCheckRun: Sendable, Equatable {
    public let check: UpdateCheck
    public let feed: ChannelFeedDoc
    public let record: ReleaseRecordDoc?
    public let feeds: [String: String]
    public let releaseRecords: [String: String]
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
    let decision = decideUpdate(
        UpdateDecisionInput(
            now: input.now, feed: feed, record: record, installed: input.installed,
            outlet: input.outlet, subkind: input.subkind, staged: input.staged,
            skipVersion: input.skipVersion, bucket: bucket, methods: input.methods))

    return .ok(
        UpdateCheckRun(
            check: UpdateCheck(
                channel: feed.channel, decision: decision, feed: feedSource, record: recordSource,
                errors: errors),
            feed: feed, record: record, feeds: feeds, releaseRecords: releaseRecords))
}
