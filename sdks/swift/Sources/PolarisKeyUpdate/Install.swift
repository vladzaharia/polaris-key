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
//                     ever left there). Journals `update_downloaded`.
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

    /// A verified download of one build (§3.6). `size` and `sha256` come from the verified
    /// release record. Throws `PolarisError`: `not-configured` (no `builds` template),
    /// `payload-mismatch` (size or hash), `network`, or the server's code.
    @discardableResult
    public func fetch(
        version: String, buildId: String, size: Int?, sha256: String, to destination: URL,
        session: URLSession = .shared, onProgress: (@Sendable (Int, Int?) -> Void)? = nil
    ) async throws -> URL {
        guard let url = await buildURL(version: version, buildId: buildId) else {
            throw PolarisError(
                code: ErrorCode.notConfigured,
                message: "Discovery names no builds template; run discover() first.")
        }
        var request = URLRequest(url: url)
        for (k, v) in await core.headers(await core.token.map { ["authorization": "Bearer \($0)"] } ?? [:]) { request.setValue(v, forHTTPHeaderField: k) }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PolarisError(code: ErrorCode.network, message: "no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PolarisError(
                code: http.statusCode == 401 ? ErrorCode.downloadAuthRequired : ErrorCode.httpError,
                message: "download failed with status \(http.statusCode).")
        }
        let partial = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).partial")
        FileManager.default.createFile(atPath: partial.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partial)
        var hasher = SHA256()
        var count = 0
        var buffer = Data()
        buffer.reserveCapacity(1 << 16)
        do {
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= 1 << 16 {
                    hasher.update(data: buffer)
                    try handle.write(contentsOf: buffer)
                    count += buffer.count
                    buffer.removeAll(keepingCapacity: true)
                    onProgress?(count, size)
                }
            }
            if !buffer.isEmpty {
                hasher.update(data: buffer)
                try handle.write(contentsOf: buffer)
                count += buffer.count
                onProgress?(count, size)
            }
            try handle.close()
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: partial)
            throw PolarisError(code: ErrorCode.network, message: "\(error)")
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard digest == sha256.lowercased(), size == nil || size == count else {
            try? FileManager.default.removeItem(at: partial)
            throw PolarisError(
                code: ErrorCode.payloadMismatch,
                message: "the download does not match the release record (size \(count), sha256 \(digest)).")
        }
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: partial, to: destination)
        await core.journal.record(
            UpdateEvent.updateDownloaded, release: version, fromRelease: core.version,
            channel: core.channel)
        return destination
    }
}
