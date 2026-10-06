// Update hand-off, verified download and feed URLs (notes/SDK-PARITY-PASS.md §3.6, §3.7, §3.16,
// SP-S10).
//
//   install(_:)       one call from a decision to the platform's updater: a store listing
//                     (App Store, TestFlight, an alternative marketplace) is opened; on macOS a
//                     binary update is handed to Sparkle when `PolarisSparkle` runs; a packs
//                     decision installs the packs. Every hand-off journals P6-03's
//                     `update_applied`. Anything else is a typed `unsupported`.
//   fetch(...)        a verified download: the build's bytes from discovery's `builds` template
//                     (never the legacy `release/dl` alias), streamed with the device bearer and
//                     the `X-PKey-*` headers, checked against the size and SHA-256 the verified
//                     release record states BEFORE the file appears at `to` (no partial file is
//                     ever left there). Streams through the client's transport into `<to>.part`
//                     and resumes it with `Range` + `If-Range`. Journals `update_downloaded`.
//   feedUrl(_:...)    the updater feeds from discovery's `update.endpoints` templates: appcast,
//                     winsparkle, velopack, appInstaller, zsync. A product that publishes no such
//                     template answers the typed N/A (`product`).

import CryptoKit
import Foundation
import PolarisKeyCore
import PolarisKeyPacks

#if os(macOS)
    import AppKit
#elseif canImport(UIKit)
    import UIKit
#endif

/// How `install(_:)` ended (§3.16).
public enum InstallOutcome: Sendable, Equatable {
    /// The installed packs (or update) take effect at the next launch.
    case restartRequired
    /// The packs are live now.
    case applied
    /// The platform's updater took over (Sparkle on macOS).
    case handedOff
    /// The store listing was opened; the store installs.
    case storeOpened(URL)
    /// Nothing to install: the decision offers no update.
    case upToDate
    case unsupported(Unsupported)
}

/// The updater feed kinds `feedUrl` expands (`update.endpoints`).
public enum UpdateFeedKind: String, Sendable, CaseIterable {
    case appcast, winsparkle, velopack, appInstaller, zsync

    /// The `update.endpoints` key the kind reads (feed-url-matrix.json `kinds`).
    var endpointKey: String { rawValue }
}

/// A feed URL, or the typed N/A (`product`) when the endpoints carry no template for the kind.
public enum FeedURLAnswer: Sendable, Equatable {
    case url(URL)
    case unsupported(Unsupported)
}

/// Expand an updater feed URL from `update.endpoints` (conformance/corpus/v2/feed-url-matrix.json,
/// the `update.feeds` proof). An absent channel is `stable`; an alias is rewritten through
/// `CHANNEL_ALIASES` first. `appcast` reads `endpoints.appcast` (the stable feed) and, for any
/// other channel, inserts the channel as a path segment before `/appcast.xml`; `velopack` without
/// a `velopackChannel` is the feed directory Velopack's UpdateManager opens (the template up to
/// `releases.`). Every value is encoded as encodeURIComponent.
public func updateFeedURL(
    _ kind: UpdateFeedKind, endpoints: [String: String], baseUrl: String, channel: String? = nil,
    velopackChannel: String? = nil, buildId: String? = nil
) -> FeedURLAnswer {
    func no(_ detail: String) -> FeedURLAnswer {
        .unsupported(
            Unsupported(feature: Feature.updateFeeds, reason: UnsupportedReason.product, detail: detail))
    }
    let requested = channel ?? CHANNEL_STABLE
    let canonical = CHANNEL_ALIASES[requested] ?? requested
    guard let template = endpoints[kind.endpointKey] else {
        return no("The product publishes no \(kind.rawValue) feed.")
    }
    if kind == .appcast {
        var url = template
        if canonical != CHANNEL_STABLE {
            let encoded = feedComponent(canonical)
            guard var parts = URLComponents(string: template),
                parts.percentEncodedPath.hasSuffix("/appcast.xml")
            else { return no("The appcast template has no /appcast.xml to place a channel before.") }
            parts.percentEncodedPath =
                String(parts.percentEncodedPath.dropLast("/appcast.xml".count)) + "/\(encoded)/appcast.xml"
            url = parts.string ?? template
        }
        guard let resolved = URL(string: url, relativeTo: URL(string: baseUrl + "/"))?.absoluteURL else {
            return no("The appcast template is not a URL.")
        }
        return .url(resolved)
    }
    var values = ["channel": canonical]
    var expanded = template
    if template.contains("{velopackChannel}") {
        if let velopackChannel {
            values["velopackChannel"] = velopackChannel
        } else if let cut = template.range(of: "releases.", options: .backwards) {
            expanded = String(template[..<cut.lowerBound])
        }
    }
    if template.contains("{buildId}") {
        guard let buildId else { return no("The \(kind.rawValue) feed needs the buildId.") }
        values["buildId"] = buildId
    }
    guard let url = expandTemplate(expanded, baseUrl: baseUrl, values) else {
        return no("The \(kind.rawValue) feed template could not be expanded.")
    }
    return .url(url)
}

/// `value` encoded as encodeURIComponent.
private func feedComponent(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics.intersection(
        CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(0x7F)))
    allowed.insert(charactersIn: "-_.!~*'()")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

/// Opens a URL with the system (the App Store app, a browser). Injected in tests.
public typealias SystemURLOpener = @Sendable (URL) async -> Bool

/// The default opener: `UIApplication.open` on iOS, `NSWorkspace.open` on macOS.
public let defaultURLOpener: SystemURLOpener = { url in
    await MainActor.run {
        #if os(macOS)
            return NSWorkspace.shared.open(url)
        #elseif canImport(UIKit) && !os(watchOS)
            UIApplication.shared.open(url)
            return true
        #else
            return false
        #endif
    }
}

/// Where `install` hands a binary update on macOS (`PolarisSparkle` registers itself).
public final class BinaryUpdateHandoff: Sendable {
    public static let shared = BinaryUpdateHandoff()
    private let action = LockedValue<(@Sendable () async -> Bool)?>(nil)

    public func set(_ handoff: (@Sendable () async -> Bool)?) { action.set(handoff) }
    public func run() async -> Bool? {
        guard let a = action.current else { return nil }
        return await a()
    }
}

extension UpdateClient {
    /// Hand `check`'s decision to the platform's updater. See the file header.
    public func install(_ check: UpdateCheck, open: SystemURLOpener = defaultURLOpener) async
        -> InstallOutcome
    {
        let feature = Feature.updateDriver
        func no(_ reason: String, _ detail: String) -> InstallOutcome {
            .unsupported(Unsupported(feature: feature, reason: reason, detail: detail))
        }
        let from = core.version
        switch check.decision {
        case .store(let release, let listing, _, _, _, _):
            guard let listing, let url = URL(string: listing) else {
                return no(
                    UnsupportedReason.outlet,
                    "The store publishes no listing link for this build; update from the store app.")
            }
            guard await open(url) else {
                return no(UnsupportedReason.runtime, "The system could not open \(listing).")
            }
            await core.journal.record(
                UpdateEvent.updateApplied, release: release.version, fromRelease: from,
                channel: check.channel)
            return .storeOpened(url)
        case .binary(_, let release, _, _, _, _, _, _):
            #if os(macOS)
                if let handed = await BinaryUpdateHandoff.shared.run(), handed {
                    await core.journal.record(
                        UpdateEvent.updateApplied, release: release.version, fromRelease: from,
                        channel: check.channel)
                    return .handedOff
                }
                return no(
                    UnsupportedReason.dependency,
                    "Start PolarisSparkle (PolarisSparkle.start(client:)) to install binary updates.")
            #else
                _ = release
                return no(
                    UnsupportedReason.outlet,
                    "iOS apps update through their outlet; the SDK opens a store link only.")
            #endif
        case .platform:
            return no(
                UnsupportedReason.outlet,
                "This build updates through the platform (the OS or its package manager).")
        case .packs(let install, _, _, _):
            do {
                let installed = try await packs.ensure(install.map(\.pack))
                return installed.contains { $0.activation == "restart" }
                    ? .restartRequired : .applied
            } catch {
                return no(UnsupportedReason.runtime, "The packs could not be installed: \(error)")
            }
        case .codeReady:
            return .restartRequired
        case .none, .blocked:
            return .upToDate
        }
    }

    /// The updater feed URL of `kind` for `channel` (default: the client's channel), from
    /// discovery's `update.endpoints` (`updateFeedURL`). Throws `UnsupportedError` (reason
    /// `product`) when the product publishes no such template, and `PolarisError(not-configured)`
    /// before discovery has run.
    public func feedUrl(
        _ kind: UpdateFeedKind, channel: String? = nil, velopackChannel: String? = nil,
        buildId: String? = nil
    ) async throws -> URL {
        guard let doc = await core.discoveryDocument else {
            throw PolarisError(
                code: ErrorCode.notConfigured, message: "Run discover() before asking for feed URLs.")
        }
        let update = doc.services[.update]
        switch updateFeedURL(
            kind, endpoints: update?.enabled == true ? update?.endpoints ?? [:] : [:],
            baseUrl: core.endpoints.baseUrl, channel: channel ?? core.channel,
            velopackChannel: velopackChannel, buildId: buildId)
        {
        case .url(let url): return url
        case .unsupported(let u): throw UnsupportedError(u)
        }
    }

    /// A verified download of one build (§3.6, `release.fetch`). `size` and `sha256` come from
    /// the verified release record. The bytes stream through the client's transport into
    /// `<to>.part`; a later call resumes it with `Range: bytes=<have>-` and `If-Range` naming the
    /// payload's strong ETag (its quoted SHA-256). A 206 appends (what is already there is
    /// re-hashed, never trusted), a 200 means the representation changed and starts over, and a
    /// 416 means the part is already whole. Size and SHA-256 are checked BEFORE the part becomes
    /// `to`, so a partial or unverified file is never left there.
    ///
    /// Throws `PolarisError`: `not-configured` (no `builds` template), `payload-mismatch` (size
    /// or hash; the part is deleted), `network` (the transfer stopped; the part is kept for the
    /// next call), or a refusal's registered wire code from its body (`download_auth_required`),
    /// else `unauthorized` / `forbidden` / `http-error` by status.
    @discardableResult
    public func fetch(
        version: String, buildId: String, size: Int?, sha256: String, to destination: URL,
        onProgress: (@Sendable (Int, Int?) -> Void)? = nil
    ) async throws -> ReleaseFetchResult {
        guard let url = await buildURL(version: version, buildId: buildId) else {
            throw PolarisError(
                code: ErrorCode.notConfigured,
                message: "Discovery names no builds template; run discover() first.")
        }
        let expected = sha256.lowercased()
        let fm = FileManager.default
        let part = destination.deletingLastPathComponent()
            .appendingPathComponent(destination.lastPathComponent + ".part")
        try? fm.createDirectory(
            at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        var have = (try? fm.attributesOfItem(atPath: part.path)[.size] as? Int) ?? 0
        if let size, have > size {
            try? fm.removeItem(at: part)
            have = 0
        }

        if have == 0 || size == nil || have < size! {
            var extra = ["accept-encoding": "identity"]
            // The bearer goes only to the control plane's own origin.
            if let token = await core.token, sameOrigin(url, core.endpoints.baseUrl) {
                extra["authorization"] = "Bearer \(token)"
            }
            if have > 0 {
                extra["range"] = "bytes=\(have)-"
                extra["if-range"] = "\"\(expected)\""
            }
            let response: PolarisStreamResponse
            do {
                response = try await core.stream(url, headers: extra)
            } catch let e as PolarisError {
                throw e
            } catch {
                throw PolarisError(code: ErrorCode.network, message: "\(error)")
            }
            switch response.status {
            case 416 where have > 0:
                break  // The part is already whole; verified below.
            case 200, 206:
                if response.status == 206 {
                    guard have > 0, rangeStart(response.header("content-range")) == have else {
                        try? fm.removeItem(at: part)
                        throw PolarisError(
                            code: ErrorCode.network,
                            message: "the server answered another range; call again to restart.")
                    }
                } else {
                    have = 0
                }
                try await write(response.body, to: part, append: have > 0, from: have, size: size, onProgress)
            default:
                let body = (try? await response.collect()) ?? Data()
                throw PolarisError(
                    code: refusalCode(status: response.status, body: body),
                    message: "the build download was refused (status \(response.status)).")
            }
        }

        // Verify against the record, then move into place.
        let (count, digest) = try hashFile(part)
        guard digest == expected, size == nil || size == count else {
            if let size, count < size {
                throw PolarisError(
                    code: ErrorCode.network,
                    message: "the download stopped at \(count) of \(size) bytes; call again to resume.")
            }
            try? fm.removeItem(at: part)
            throw PolarisError(
                code: ErrorCode.payloadMismatch,
                message: "the download does not match the release record (size \(count), sha256 \(digest)).")
        }
        try? fm.removeItem(at: destination)
        try fm.moveItem(at: part, to: destination)
        await core.journal.record(
            UpdateEvent.updateDownloaded, release: version, fromRelease: core.version,
            channel: core.channel)
        return ReleaseFetchResult(
            url: destination, size: count, sha256: digest, version: version, buildId: buildId)
    }
}

/// What `fetch` verified and where the file is.
public struct ReleaseFetchResult: Sendable, Equatable {
    public let url: URL
    public let size: Int
    public let sha256: String
    public let version: String
    public let buildId: String
}

/// True when `url` is on `baseUrl`'s origin (scheme, host and port).
private func sameOrigin(_ url: URL, _ baseUrl: String) -> Bool {
    guard let base = URL(string: baseUrl) else { return false }
    return url.scheme?.lowercased() == base.scheme?.lowercased()
        && url.host?.lowercased() == base.host?.lowercased() && url.port == base.port
}

/// The first byte of a `Content-Range: bytes <first>-<last>/<total>`, or nil.
private func rangeStart(_ header: String?) -> Int? {
    guard let header, header.lowercased().hasPrefix("bytes ") else { return nil }
    let spec = header.dropFirst("bytes ".count)
    guard let dash = spec.firstIndex(of: "-") else { return nil }
    return Int(spec[..<dash].trimmingCharacters(in: .whitespaces))
}

/// A refusal's code: the body's (flat `error` or nested `error.code`) when the error registry
/// (conformance/errors.json, `ERROR_CODE_KINDS`) knows it as a wire code, else by status.
func refusalCode(status: Int, body: Data) -> String {
    var code: String?
    if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
        if let flat = json["error"] as? String {
            code = flat
        } else if let nested = json["error"] as? [String: Any] {
            code = nested["code"] as? String
        }
    }
    if let code, ERROR_CODE_KINDS[code] == "wire" { return code }
    switch status {
    case 401: return ErrorCode.unauthorized
    case 403: return ErrorCode.forbidden
    default: return ErrorCode.httpError
    }
}

/// Stream `body` into `part` (appending at `from`, or from scratch), stopping past `size`.
/// A transfer that fails keeps what was written, for the next resume.
private func write(
    _ body: AsyncThrowingStream<Data, Error>, to part: URL, append: Bool, from: Int, size: Int?,
    _ onProgress: (@Sendable (Int, Int?) -> Void)?
) async throws {
    let fm = FileManager.default
    if !append || !fm.fileExists(atPath: part.path) {
        fm.createFile(atPath: part.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let handle = try FileHandle(forWritingTo: part)
    defer { try? handle.close() }
    if append { try handle.seekToEnd() } else { try handle.truncate(atOffset: 0) }
    var done = from
    onProgress?(done, size)
    do {
        for try await chunk in body {
            var slice = chunk
            if let size, done + slice.count > size { slice = slice.prefix(size - done) }
            if !slice.isEmpty {
                try handle.write(contentsOf: slice)
                done += slice.count
                onProgress?(done, size)
            }
            if let size, done >= size, slice.count < chunk.count { break }
        }
    } catch {
        throw PolarisError(code: ErrorCode.network, message: "\(error)")
    }
}

/// The byte count and lowercase hex SHA-256 of a file, read in chunks.
private func hashFile(_ url: URL) throws -> (Int, String) {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    var count = 0
    while let chunk = try handle.read(upToCount: 1 << 16), !chunk.isEmpty {
        hasher.update(data: chunk)
        count += chunk.count
    }
    return (count, hasher.finalize().map { String(format: "%02x", $0) }.joined())
}
