// swift-tools-version: 6.0
import PackageDescription

// The Polaris suite for Swift — wire contract v3 (docs/security/WIRE-CONTRACT-V3.md).
//
// ── WHY FIVE TARGETS ────────────────────────────────────────────────────────────────────────
//
// Polaris is a suite of opt-in services over an always-on Core, and on Apple platforms that
// division is worth spending link-time on rather than only runtime flags: a product that does
// not ship updates does not link Sparkle, and a product that runs no license service does not
// carry the gate. §7.3's local-only profile is a LINK-TIME guarantee here — "PolarisUpdate is
// absent ⇒ no update traffic" is a fact about the binary, not a promise about a code path.
//
//   PolarisCore     device principal, credential, trust set, verified cache, clock floor,
//                   transport, discovery, bundle verification. Always on.
//   PolarisLicense  the gate, activation, the license document.        (deps Core)
//   PolarisConfig   the config document, layered resolution, facts.    (deps Core)
//   PolarisUpdate   Sparkle wiring. macOS ONLY.                        (deps Core)
//   PolarisUI       the drop-in SwiftUI gate.              (deps Core + License + Config)
//   Polaris         the umbrella: `PolarisClient` + `@_exported import` of the three
//                   always-relevant modules, so a one-import adopter writes `import Polaris`.
//
// ── THE SPARKLE CONDITIONING (D-24) ─────────────────────────────────────────────────────────
//
// Sparkle ≥ 2.6.4 is the CVE-2025-0509 floor (docs/security/arch/anti-piracy-realism.md) and
// this package's only external dependency. It is macOS-only, and iOS must never try to link
// it, so the conditioning is applied in BOTH places it can be:
//
//   1. the PRODUCT dependency carries `.when(platforms: [.macOS])`, so an iOS build never
//      links the XCFramework; and
//   2. every Sparkle-touching source file is `#if os(macOS)`-guarded, so an iOS build never
//      even parses an `import Sparkle`.
//
// One without the other is not enough: a conditioned product with an unguarded `import` fails
// to compile on iOS, and a guarded import with an unconditioned product still drags a macOS
// XCFramework into an iOS link line.
let package = Package(
    name: "Polaris",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        // The one-import surface: Core + License + Config re-exported, plus `PolarisClient`.
        .library(name: "Polaris", targets: ["Polaris"]),
        // The substrate on its own, for a product that composes its own services.
        .library(name: "PolarisCore", targets: ["PolarisCore"]),
        .library(name: "PolarisLicense", targets: ["PolarisLicense"]),
        .library(name: "PolarisConfig", targets: ["PolarisConfig"]),
        // macOS only — see the conditioning note above.
        .library(name: "PolarisUpdate", targets: ["PolarisUpdate"]),
        // Brandable SwiftUI login/gate components layered over the services.
        .library(name: "PolarisUI", targets: ["PolarisUI"]),
    ],
    dependencies: [
        // D-24: Sparkle continues as the update mechanism; 2.6.4 is the CVE-2025-0509 floor.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.4")
    ],
    targets: [
        .target(
            name: "PolarisCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisLicense",
            dependencies: ["PolarisCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisConfig",
            dependencies: ["PolarisCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisUpdate",
            dependencies: [
                "PolarisCore",
                .product(
                    name: "Sparkle", package: "Sparkle",
                    condition: .when(platforms: [.macOS])),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "Polaris",
            dependencies: ["PolarisCore", "PolarisLicense", "PolarisConfig"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisUI",
            dependencies: ["PolarisCore", "PolarisLicense", "PolarisConfig"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "PolarisTests",
            dependencies: [
                "Polaris", "PolarisCore", "PolarisLicense", "PolarisConfig", "PolarisUI",
                "PolarisUpdate",
            ],
            // Bundle the SAME cross-language corpus + gate-matrix + fingerprint fixtures the
            // Node/Python/React runners drive, so the Swift verifier, gate and bundle importer
            // are held to byte-for-byte conformance. `Resources/v2` is wire contract v3 and is
            // what every runner below reads; the flat v1 files are the frozen wire-v2 corpus,
            // still mirrored (and still drift-gated) until P8 deletes corpus/v1 outright.
            // Both sets are written by `pnpm gen:corpus`, guarded by `--check`.
            resources: [
                .copy("Resources/cases.json"),
                .copy("Resources/gate-matrix.json"),
                .copy("Resources/fingerprint.json"),
                .copy("Resources/v2"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
