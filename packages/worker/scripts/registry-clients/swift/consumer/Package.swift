// swift-tools-version:5.9
// The Swift registry harness's consumer (F-06): depends on smoke.SmokeKit by registry identity.
// clients/swift.sh substitutes REQUIREMENT before resolving.
import PackageDescription

let package = Package(
    name: "SmokeConsumer",
    dependencies: [.package(id: "smoke.SmokeKit", REQUIREMENT)],
    targets: [
        .executableTarget(
            name: "SmokeConsumer",
            dependencies: [.product(name: "SmokeKit", package: "smoke.SmokeKit")]
        ),
    ]
)
