// swift-tools-version: 6.0
import PackageDescription

// The Swift live-peer driver (CC-29X.2): a macOS executable over PolarisKey's local links, behind the
// JSON-lines contract in tools/live-peer/README.md. It lives outside the SDK package and references it
// by path, so sdks/swift/Package.swift is unchanged and nothing here is published.
let package = Package(
    name: "live-peer-swift",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../../../../../sdks/swift")],
    targets: [
        .executableTarget(
            name: "live-peer-swift",
            dependencies: [.product(name: "PolarisKey", package: "swift")],
            path: "Sources/live-peer-swift",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
