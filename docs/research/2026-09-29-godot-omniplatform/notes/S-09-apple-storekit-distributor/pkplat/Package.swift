// swift-tools-version: 6.0
// S-09 probe: the shape proposed for P5-05's PolarisKeyPlatform target, small enough to build
// in the simulator and under `swift test`. Swift 6 language mode, iOS 17 / macOS 14 floors like
// sdks/swift/Package.swift.
import PackageDescription

let package = Package(
    name: "PKPlatformProbe",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PKPlatform", type: .static, targets: ["PKPlatform"]),
    ],
    targets: [
        .target(name: "PKPlatform", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "PKPlatformTests",
            dependencies: ["PKPlatform"],
            resources: [.copy("Products.storekit")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
