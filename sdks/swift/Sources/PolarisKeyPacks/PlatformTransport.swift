// Store transports (P5-08; CONTENT §7): the platform moves the bytes, Polaris Key keeps the
// identity. The Swift twin of Godot's `PKeyPackPlatformTransport`.
//
// A platform transport carries a fixed set of packs. After the platform says a pack is there, the
// transport reads the pack's directory fresh (a platform path is re-resolved on every call and
// never persisted: Apple's `url(for:)` changes per launch) and hands the engine a baseline, the
// same shape an embedded baseline has:
//
//   container   `<dir>/X` with its marker `<dir>/X.pkey.json` beside it (one marker per directory)
//   tree        `<dir>/` with `<dir>/.pkey/pack.json`
//
// measured here (SHA-256 and size, or the treeDigest over every file). The engine then verifies the
// marker with the release-record verifier and matches the bytes against the signed record; a
// platform's own hashes are never trusted (CONTENT §12). The transport never writes into the
// platform's directory, makes no range requests and fetches no record: the engine's CDN transport
// still fetches the signed record by hash.
//
// Without its platform the transport answers the typed unsupported result (PARITY §2.2) and the
// engine runs on: no platform copy is loaded, and the planner refuses a pack bound to it with
// `plan-transport-unsupported`, never a silent CDN fallback (CONTENT §8.1).

import Foundation
import PolarisKeyCore

/// A store transport the engine plans a carried pack through (`platform` strategy).
public protocol PackPlatformTransport: Sendable {
    /// The transport id (`Transport.appleBa`, …).
    var id: String { get }
    /// The parity feature it proves (`Feature.packsTransportApple`, …).
    var feature: String { get }
    /// Whether a release the platform delivers may be newer than the build's pin (CONTENT §6.6):
    /// Apple-hosted packs float.
    var floats: Bool { get }
    /// Whether this transport carries `packId` on this install.
    func carries(_ packId: String) -> Bool
    /// Nil when the platform can deliver packs here, else the typed unsupported answer
    /// (`runtime`, `version`, `outlet`, `dependency`). Synchronous and side-effect free.
    func unavailable() -> Unsupported?
    /// Where the platform holds `packId` NOW (an existing directory), or nil for no copy.
    /// `contentApi` is the build's content level (the stamp's).
    func locate(_ packId: String, contentApi: Int) async throws -> String?
    /// Ask the platform to make `packId` available; `progress(done, total)` in its bytes.
    func ensure(_ packId: String, contentApi: Int, progress: @escaping @Sendable (Int, Int) -> Void) async throws
}

/// What reading a platform directory as a pack gives.
public enum PlatformBaselineRead: Sendable {
    case baseline(EmbeddedBaseline)
    /// The directory is not a pack (`format`).
    case refused(location: String, step: String)
}

/// Read `dir` as a pack the way an embedded baseline is read: a tree when `.pkey/pack.json` is
/// there, else the one file `X` whose `X.pkey.json` sits beside it. `refused(format)` otherwise.
public func readPlatformBaseline(_ dir: String) -> PlatformBaselineRead {
    let root = dir.hasSuffix("/") ? String(dir.dropLast()) : dir
    do {
        if let marker = try readFileOrNil(root + "/.pkey/pack.json") {
            return .baseline(
                EmbeddedBaseline(marker: marker, payload: .tree(treeDigest: try directoryTreeDigest(root)), location: root))
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: root)
        let markers = names.filter { $0.hasSuffix(".pkey.json") && $0 != ".pkey.json" }
        guard markers.count == 1 else { return .refused(location: root, step: "format") }
        let name = String(markers[0].dropLast(".pkey.json".count))
        let file = root + "/" + name
        guard let marker = try readFileOrNil(root + "/" + markers[0]), let st = try statOrNil(file),
            (st.st_mode & S_IFMT) == S_IFREG
        else { return .refused(location: root, step: "format") }
        let m = try measureFile(file)
        return .baseline(EmbeddedBaseline(marker: marker, payload: .file(sha256: m.sha256, size: m.size), location: file))
    } catch {
        return .refused(location: root, step: "format")
    }
}

/// App Store Connect's asset-pack id grammar (notes/S-01 §5) and length cap.
public let ASSET_PACK_ID_MAX = 64

/// The Apple asset pack `packId` needs at content level `contentApi` (`@polaris-key/manifest`'s
/// `assetPackId`): `.` becomes `-`, then `-c<level>`. Nil when the pack id has a character outside
/// `[a-z0-9.-]`, or the result is not an App Store Connect asset-pack id.
public func appleAssetPackId(_ packId: String, contentApi: Int) -> String? {
    guard contentApi >= 0, !packId.isEmpty,
        packId.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" })
    else { return nil }
    let out = packId.replacingOccurrences(of: ".", with: "-") + "-c\(contentApi)"
    guard out.count <= ASSET_PACK_ID_MAX else { return nil }
    // ^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$
    let parts = out.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.allSatisfy({ !$0.isEmpty }) else { return nil }
    return out
}
