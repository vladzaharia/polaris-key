// swift-tools-version: 6.0
import PackageDescription

// Polaris Key for Swift — wire contract v4 (docs/security/WIRE-CONTRACT-V4.md).
//
// ── WHY SEPARATE TARGETS ────────────────────────────────────────────────────────────────────
//
// Polaris Key is a suite of opt-in services over an always-on Core, and on Apple platforms that
// division is worth spending link-time on rather than only runtime flags: a product that does
// not ship updates does not link Sparkle, and a product that runs no license service does not
// carry the gate. §7.3's local-only profile is a LINK-TIME guarantee here — "PolarisKeyUpdate is
// absent ⇒ no update traffic" is a fact about the binary, not a promise about a code path.
//
//   PolarisKeyCore     device principal, credential, trust set, verified cache, clock floor,
//                   transport, discovery, bundle verification, the boot stage machine.
//                   Always on.
//   PolarisKeyLicense  the gate, activation, the license document.        (deps Core)
//   PolarisKeyConfig   the config document, layered resolution, facts, edge-mint. (deps Core)
//   PolarisKeyIdentity device-code sign-in (RFC 8628).                   (deps Core)
//   PolarisKeyRelease  the changelog and the install/download URLs.       (deps Core)
//   PolarisKeyUpdate   Sparkle wiring. macOS ONLY.                        (deps Core)
//   PolarisKeyUI       the drop-in SwiftUI gate.              (deps Core + License + Config)
//   PolarisKey      the umbrella: `PolarisKeyClient` + `@_exported import` of the
//                   cross-platform modules (Core, License, Config, Identity, Release), so a
//                   one-import adopter writes `import PolarisKey`.
//
// ── THE SPARKLE CONDITIONING (D-24) ─────────────────────────────────────────────────────────
//
// Sparkle ≥ 2.9.6 is the security floor and this package's only external dependency. 2.6.4
// fixed CVE-2025-0509 (docs/security/arch/anti-piracy-realism.md); 2.9.5 and 2.9.6 fixed a
// symlink attack in delta patching, a root privilege escalation, and package installs that
// proceeded after signature validation failed. It is macOS-only, and iOS must never try to link
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
    name: "PolarisKey",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        // The one-import surface: Core + License + Config + Identity + Release re-exported, plus
        // `PolarisKeyClient`.
        .library(name: "PolarisKey", targets: ["PolarisKey"]),
        // The substrate on its own, for a product that composes its own services.
        .library(name: "PolarisKeyCore", targets: ["PolarisKeyCore"]),
        .library(name: "PolarisKeyLicense", targets: ["PolarisKeyLicense"]),
        .library(name: "PolarisKeyConfig", targets: ["PolarisKeyConfig"]),
        // The changelog and artifact URLs. Cross-platform: an iOS app can show release notes.
        .library(name: "PolarisKeyRelease", targets: ["PolarisKeyRelease"]),
        // Device-code sign-in, for a product that runs Identity.
        .library(name: "PolarisKeyIdentity", targets: ["PolarisKeyIdentity"]),
        // macOS only — see the conditioning note above.
        .library(name: "PolarisKeyUpdate", targets: ["PolarisKeyUpdate"]),
        // Brandable SwiftUI login/gate components layered over the services.
        .library(name: "PolarisKeyUI", targets: ["PolarisKeyUI"]),
    ],
    dependencies: [
        // D-24: Sparkle continues as the update mechanism. 2.9.6 is the security floor: the
        // delta-patch symlink and privilege-escalation fixes (2.9.5/2.9.6) on top of
        // CVE-2025-0509 (2.6.4).
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.6")
    ],
    targets: [
        .target(
            name: "PolarisKeyCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyLicense",
            dependencies: ["PolarisKeyCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyConfig",
            dependencies: ["PolarisKeyCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyRelease",
            dependencies: ["PolarisKeyCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyIdentity",
            dependencies: ["PolarisKeyCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyUpdate",
            dependencies: [
                "PolarisKeyCore",
                .product(
                    name: "Sparkle", package: "Sparkle",
                    condition: .when(platforms: [.macOS])),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKey",
            dependencies: [
                "PolarisKeyCore", "PolarisKeyLicense", "PolarisKeyConfig", "PolarisKeyIdentity",
                "PolarisKeyRelease",
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyUI",
            dependencies: ["PolarisKeyCore", "PolarisKeyLicense", "PolarisKeyConfig"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "PolarisKeyTests",
            dependencies: [
                "PolarisKey", "PolarisKeyCore", "PolarisKeyLicense", "PolarisKeyConfig",
                "PolarisKeyIdentity", "PolarisKeyUI", "PolarisKeyUpdate", "PolarisKeyRelease",
            ],
            // Bundle the SAME cross-language corpus (cases, gate-matrix, fingerprint, stage-matrix,
            // headers, config-matrix, and wire contract v4's update-matrix and outlet-matrix) the
            // Node and Python runners drive, so the Swift verifier, gate, bundle importer and boot
            // stage machine are held to byte-for-byte conformance. `.copy` bundles the directory
            // whole, so a new corpus file needs no entry here. The `v2` segment is kept so this path
            // matches `conformance/corpus/v2/` one-for-one — the mirror is findable from the
            // source without a translation step. Written by `pnpm gen:corpus`, guarded by
            // `--check`. `Resources/transcripts` is the same arrangement for the HTTP transcripts
            // (`conformance/transcripts/`), written and guarded by `pnpm gen:transcripts`.
            resources: [
                .copy("Resources/v2"),
                .copy("Resources/transcripts"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
