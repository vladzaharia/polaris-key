// swift-tools-version:5.9
//
// A trimmed manifest for swiftlang/swift-package-registry-compatibility-test-suite (F-06).
//
// Upstream's Package.swift no longer resolves: its example server's dependencies (Vapor,
// postgres-nio, swift-service-lifecycle 1.x) conflict. The compatibility CLI needs none of
// them, so the harness (`clients/swift-compat.sh`) copies this file over the pinned checkout's
// manifest and builds only `package-registry-compatibility` and the client library it uses.
// Nothing here is published; the checkout lives in a temp directory.

import PackageDescription

let package = Package(
    name: "swift-package-registry-compatibility-test-suite",
    platforms: [.macOS("13.0")],
    products: [
        .executable(name: "package-registry-compatibility", targets: ["PackageRegistryCompatibilityTestSuite"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.21.0"),
        .package(url: "https://github.com/apple/swift-atomics.git", from: "1.2.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
        .package(url: "https://github.com/swiftlang/swift-tools-support-core.git", from: "0.6.0"),
    ],
    targets: [
        .target(name: "PackageRegistryClient", dependencies: [
            .product(name: "AsyncHTTPClient", package: "async-http-client"),
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "Atomics", package: "swift-atomics"),
            .product(name: "Logging", package: "swift-log"),
        ]),
        .executableTarget(name: "PackageRegistryCompatibilityTestSuite",
                          dependencies: [
                              "PackageRegistryClient",
                              .product(name: "ArgumentParser", package: "swift-argument-parser"),
                              .product(name: "AsyncHTTPClient", package: "async-http-client"),
                              .product(name: "NIOCore", package: "swift-nio"),
                              .product(name: "NIOFoundationCompat", package: "swift-nio"),
                              .product(name: "Atomics", package: "swift-atomics"),
                              .product(name: "Crypto", package: "swift-crypto"),
                              .product(name: "SwiftToolsSupport-auto", package: "swift-tools-support-core"),
                          ],
                          exclude: ["README.md"]),
    ]
)
