// The client's holder of discovery's `core.portal` (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md), a port
// of Python's `PortalStore` and Godot's `portal_store.gd`: the member from this session's discovery,
// else the last one persisted as `portal.json` (so a cold start offline still knows whether the
// product's portal is on, and where). Display data only; a link is never repaired or guessed once the
// Worker has answered (`PortalLink.link`).

import Foundation

public final class PortalStore: @unchecked Sendable {
    /// The member's file name, directly in the directory the store is given.
    public static let memberFile = "portal.json"
    /// `portal.json`'s format version.
    public static let memberFileVersion = 1

    public let product: String
    public let baseUrl: String
    /// Where `portal.json` lives, or nil to keep the member in memory only.
    public let directory: URL?

    private struct State {
        var current: PortalMember?
        var discovered = false
    }

    private let state = LockedValue(State())
    private let files = NSLock()

    public init(product: String, baseUrl: String, directory: URL?) {
        self.product = product
        self.baseUrl = baseUrl
        self.directory = directory
    }

    /// The member discovery gave, or the persisted one; nil is "unknown" (an older Worker, or none yet).
    public func current() -> PortalMember? { state.current.current }

    /// Cold start: the member `portal.json` holds, unless this session already discovered one. A file that
    /// does not parse, names another product or base, or does not read back as the parser normalises it
    /// is deleted.
    public func loadCached() {
        if state.with({ $0.discovered }) { return }
        let member = read()
        state.with { s in
            if !s.discovered { s.current = member }
        }
    }

    /// A successful discovery's member (nil: none or an invalid one clears it); persisted.
    public func accept(_ member: PortalMember?) {
        state.with { s in
            s.discovered = true
            s.current = member
        }
        write(member)
    }

    // MARK: - The file

    private var url: URL? { directory?.appendingPathComponent(Self.memberFile) }

    /// The member as the wire spells it, so a stored value can be parsed again.
    private static func wire(_ member: PortalMember) -> JSONValue {
        if member.enabled, let activate = member.activate {
            return .object(["enabled": .bool(true), "activate": .string(activate)])
        }
        return .object(["enabled": .bool(member.enabled)])
    }

    private func write(_ member: PortalMember?) {
        guard let url, let directory else { return }
        files.withLock {
            guard let member else {
                try? FileManager.default.removeItem(at: url)
                return
            }
            let body: JSONValue = .object([
                "v": .int(Self.memberFileVersion), "product": .string(product),
                "baseUrl": .string(baseUrl), "portal": Self.wire(member),
            ])
            guard let data = try? JSONEncoder().encode(body) else { return }
            try? FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    private func read() -> PortalMember? {
        guard let url else { return nil }
        return files.withLock {
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            var member: PortalMember?
            if let data = try? Data(contentsOf: url),
                let value = try? JSONDecoder().decode(JSONValue.self, from: data),
                let o = value.objectValue, o["v"] == .int(Self.memberFileVersion),
                o["product"]?.stringValue == product, o["baseUrl"]?.stringValue == baseUrl,
                let stored = o["portal"],
                let parsed = PortalLink.parse(core: .object(["portal": stored])),
                Self.wire(parsed) == stored
            {
                member = parsed
            }
            if member == nil { try? FileManager.default.removeItem(at: url) }
            return member
        }
    }
}
