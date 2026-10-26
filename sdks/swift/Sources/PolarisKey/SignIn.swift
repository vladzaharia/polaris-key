// Client-level forms of the sign-in conveniences (notes/SDK-PARITY-PASS.md §3.12). The canonical
// names live on `client.identity` — `signIn.start()`, `signOut()`, `current()` — as in every
// SDK; these forward to them.

import Foundation
import PolarisKeyCore
import PolarisKeyIdentity

extension PolarisKeyClient {
    /// `identity.signOut()`.
    @discardableResult
    public func signOut() async throws -> SignOutResult {
        try await identity.signOut()
    }

    /// The earlier name of `identity.current()`.
    @available(*, deprecated, renamed: "identity.current()")
    public func currentIdentity() async -> CurrentIdentity? {
        await identity.current()
    }
}
