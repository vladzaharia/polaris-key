// `import PolarisKey` — the one-import surface (D-11).
//
// Polaris Key's shape is `client.<service>.<verb>`, and the modules below are the cross-platform
// ones: Core (device principal, trust, cache, clock), License (the gate), Config (settings) and
// Release (the changelog and artifact URLs, P1b-07 — Release, unlike Update, links nothing
// platform-bound, so re-exporting it costs a one-import adopter nothing). Re-exporting them means an adopter writes ONE import and still gets
// `LicenseStatus`, `JSONValue`, `TrustSet` and the rest by their plain names.
//
// PolarisKeyIdentity is re-exported too: the facade exposes `client.identity`, and its prompt and
// result types should be nameable without a second import. It depends on Core alone and links
// no third-party code, so it costs a one-import adopter nothing it would want to avoid.
//
// PolarisKeyUpdate is deliberately NOT re-exported: it is macOS-only, and §7.3 makes "the update
// module is absent ⇒ no update traffic" a LINK-TIME guarantee. Re-exporting it here would make
// every one-import adopter link Sparkle, which is exactly the property the target split exists
// to preserve. A product that ships updates adds `import PolarisKeyUpdate` and means it.
//
// PolarisKeyUI is not re-exported for the same reason in a different currency: it pulls SwiftUI
// into the dependency graph of a headless CLI that has no interest in it.

@_exported import PolarisKeyConfig
@_exported import PolarisKeyCore
@_exported import PolarisKeyIdentity
@_exported import PolarisKeyLicense
@_exported import PolarisKeyRelease
