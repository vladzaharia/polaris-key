// `apple-ba` (P5-08; CONTENT §7; notes/S-01): Apple-hosted Background Assets as a pack transport,
// over PolarisKeyPlatform's `AssetPackClient` (P5-05). The Swift twin of Godot's
// `PKeyPackAppleBaTransport`.
//
// One asset pack per content level, because a live asset-pack version switches every installed app
// version (CONTENT §6.6): the asset pack of `diceroll.foes` at contentApi 3 is `diceroll-foes-c3`
// (`appleAssetPackId`, the same mapping as `@polaris-key/manifest`'s `assetPackId`). `pkey transport
// apple-ba package` puts the pack's payload and marker under `pkey/<asset pack id>/` in the asset
// pack, a unique prefix in the namespace Apple merges every pack into. That directory is resolved
// with `url(for:)` on every call and never persisted; `url(for:)` returns a path even for a missing
// file, so readiness is checked on disk. An update replaces the files at the same path, so a new
// release is read at the next launch (S-01: update while mounted is safe for the running session).
//
// Unsupported (PARITY §2.2): `version` below iOS / macOS 26.4 (or an SDK without the 26.4
// methods); `outlet` in a build without the Background Assets Info.plist keys (a sideload export).
//
//   let packs = PacksOptions(
//       contentStamp: .file(stampURL),
//       platformTransport: AppleAssetPackTransport(packs: ["diceroll.foes"]))

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import PolarisKeyPlatform

/// The prefix every pack's files sit under inside its asset pack.
public let APPLE_ASSET_PACK_PREFIX = "pkey"

/// Apple-hosted Background Assets (`packs.transport.apple`).
public struct AppleAssetPackTransport: PackPlatformTransport {
    public let id = Transport.appleBa
    public let feature = Feature.packsTransportApple
    /// Apple-hosted packs float: a live asset-pack version may be newer than the build's pin.
    public let floats = true
    /// The pack ids this transport carries on this install.
    public let packs: [String]
    private let client: any AssetPackClient
    private let availability: PlatformAvailability

    /// `client` defaults to the system's `AssetPackManager` where this process may touch it, and to
    /// the unavailable client everywhere else.
    public init(
        packs: [String], client: (any AssetPackClient)? = nil, availability: PlatformAvailability = .current
    ) {
        self.packs = packs
        self.availability = availability
        self.client = client ?? Self.systemClient(availability)
    }

    private static func systemClient(_ availability: PlatformAvailability) -> any AssetPackClient {
        #if compiler(>=6.3) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
        if availability.managedAssetPacks, #available(iOS 26.4, macOS 26.4, *) {
            return SystemAssetPackClient()
        }
        #endif
        return UnavailableAssetPackClient()
    }

    public func carries(_ packId: String) -> Bool { packs.contains(packId) }

    public func unavailable() -> Unsupported? {
        if !availability.managedAssetPacks {
            return Unsupported(
                feature: feature, reason: UnsupportedReason.version,
                detail: "Apple-hosted asset packs need iOS or macOS 26.4.")
        }
        if !client.configured() {
            return Unsupported(
                feature: feature, reason: UnsupportedReason.outlet,
                detail: "This build has no Background Assets extension (the store-preset Xcode patch was not applied).")
        }
        return nil
    }

    /// The asset pack and its `pkey/<asset pack>` directory for `packId` at content level
    /// `contentApi`, or nil when the pack id has no asset-pack id there.
    public func assetPack(_ packId: String, contentApi: Int) -> (id: String, path: String)? {
        guard let id = appleAssetPackId(packId, contentApi: contentApi) else { return nil }
        return (id, APPLE_ASSET_PACK_PREFIX + "/" + id)
    }

    public func locate(_ packId: String, contentApi: Int) async throws -> String? {
        guard unavailable() == nil, let (_, rel) = assetPack(packId, contentApi: contentApi) else { return nil }
        let path = try client.url(for: rel)
        return client.fileExists(path) ? path : nil
    }

    public func ensure(
        _ packId: String, contentApi: Int, progress: @escaping @Sendable (Int, Int) -> Void
    ) async throws {
        if let u = unavailable() { throw UnsupportedError(u) }
        guard let (asset, rel) = assetPack(packId, contentApi: contentApi) else {
            throw PackError(
                ErrorCode.invalidOptions,
                "\(packId) has no Apple asset-pack id at this content level (alphanumerics and single hyphens, at most \(ASSET_PACK_ID_MAX) characters).",
                packId: packId)
        }
        let updates = client.statusUpdates(id: asset)
        let forward = Task.detached {
            for await u in updates {
                if case .downloading(let bytes, let total) = u { progress(Int(bytes), Int(total)) }
            }
        }
        defer { forward.cancel() }
        var ensureError: String?
        do {
            try await client.ensure(id: asset, requireLatest: false)
        } catch {
            ensureError = "\(error)"
        }
        // Success or not, the local status decides (S-01: a complete download can still fail).
        let status = await client.localStatus(id: asset)
        guard status.ready else {
            throw PackError(
                ErrorCode.platformError,
                "Background Assets could not make \(asset) ready: \(ensureError ?? "status " + status.flags.joined(separator: ",")).",
                packId: packId)
        }
        let path = try client.url(for: rel)
        guard client.fileExists(path) else {
            throw PackError(
                ErrorCode.platformError, "\(rel) is not in the downloaded asset pack \(asset).", packId: packId)
        }
    }
}
