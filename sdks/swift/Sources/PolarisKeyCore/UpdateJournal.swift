// The update-health journal (P6-03, notes/SDK-PARITY-PASS.md §3.13).
//
// Every SDK keeps a persisted queue of the update events its fleet's staged-rollout auto-halt
// reads (`conformance/parity/enums.json` `updateEvent`, the Worker's `core/updateHealth.ts`):
//
//   update_offered     `update.decide` returned a newer build
//   update_downloaded  a download or a pack install finished
//   update_applied     a driver hand-off or a pack switch
//   update_confirmed   the boot guard confirmed a launch
//   update_reverted    the boot guard rolled back
//   pack_failed        the pack pipeline failed
//   boot_rolled_back   the boot guard hit N failed boots
//
// A device report carries at most `MAX_REPORT_UPDATE_EVENTS` of them as `updates`; a report the
// Worker accepted drops the ones it carried (by `eventId`; the Worker counts a resent event once).
// The journal is bounded (`MAX_JOURNAL_EVENTS`, oldest dropped) and persisted through the store
// (`Store.readRecord`/`writeRecord`, `update-events`), so events survive a crash before the next report.

import Foundation

/// At most this many events ride one report (the Worker's `MAX_UPDATE_EVENTS`).
public let MAX_REPORT_UPDATE_EVENTS = 16
/// The journal keeps at most this many events; the oldest are dropped beyond it.
public let MAX_JOURNAL_EVENTS = 128

/// One `updates` entry, exactly the Worker's `UpdateEventEntry`.
public struct UpdateEventEntry: Sendable, Equatable, Codable {
    public let eventId: String
    public let event: String
    public let deliverable: String
    public let release: String
    public let fromRelease: String?
    public let outlet: String
    public let channel: String
    public let packSetId: String?
    /// Epoch seconds.
    public let at: Int
    public let code: String?

    public init(
        eventId: String, event: String, deliverable: String, release: String,
        fromRelease: String? = nil, outlet: String, channel: String, packSetId: String? = nil,
        at: Int, code: String? = nil
    ) {
        self.eventId = eventId
        self.event = event
        self.deliverable = deliverable
        self.release = release
        self.fromRelease = fromRelease
        self.outlet = outlet
        self.channel = channel
        self.packSetId = packSetId
        self.at = at
        self.code = code
    }
}

/// The journal: in memory, persisted through the store after every change.
public final class UpdateJournal: Sendable {
    /// The store record the journal persists as.
    public static let recordName = "update-events"
    private let store: any Store
    private let events = LockedValue<[UpdateEventEntry]?>(nil)
    /// The outlet id events (and reports) carry: the update client sets it once it resolved the
    /// outlet; `unknown` until then.
    public let outlet = LockedValue<String?>(nil)

    public init(store: any Store) {
        self.store = store
    }

    private func loaded() async -> [UpdateEventEntry] {
        if let current = events.current { return current }
        let persisted =
            (await store.readRecord(UpdateJournal.recordName)).flatMap {
                try? JSONDecoder().decode([UpdateEventEntry].self, from: $0)
            } ?? []
        return events.with { value in
            if value == nil { value = persisted }
            return value!
        }
    }

    private func persist() async {
        let snapshot = events.current ?? []
        await store.writeRecord(
            UpdateJournal.recordName, snapshot.isEmpty ? nil : try? JSONEncoder().encode(snapshot))
    }

    /// Queue one event. `event` is an `UpdateEvent` constant; `release` the build or pack release
    /// the event is about (its tag, else its version); `fromRelease` the one the device moved
    /// from, omitted when equal.
    @discardableResult
    public func record(
        _ event: String, release: String, fromRelease: String? = nil, channel: String,
        deliverable: String = "app", packSetId: String? = nil, code: String? = nil,
        at: Int = Int(Date().timeIntervalSince1970)
    ) async -> UpdateEventEntry {
        _ = await loaded()
        let entry = UpdateEventEntry(
            eventId: "\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased())-\(event)",
            event: event, deliverable: deliverable, release: release,
            fromRelease: fromRelease == release ? nil : fromRelease,
            outlet: outlet.current ?? OUTLET_UNKNOWN, channel: channel, packSetId: packSetId,
            at: at, code: code)
        events.with { value in
            var list = value ?? []
            list.append(entry)
            if list.count > MAX_JOURNAL_EVENTS { list.removeFirst(list.count - MAX_JOURNAL_EVENTS) }
            value = list
        }
        await persist()
        return entry
    }

    /// The events the next report carries: the oldest `MAX_REPORT_UPDATE_EVENTS`.
    public func pending() async -> [UpdateEventEntry] {
        Array((await loaded()).prefix(MAX_REPORT_UPDATE_EVENTS))
    }

    /// Every queued event (diagnostics).
    public func all() async -> [UpdateEventEntry] { await loaded() }

    /// Drop the events an accepted report carried.
    public func markReported(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        _ = await loaded()
        let set = Set(ids)
        events.with { value in value = (value ?? []).filter { !set.contains($0.eventId) } }
        await persist()
    }
}

/// What Core's modules tell the facade (it fans them out as `client.changes` events).
public enum CoreEvent: Sendable, Equatable {
    /// `update.decide` offered a newer build.
    case updateAvailable(version: String)
    /// A pack finished (`installed`) or failed (its error code).
    case packs(packId: String, result: String)
    /// A local override of `key` changed (`config.set` / `clear`).
    case config(key: String)
}

extension UpdateDecision {
    /// The release a decision offers (code-ready, binary, store, platform), or nil.
    public var offeredRelease: DecisionRelease? {
        switch self {
        case .codeReady(let r, _, _): return r
        case .binary(_, let r, _, _, _, _, _, _): return r
        case .store(let r, _, _, _, _, _): return r
        case .platform(let r, _, _, _, _): return r
        default: return nil
        }
    }
}
