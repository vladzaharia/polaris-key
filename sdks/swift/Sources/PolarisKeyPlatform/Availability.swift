// Which OS-gated APIs this process may call, as a value, so the gating logic is testable with a
// fake: `swift test` runs on one OS version, and the acceptance criteria need "below iOS 17.4",
// "below 17.5" and "26.0–26.3" answered by the same code paths that run on a device.
//
//   appDistributor       AppDistributor.current                 iOS 17.4
//   appDistributorWeb    the AppDistributor `web` case          iOS 17.5
//   managedAssetPacks    AssetPackManager's 26.4 methods        iOS / macOS 26.4, and an SDK
//                        (localStatus, ensureLocalAvailability    that has them (Xcode 26.4,
//                        (of:requireLatestVersion:), …)           Swift 6.3)
//   assetPackManifest    AssetPackManager.manifest              iOS / macOS 27 (Xcode 27 SDK)
//   entitlementsForID    Transaction.currentEntitlements(for:)  iOS 18.4 / macOS 15.4
//
// The package floor stays iOS 17 / macOS 14 (sdks/swift/Package.swift); nothing here raises it.

import Foundation

public struct PlatformAvailability: Sendable, Equatable {
    public var appDistributor: Bool
    public var appDistributorWeb: Bool
    public var managedAssetPacks: Bool
    public var assetPackManifest: Bool
    public var entitlementsForID: Bool

    public init(
        appDistributor: Bool, appDistributorWeb: Bool, managedAssetPacks: Bool,
        assetPackManifest: Bool = false, entitlementsForID: Bool = false
    ) {
        self.appDistributor = appDistributor
        self.appDistributorWeb = appDistributorWeb
        self.managedAssetPacks = managedAssetPacks
        self.assetPackManifest = assetPackManifest
        self.entitlementsForID = entitlementsForID
    }

    /// Nothing gated is available.
    public static let none = PlatformAvailability(appDistributor: false, appDistributorWeb: false, managedAssetPacks: false)

    /// This process.
    public static var current: PlatformAvailability {
        var a = PlatformAvailability.none
        #if os(iOS) && canImport(MarketplaceKit)
        // AppDistributor (17.4) and its `web` case (17.5) are below the iOS 18 floor.
        a.appDistributor = true
        a.appDistributorWeb = true
        #endif
        #if compiler(>=6.3) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
        if #available(iOS 26.4, macOS 26.4, *) { a.managedAssetPacks = true }
        #endif
        #if compiler(>=6.4) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
        if #available(iOS 27, macOS 27, *) { a.assetPackManifest = true }
        #endif
        #if compiler(>=6.1) && canImport(StoreKit)
        if #available(iOS 18.4, macOS 15.4, *) { a.entitlementsForID = true }
        #endif
        return a
    }
}
