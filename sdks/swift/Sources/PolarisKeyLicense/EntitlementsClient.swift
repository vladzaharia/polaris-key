// The `entitlements` namespace (SP-35b): a thin view over the licence gate. It holds no state of
// its own; every read goes through the same `LicenseClient` the app already has.

import Foundation
import PolarisKeyCore

public struct EntitlementsClient: Sendable {
    private let license: LicenseClient

    public init(license: LicenseClient) {
        self.license = license
    }

    /// Whether the licence grants the boolean entitlement `name`. False whenever the gate is not
    /// usable (S-19 G11): a revoked, expired or blocked device holds a signed document that still
    /// lists its grants, and reading them past the gate would keep paid features on after a
    /// revocation.
    public func has(_ name: String, now: Int? = nil) async -> Bool {
        guard await license.isLicensed(now: now) else { return false }
        return await license.documentEntitlements()[name]?.boolValue == true
    }

    /// The raw value of entitlement `name` (a number, string, list or object), or nil when the
    /// licence does not carry it or the gate is not usable (G11).
    public func value(_ name: String, now: Int? = nil) async -> JSONValue? {
        guard await license.isLicensed(now: now) else { return nil }
        return await license.documentEntitlements()[name]
    }

    /// Every entitlement's value off the held document; empty when no licence is held.
    public func all() async -> [String: JSONValue] {
        await license.documentEntitlements()
    }
}
