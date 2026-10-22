// @pkey-feature ui.update ui.settings
// Small decisions the SwiftUI views share and the tests can reach without a view: what "Update
// now" does, and when an edited setting is reported.

import Foundation

/// What the update verb does (UI-KITS decision 7: a host-dependent action draws only when the
/// host can act on it).
public enum KitUpdateRoute: Equatable, Sendable {
    /// The host's own handler runs.
    case handler
    /// No handler: the store listing the update decision named opens.
    case open(URL)
    /// Neither: no verb draws, and the screen says where to update.
    case none

    /// Never the release notes page: `notes` is for reading, not for updating.
    public static func resolve(hasHandler: Bool, update: KitUpdate?) -> KitUpdateRoute {
        if hasHandler { return .handler }
        if let link = KitLinks.valid(update?.listingUrl) { return .open(link) }
        return .none
    }
}

/// Reports an edited setting once, however it ends: Return, focus leaving the field, or a slider
/// released. Never a value the row already has, never the same value twice.
public struct KitCommitLog: Sendable, Equatable {
    private var sent: [String: KitConfigValue] = [:]

    public init() {}

    /// Whether `value` for `key` should be sent now, given what the row holds.
    public mutating func shouldCommit(
        key: String, value: KitConfigValue?, rowValue: KitConfigValue?
    ) -> Bool {
        guard let value, value != rowValue, sent[key] != value else { return false }
        sent[key] = value
        return true
    }

    /// A reset forgets the key: its next edit is new.
    public mutating func forget(_ key: String) { sent[key] = nil }
}
