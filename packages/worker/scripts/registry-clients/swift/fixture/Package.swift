// swift-tools-version:5.9
// The Swift registry harness's fixture package (F-06): published to the local registry by
// clients/swift.seed.mjs as smoke.SmokeKit 1.0.0 (stable), 1.1.0 (yanked) and 2.0.0-beta.1
// (the beta channel), each signed by a throwaway CA generated for the run.
import PackageDescription

let package = Package(
    name: "SmokeKit",
    products: [.library(name: "SmokeKit", targets: ["SmokeKit"])],
    targets: [.target(name: "SmokeKit")]
)
