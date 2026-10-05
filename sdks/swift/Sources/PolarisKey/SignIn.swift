// Client-level forms of the sign-in conveniences (notes/SDK-PARITY-PASS.md §3.12). The canonical
// names live on `client.identity` — `signInWithBrowser()`, `signOut()`, `current()` — as in every
// SDK; these forward to them.

import Foundation
import PolarisKeyCore
import PolarisKeyIdentity

extension PolarisKeyClient {
    /// `identity.signInWithBrowser(deviceName:browser:)`.
    public func signInWithBrowser(
        deviceName: String? = nil, browser: (any SignInBrowser)? = nil
    ) async throws -> SignInResult {
        try await identity.signInWithBrowser(deviceName: deviceName, browser: browser)
    }

    /// `identity.signOut()`.
    public func signOut() async throws {
        try await identity.signOut()
    }

    /// The earlier name of `identity.current()`.
    @available(*, deprecated, renamed: "identity.current()")
    public func currentIdentity() async -> CurrentIdentity? {
        await identity.current()
    }
}
