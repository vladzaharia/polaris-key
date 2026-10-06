// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:services` (tools/gen-services.ts) from tools/services.json, the
// one declaration of the opt-in services. `pnpm gen:services -- --check` fails the green
// gate on any difference. To change a service, edit the table and regenerate.

/// The opt-in services, in canonical order. Core is not a service — it is always on.
public enum ServiceSlug: String, Sendable, Codable, Equatable, CaseIterable {
    case license
    case config
    case release
    case distribution
    case update
    case identity
    case sync

    /// Whether a product runs this service when it has never said otherwise.
    public var isDefaultEnabled: Bool {
        switch self {
        case .license, .config: return true
        case .release, .distribution, .update, .identity, .sync: return false
        }
    }
}
