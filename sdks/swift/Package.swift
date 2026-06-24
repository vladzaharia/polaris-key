// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PolarisKey",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        // Core: product-agnostic client + frozen JWS verifier (CryptoKit + Keychain).
        .library(name: "PolarisKey", targets: ["PolarisKey"]),
        // UI: brandable SwiftUI login/gate component layered over the core.
        .library(name: "PolarisKeyUI", targets: ["PolarisKeyUI"]),
    ],
    targets: [
        .target(
            name: "PolarisKey",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyUI",
            dependencies: ["PolarisKey"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "PolarisKeyTests",
            dependencies: ["PolarisKey", "PolarisKeyUI"],
            // Bundle the SAME cross-language corpus so the Swift verifier is held to
            // byte-for-byte conformance with the Node/Python/React runners.
            resources: [.copy("Resources/cases.json")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
