// Apple-hosted Background Assets: managed asset packs through `AssetPackManager`.
//
// Gates (notes/S-01 §Recommendation, S-09 §Results 4):
//
//   - The 26.4 methods (`localStatus(ofAssetPackWithID:)`, `assetPackIsAvailableLocally`,
//     `ensureLocalAvailability(of:requireLatestVersion:)`) carry the ready/failed logic, so the
//     whole client needs iOS / macOS 26.4. Below it every op answers unsupported (`version`) and
//     26.0–26.3 devices take the `pkey-cdn` fallback. The package floor is NOT raised.
//   - Compiling the client needs an SDK that has those methods: Xcode 26.4 (Swift 6.3). The
//     repo's macos-15 job builds with Xcode 16.4 (Swift 6.1), where `canImport(BackgroundAssets)`
//     is true (the framework is iOS 16) but `AssetPackManager` does not exist, so the client is
//     behind `#if compiler(>=6.3)`. The iOS 27 manifest API is behind `#if compiler(>=6.4)` and
//     `#available(iOS 27, *)`; below it the 26.x `assetPack(withID:)` is used.
//   - `AssetPackManager.shared` TRAPS (a Swift fatalError) in a process that is not a configured
//     managed-Background-Assets app. Nothing touches it unless the Info.plist keys S-01's
//     post-export patch adds (`BAAppGroupID`, `BAHasManagedAssetPacks`) are present; a sideload
//     export skips the patch and so answers unsupported (`outlet`).
//   - `url(for:)` returns a path for files that do not exist, so readiness is checked on disk.
//   - After `ensure` FAILS, the local status is read again and `downloaded` without `outOfDate`
//     counts as ready: the simulator reports "Couldn't communicate with a helper application"
//     after complete downloads (S-01 §Results 2).
//   - Paths are resolved fresh on every call, off the main thread, and never persisted. An update
//     replaces the file at the same path while an open mount keeps the old bytes, so hosts apply
//     updates at the next launch.
//
// Batch ensure runs the single ensure concurrently: the batch API is iOS 27.

import Foundation

#if compiler(>=6.3) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
import BackgroundAssets
import System
#endif

/// One pack's status flags (`downloadAvailable`, `updateAvailable`, `upToDate`, `outOfDate`,
/// `obsolete`, `downloading`, `downloaded`).
public struct AssetPackStatus: Sendable, Equatable {
    public var flags: [String]

    public init(_ flags: [String]) { self.flags = flags }

    public var downloaded: Bool { flags.contains("downloaded") }
    public var outOfDate: Bool { flags.contains("outOfDate") }
    /// Downloaded and not out of date: what counts as ready.
    public var ready: Bool { downloaded && !outOfDate }
}

/// A download status update for one pack.
public enum AssetPackProgress: Sendable, Equatable {
    case began
    case paused
    case downloading(bytes: Int64, total: Int64)
    case finished
    case failed(String)
}

/// The manifest's facts about one pack.
public struct AssetPackInfo: Sendable, Equatable {
    public var id: String
    public var version: Int
    public var downloadSize: Int

    public init(id: String, version: Int, downloadSize: Int) {
        self.id = id
        self.version = version
        self.downloadSize = downloadSize
    }
}

/// `AssetPackManager` behind a seam (a fake in `swift test`).
public protocol AssetPackClient: Sendable {
    /// The Background Assets Info.plist keys are present (never touch the manager otherwise).
    func configured() -> Bool
    func info(id: String) async throws -> AssetPackInfo
    func localStatus(id: String) async -> AssetPackStatus
    func ensure(id: String, requireLatest: Bool) async throws
    func checkForUpdates() async throws -> (updating: [String], removed: [String])
    func remove(id: String) async throws
    /// The file-system path of `path` inside the downloaded packs (may not exist).
    func url(for path: String) throws -> String
    func fileExists(_ path: String) -> Bool
    func statusUpdates(id: String) -> AsyncStream<AssetPackProgress>
}

/// The client where managed asset packs cannot exist (below 26.4, or an SDK without them).
public struct UnavailableAssetPackClient: AssetPackClient {
    public init() {}
    public func configured() -> Bool { false }
    public func info(id: String) async throws -> AssetPackInfo { throw Self.error }
    public func localStatus(id: String) async -> AssetPackStatus { AssetPackStatus([]) }
    public func ensure(id: String, requireLatest: Bool) async throws { throw Self.error }
    public func checkForUpdates() async throws -> (updating: [String], removed: [String]) { throw Self.error }
    public func remove(id: String) async throws { throw Self.error }
    public func url(for path: String) throws -> String { throw Self.error }
    public func fileExists(_ path: String) -> Bool { false }
    public func statusUpdates(id: String) -> AsyncStream<AssetPackProgress> { AsyncStream { $0.finish() } }
    static let error = PlatformUnavailable(reason: "version", detail: "Managed asset packs need iOS 26.4")
}

/// Whether this process's Info.plist carries the managed Background Assets keys.
///
/// The guard is the pair that makes `AssetPackManager.shared` safe to touch: `BAAppGroupID` and
/// `BAHasManagedAssetPacks` (S-01 measured the trap without them). `BAUsesAppleHosting` is NOT
/// required: it says who hosts the packs (Apple, as opposed to a self-hosted managed server),
/// not whether the managed manager is configured, and a self-hosted managed app legitimately
/// omits it. The post-export patch writes all three for Polaris Key's store builds.
public func backgroundAssetsConfigured(_ info: [String: Any]? = Bundle.main.infoDictionary) -> Bool {
    guard let info else { return false }
    return info["BAAppGroupID"] is String && (info["BAHasManagedAssetPacks"] as? Bool ?? false)
}

/// `domain code: message` for an error.
func describeError(_ error: any Error) -> String {
    if let u = error as? PlatformUnavailable { return u.detail }
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
}

/// One pack the host wants ready, and the file inside it whose path `pack_ready` reports.
public struct AssetPackRequest: Sendable, Equatable {
    public var id: String
    public var path: String

    public init(id: String, path: String) {
        self.id = id
        self.path = path
    }
}

/// The asset-pack module. Events: `pack_progress {id, bytes, total}`, `pack_ready {id, path}`,
/// `pack_failed {id, err}`.
public actor AssetPackService {
    private let client: any AssetPackClient
    private let availability: PlatformAvailability
    private let sink: PlatformEventSink
    private var watchers: [String: Task<Void, Never>] = [:]

    public init(client: any AssetPackClient, availability: PlatformAvailability, sink: PlatformEventSink) {
        self.client = client
        self.availability = availability
        self.sink = sink
    }

    /// The unsupported answer for this process, or nil when the module works here.
    public nonisolated func unsupported() -> PlatformObject? {
        if !availability.managedAssetPacks {
            return [
                "ok": false, "unsupported": true, "reason": "version",
                "detail": "Managed asset packs need iOS or macOS 26.4.",
            ]
        }
        if !client.configured() {
            return [
                "ok": false, "unsupported": true, "reason": "outlet",
                "detail": "This build has no Background Assets extension (the store-preset Xcode patch was not applied).",
            ]
        }
        return nil
    }

    public func status(id: String) async -> PlatformObject {
        if let u = unsupported() { return u }
        let status = await client.localStatus(id: id)
        var out: PlatformObject = ["ok": true, "id": .string(id), "status": .array(status.flags.map(PlatformJSON.string))]
        do {
            let info = try await client.info(id: id)
            out["version"] = .int(info.version)
            out["downloadSize"] = .int(info.downloadSize)
            // The manifest version is the local one exactly when the local copy is current.
            out["localVersion"] = status.ready ? .int(info.version) : .null
        } catch {
            out["version"] = .null
            out["localVersion"] = .null
            out["infoError"] = .string(describeError(error))
        }
        return out
    }

    /// Ensure every requested pack, concurrently. `{ok, packs: [{id, ready, path?, error?}]}`.
    public func ensure(_ requests: [AssetPackRequest], requireLatest: Bool) async -> PlatformObject {
        if let u = unsupported() { return u }
        let client = self.client
        let sink = self.sink
        let results = await withTaskGroup(of: PlatformJSON.self) { group in
            for r in requests {
                group.addTask { await Self.ensureOne(r, requireLatest: requireLatest, client: client, sink: sink) }
            }
            var all: [PlatformJSON] = []
            for await one in group { all.append(one) }
            return all
        }
        return ["ok": true, "packs": .array(results)]
    }

    private static func ensureOne(
        _ r: AssetPackRequest, requireLatest: Bool, client: any AssetPackClient, sink: PlatformEventSink
    ) async -> PlatformJSON {
        let progress = forward(id: r.id, client: client, sink: sink)
        var ensureError: String?
        do {
            try await client.ensure(id: r.id, requireLatest: requireLatest)
        } catch {
            ensureError = describeError(error)
        }
        progress.cancel()
        // Success or not, the local status decides (S-01: a complete download can still fail).
        let status = await client.localStatus(id: r.id)
        guard status.ready else {
            let err = ensureError ?? "not downloaded (status: \(status.flags.joined(separator: ",")))"
            sink.emit(["ev": "pack_failed", "id": .string(r.id), "err": .string(err)])
            return .object(["id": .string(r.id), "ready": false, "error": .string(err)])
        }
        do {
            let path = try client.url(for: r.path)
            guard client.fileExists(path) else {
                let err = "\(r.path) is not in the downloaded pack"
                sink.emit(["ev": "pack_failed", "id": .string(r.id), "err": .string(err)])
                return .object(["id": .string(r.id), "ready": false, "error": .string(err)])
            }
            sink.emit(["ev": "pack_ready", "id": .string(r.id), "path": .string(path)])
            return .object(["id": .string(r.id), "ready": true, "path": .string(path)])
        } catch {
            let err = describeError(error)
            sink.emit(["ev": "pack_failed", "id": .string(r.id), "err": .string(err)])
            return .object(["id": .string(r.id), "ready": false, "error": .string(err)])
        }
    }

    /// Forward one pack's download progress as `pack_progress` events until cancelled.
    private static func forward(id: String, client: any AssetPackClient, sink: PlatformEventSink) -> Task<Void, Never> {
        let stream = client.statusUpdates(id: id)
        return Task.detached {
            for await update in stream {
                if case .downloading(let bytes, let total) = update {
                    sink.emit(["ev": "pack_progress", "id": .string(id), "bytes": .int(Int(bytes)), "total": .int(Int(total))])
                }
            }
        }
    }

    /// Start forwarding a pack's status updates (system-initiated downloads included) as
    /// `pack_progress` and `pack_status {id, state}` events. Idempotent.
    public func watch(id: String) -> PlatformObject {
        if let u = unsupported() { return u }
        if watchers[id] == nil {
            let stream = client.statusUpdates(id: id)
            let sink = self.sink
            watchers[id] = Task.detached {
                for await update in stream {
                    switch update {
                    case .downloading(let bytes, let total):
                        sink.emit(["ev": "pack_progress", "id": .string(id), "bytes": .int(Int(bytes)), "total": .int(Int(total))])
                    case .began: sink.emit(["ev": "pack_status", "id": .string(id), "state": "began"])
                    case .paused: sink.emit(["ev": "pack_status", "id": .string(id), "state": "paused"])
                    case .finished: sink.emit(["ev": "pack_status", "id": .string(id), "state": "finished"])
                    case .failed(let err):
                        sink.emit(["ev": "pack_status", "id": .string(id), "state": "failed", "err": .string(err)])
                    }
                }
            }
        }
        return ["ok": true, "id": .string(id)]
    }

    public func unwatch(id: String) -> PlatformObject {
        watchers.removeValue(forKey: id)?.cancel()
        return ["ok": true, "id": .string(id)]
    }

    public func checkForUpdates() async -> PlatformObject {
        if let u = unsupported() { return u }
        do {
            let (updating, removed) = try await client.checkForUpdates()
            return [
                "ok": true, "updating": .array(updating.sorted().map(PlatformJSON.string)),
                "removed": .array(removed.sorted().map(PlatformJSON.string)),
            ]
        } catch {
            return ["ok": false, "error": .string(describeError(error))]
        }
    }

    public func remove(id: String) async -> PlatformObject {
        if let u = unsupported() { return u }
        do {
            try await client.remove(id: id)
            return ["ok": true, "id": .string(id)]
        } catch {
            return ["ok": false, "id": .string(id), "error": .string(describeError(error))]
        }
    }

    /// Resolve `path` now (never cached) and say whether the file is there.
    public func url(for path: String) async -> PlatformObject {
        if let u = unsupported() { return u }
        do {
            let resolved = try client.url(for: path)
            return ["ok": true, "path": .string(resolved), "exists": .bool(client.fileExists(resolved))]
        } catch {
            return ["ok": false, "error": .string(describeError(error))]
        }
    }
}

#if compiler(>=6.3) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
/// `AssetPackManager` (iOS / macOS 26.4). Construct it only where
/// `PlatformAvailability.managedAssetPacks` is true; every method refuses (`outlet`) unless the
/// Info.plist keys are present, so `AssetPackManager.shared` is never touched otherwise.
@available(iOS 26.4, macOS 26.4, *)
public struct SystemAssetPackClient: AssetPackClient {
    private let isConfigured: Bool

    public init(configured: Bool = backgroundAssetsConfigured()) { isConfigured = configured }

    public func configured() -> Bool { isConfigured }

    private func manager() throws -> AssetPackManager {
        guard isConfigured else {
            throw PlatformUnavailable(reason: "outlet", detail: "Background Assets is not configured in this build")
        }
        return AssetPackManager.shared
    }

    private func pack(_ id: String) async throws -> AssetPack {
        let m = try manager()
        #if compiler(>=6.4)
        if #available(iOS 27, macOS 27, *) {
            guard let p = try await m.manifest.assetPack(withID: id) else {
                throw ManagedBackgroundAssetsError.assetPackNotFound(withID: id)
            }
            return p
        }
        #endif
        return try await m.assetPack(withID: id)
    }

    public func info(id: String) async throws -> AssetPackInfo {
        let p = try await pack(id)
        return AssetPackInfo(id: p.id, version: p.version, downloadSize: p.downloadSize)
    }

    public func localStatus(id: String) async -> AssetPackStatus {
        guard let m = try? manager() else { return AssetPackStatus([]) }
        return Self.names(await m.localStatus(ofAssetPackWithID: id))
    }

    public func ensure(id: String, requireLatest: Bool) async throws {
        let p = try await pack(id)
        try await manager().ensureLocalAvailability(of: p, requireLatestVersion: requireLatest)
    }

    public func checkForUpdates() async throws -> (updating: [String], removed: [String]) {
        let r = try await manager().checkForUpdates()
        return (Array(r.updatingIDs), Array(r.removedIDs))
    }

    public func remove(id: String) async throws {
        try await manager().remove(assetPackWithID: id)
    }

    public func url(for path: String) throws -> String {
        try manager().url(for: FilePath(path)).path
    }

    public func fileExists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

    public func statusUpdates(id: String) -> AsyncStream<AssetPackProgress> {
        guard let m = try? manager() else { return AsyncStream { $0.finish() } }
        let updates = m.statusUpdates(forAssetPackWithID: id)
        return AsyncStream { continuation in
            let task = Task.detached {
                for await update in updates {
                    switch update {
                    case .began: continuation.yield(.began)
                    case .paused: continuation.yield(.paused)
                    case .downloading(_, let progress):
                        continuation.yield(.downloading(bytes: progress.completedUnitCount, total: progress.totalUnitCount))
                    case .finished: continuation.yield(.finished)
                    case .failed(_, let error): continuation.yield(.failed(describeError(error)))
                    @unknown default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func names(_ s: AssetPack.Status) -> AssetPackStatus {
        var out: [String] = []
        if s.contains(.downloadAvailable) { out.append("downloadAvailable") }
        if s.contains(.updateAvailable) { out.append("updateAvailable") }
        if s.contains(.upToDate) { out.append("upToDate") }
        if s.contains(.outOfDate) { out.append("outOfDate") }
        if s.contains(.obsolete) { out.append("obsolete") }
        if s.contains(.downloading) { out.append("downloading") }
        if s.contains(.downloaded) { out.append("downloaded") }
        return AssetPackStatus(out)
    }
}
#endif
