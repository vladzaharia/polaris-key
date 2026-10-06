// `client.distribution` — the download page's model (notes/SDK-PARITY-PASS.md §3.8, SP-S10).
//
//   downloadModel()  GET /<p>/distribution/download.json: the product's platforms, the ways to get
//                    it on each (stores, feeds, direct downloads, best first) and the builds.
//   thisPlatform()   the group for the platform this binary runs on, or nil.
//
// Public and unauthenticated (the same model the hosted download page renders), so it works
// before activation: an "Also on" list, a "Get it for your Mac" button, a QR to the iOS listing.

import Foundation
import PolarisKeyCore

/// One downloadable build.
public struct DistributionBuild: Sendable, Equatable, Decodable {
    public let releaseId: String
    public let version: String
    public let buildId: String
    public let platform: String
    public let arch: String
    public let format: String?
    public let name: String
    public let size: Int?
    public let sha256: String?
    public let minOs: String?
    public let url: String
    public let outletId: String
}

/// One way to get the product (a store listing, a feed, a download).
public struct DistributionAction: Sendable, Equatable, Decodable {
    public let id: String
    public let kind: String
    public let outletId: String
    public let platforms: [String]
    public let label: String
    public let url: String?
    public let deepLink: String?
    public let qr: String?
    public let command: String?
    public let version: String?
    public let build: DistributionBuild?
}

/// The actions and builds for one platform, best first.
public struct DistributionPlatform: Sendable, Equatable, Decodable {
    public let platform: String
    public let label: String
    public let primary: String?
    public let actions: [String]
    public let builds: [DistributionBuild]
}

/// The newest release any action leads to.
public struct DistributionRelease: Sendable, Equatable, Decodable {
    public let releaseId: String
    public let version: String
    public let title: String?
    public let publishedAt: Int?
    public let summary: String?
}

/// `GET /<p>/distribution/download.json`, decoded.
public struct DownloadModel: Sendable, Equatable, Decodable {
    public struct Product: Sendable, Equatable, Decodable {
        public let slug: String
        public let name: String
    }

    public let schemaVersion: Int
    public let product: Product
    public let channel: String
    public let pageUrl: String?
    public let release: DistributionRelease?
    public let platforms: [DistributionPlatform]
    public let actions: [DistributionAction]

    /// The action with `id`, if any.
    public func action(_ id: String) -> DistributionAction? { actions.first { $0.id == id } }

    /// The group for `platform` (a canonical platform value), if any.
    public func group(for platform: String) -> DistributionPlatform? {
        platforms.first { $0.platform == platform }
    }

    /// The best action for `platform`: its primary, else its first.
    public func primaryAction(for platform: String) -> DistributionAction? {
        guard let g = group(for: platform) else { return nil }
        return (g.primary ?? g.actions.first).flatMap(action)
    }
}

public final class DistributionClient: Sendable {
    private let core: CoreContext

    public init(core: CoreContext) { self.core = core }

    /// The download page's model. Throws `PolarisError`: `service-unavailable` (no
    /// Distribution), the server's code, `network`, or `invalid-response`.
    public func downloadModel() async throws -> DownloadModel {
        try await core.requireService(.distribution, feature: Feature.releaseDownload)
        let response: PolarisResponse
        do {
            response = try await core.request(core.endpoints.url("distribution/download.json"))
        } catch let e as PolarisError where e.code == PolarisError.localOnly {
            throw e
        } catch {
            throw PolarisError(code: ErrorCode.network, message: "\(error)")
        }
        guard response.isOK else {
            let body = try? JSONDecoder().decode(ServerErrorBody.self, from: response.body)
            throw PolarisError(
                code: body?.code ?? ErrorCode.httpError,
                message: "download.json failed with status \(response.status).")
        }
        do {
            return try JSONDecoder().decode(DownloadModel.self, from: response.body)
        } catch {
            throw PolarisError(code: ErrorCode.invalidResponse, message: "\(error)")
        }
    }

    /// The group for the platform this binary runs on.
    public func thisPlatform() async throws -> DistributionPlatform? {
        guard let platform = PlatformFamily.headerValue else { return nil }
        return try await downloadModel().group(for: platform)
    }
}
