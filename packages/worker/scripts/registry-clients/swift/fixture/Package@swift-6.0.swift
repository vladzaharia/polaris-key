// swift-tools-version:6.0
// The Swift 6 manifest of the harness fixture: served as the `alternate` manifest link.
import PackageDescription

let package = Package(
    name: "SmokeKit",
    products: [.library(name: "SmokeKit", targets: ["SmokeKit"])],
    targets: [.target(name: "SmokeKit")]
)
