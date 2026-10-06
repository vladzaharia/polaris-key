// Crash-report tags (crash.tags, notes/SDK-PARITY-PASS.md §3.14): the three values the Worker's
// Sentry hook (packages/worker/src/services/distribution/sentry.ts) maps an alert on to the staged
// rollout it came from. No crash SDK is linked: a host passes these to its own reporter
// (`SentrySDK.start { $0.releaseName = tags.release; $0.environment = tags.environment }` and
// `scope.setTag(value: outlet, key: "pkey.outlet")`).
//
//   release      `<deliverable>@<version>[+<build>]` (`app@1.4.0+12`), what parseSentryRelease
//                reads back
//   environment  the release channel
//   pkey.outlet  the outlet id; LEFT OUT when unknown, because the hook matches it exactly and a
//                missing tag makes every self-hosted rollout of that release a candidate, where
//                `unknown` would match none

import Foundation

/// The tags a crash reporter attaches (the Worker's Sentry convention).
public struct CrashTags: Sendable, Equatable {
    /// `<deliverable>@<version>[+<build>]`.
    public let release: String
    /// The release channel.
    public let environment: String
    /// The outlet id the install came from, or nil when it is not known.
    public let outlet: String?

    public init(release: String, environment: String, outlet: String?) {
        self.release = release
        self.environment = environment
        self.outlet = outlet
    }

    /// The tags as Sentry spells them: `release`, `environment` and `pkey.outlet` (when known).
    public var dictionary: [String: String] {
        var out = ["release": release, "environment": environment]
        if let outlet { out["pkey.outlet"] = outlet }
        return out
    }
}

/// Build the crash tags from explicit values (`client.crashTags()` fills them from the client).
/// An empty `build` writes no `+`; an empty or `unknown` outlet is left out.
public func crashTagsFor(
    version: String, channel: String, outlet: String? = nil, deliverable: String = "app",
    build: String? = nil
) -> CrashTags {
    let suffix = build.map { $0.isEmpty ? "" : "+\($0)" } ?? ""
    let known = outlet.flatMap { $0.isEmpty || $0 == OUTLET_UNKNOWN ? nil : $0 }
    return CrashTags(
        release: "\(deliverable)@\(version)\(suffix)", environment: channel, outlet: known)
}
