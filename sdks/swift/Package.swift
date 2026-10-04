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
//   PolarisKeyPacks    packs (plans/P4-01.md, P4-07): the planner, the appliers, the install
//                   state, the pipeline and the `update.packs` facet. macOS AND iOS: it links
//                   libzstd (the official facebook/zstd SwiftPM package, pinned 1.5.7, since
//                   Apple's Compression has no zstd) and never Sparkle.       (deps Core, libzstd)
//   PolarisKeyUpdate   the update client (`UpdateClient`, its `packs` facet) and the Sparkle
//                   wiring, which alone is macOS ONLY.    (deps Core, Packs, Platform, Sparkle)
//   PolarisKeyPlatform the Apple platform edges (P5-05): AppDistributor, AppTransaction,
//                   StoreKit 2, Keychain and Background Assets. STANDALONE: it depends on no
//                   other target, so the Godot GDExtension (sdks/godot/native/ios/) and later
//                   Unity, MAUI and Tauri link it alone. Code that needs an Xcode 26+ SDK is
//                   behind `#if compiler(>=6.3/6.4)`, because the macos-15 job compiles this
//                   package with Xcode 16.4.                                   (deps none)
//   PolarisKeyPlatformC the C surface over it (`pkp_call`, `pkp_free`,
//                   `pkp_set_event_callback`), linked by native hosts only, so a Swift
//                   consumer of PolarisKeyPlatform exports no `pkp_*` symbols.  (deps Platform)
//   PolarisKeyUI       the drop-in SwiftUI gate.              (deps Core + License + Config)
//   PolarisKey      the umbrella: `PolarisKeyClient` + `@_exported import` of the
//                   cross-platform modules (Core, License, Config, Identity, Release), so a
//                   one-import adopter writes `import PolarisKey`.
//
// ── THE SPARKLE CONDITIONING (D-24) ─────────────────────────────────────────────────────────
//
// Sparkle ≥ 2.9.6 is the security floor and this package's only external dependency. 2.6.4
// fixed CVE-2025-0509 (the anti-piracy-realism review); 2.9.5 and 2.9.6 fixed a
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
        // Packs (P4-07): cross-platform, no Sparkle.
        .library(name: "PolarisKeyPacks", targets: ["PolarisKeyPacks"]),
        // Sparkle is macOS only — see the conditioning note above.
        .library(name: "PolarisKeyUpdate", targets: ["PolarisKeyUpdate"]),
        // Brandable SwiftUI login/gate components layered over the services.
        .library(name: "PolarisKeyUI", targets: ["PolarisKeyUI"]),
        // The Apple platform edges (P5-05), and their C surface for native hosts (only a native
        // host links PolarisKeyPlatformC, so Swift consumers export no `pkp_*` symbols).
        .library(name: "PolarisKeyPlatform", targets: ["PolarisKeyPlatform"]),
        .library(name: "PolarisKeyPlatformC", targets: ["PolarisKeyPlatformC"]),
    ],
    dependencies: [
        // D-24: Sparkle continues as the update mechanism. 2.9.6 is the security floor: the
        // delta-patch symlink and privilege-escalation fixes (2.9.5/2.9.6) on top of
        // CVE-2025-0509 (2.6.4).
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.6"),
        // P4-07: libzstd for packs (plain frames and `zstd --patch-from` raw-prefix deltas).
        // Pinned exactly: the content corpus's blobs are zstd 1.5.7 output, and PARITY §6.2
        // names this package. BSD-3-Clause.
        .package(url: "https://github.com/facebook/zstd", exact: "1.5.7"),
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
            name: "PolarisKeyPacks",
            dependencies: [
                "PolarisKeyCore",
                .product(name: "libzstd", package: "zstd"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyPlatform",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyPlatformC",
            dependencies: ["PolarisKeyPlatform"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "PolarisKeyUpdate",
            dependencies: [
                "PolarisKeyCore",
                "PolarisKeyPacks",
                // The one AppDistributor call lives in PolarisKeyPlatform (P5-05).
                "PolarisKeyPlatform",
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
            // The launch kit's Rubik (with its OFL), the bit-less Pinned K and the "Powered by"
            // badges, unchanged from packages/brand/kit (tools/sync-brand-assets.sh;
            // BrandAssetTests checks the bytes).
            resources: [.copy("Resources/Brand")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "PolarisKeyTests",
            dependencies: [
                "PolarisKey", "PolarisKeyCore", "PolarisKeyLicense", "PolarisKeyConfig",
                "PolarisKeyIdentity", "PolarisKeyUI", "PolarisKeyUpdate", "PolarisKeyRelease",
                "PolarisKeyPacks", .product(name: "libzstd", package: "zstd"),
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
        // PolarisKeyPlatform against fakes only: StoreKit Testing loads no products under
        // `swift test`, and the Keychain answers -34018 without a host app (S-09). The StoreKit
        // tests run in the hosted XCTest project under PlatformHostTests/ instead.
        .testTarget(
            name: "PolarisKeyPlatformTests",
            dependencies: ["PolarisKeyPlatform", "PolarisKeyPlatformC"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
