// `import Polaris` — the one-import surface (D-11).
//
// The suite's shape is `client.<service>.<verb>`, and the three modules below are the ones every
// product touches: Core (device principal, trust, cache, clock), License (the gate), Config
// (settings). Re-exporting them means an adopter writes ONE import and still gets
// `LicenseStatus`, `JSONValue`, `TrustSet` and the rest by their plain names.
//
// PolarisUpdate is deliberately NOT re-exported: it is macOS-only, and §7.3 makes "the update
// module is absent ⇒ no update traffic" a LINK-TIME guarantee. Re-exporting it here would make
// every one-import adopter link Sparkle, which is exactly the property the target split exists
// to preserve. A product that ships updates adds `import PolarisUpdate` and means it.
//
// PolarisUI is not re-exported for the same reason in a different currency: it pulls SwiftUI
// into the dependency graph of a headless CLI that has no interest in it.

@_exported import PolarisConfig
@_exported import PolarisCore
@_exported import PolarisLicense
