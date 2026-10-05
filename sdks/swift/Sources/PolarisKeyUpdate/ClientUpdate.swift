// `client.update` and `client.packs` (notes/SDK-PARITY-PASS.md §2.4, SP-S03).
//
// The umbrella `PolarisKey` never links Sparkle or libzstd, so the update client cannot be a
// stored property of `PolarisKeyClient`. Importing `PolarisKeyUpdate` adds both as properties
// instead: the first read builds ONE `UpdateClient` over the client's Core, with the release-key
// pins the client was built with (`PolarisKeyClientOptions.pinnedReleaseKeys`, which
// `fromBundle()` reads from `PolarisKey.plist`), and every later read returns the same instance.
// A host that needs other update options (an outlet, packs, methods) calls
// `configureUpdate(_:)` once, before the first read.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyPacks

/// The attachment key for the update client.
private final class UpdateAttachment {}

extension PolarisKeyClient {
    private static var updateKey: ObjectIdentifier { ObjectIdentifier(UpdateAttachment.self) }

    /// Build the update client with `options` (their `pinnedReleaseKeys` default to the client's
    /// own when empty). Throws `invalid-options`, or `PolarisError(invalid-options)` when the
    /// update client was already built: configure before the first `client.update` read.
    @discardableResult
    public nonisolated func configureUpdate(_ options: UpdateClientOptions) throws -> UpdateClient {
        var options = options
        if options.pinnedReleaseKeys.isEmpty { options.pinnedReleaseKeys = pinnedReleaseKeys }
        let built = try UpdateClient(core: core, options: options)
        return try attachments.with { table in
            if table[Self.updateKey] != nil {
                throw PolarisError(
                    code: ErrorCode.invalidOptions,
                    message: "client.update is already built; call configureUpdate(_:) before the first read.")
            }
            table[Self.updateKey] = built
            return built
        }
    }

    /// The update client: `check`, `decide`, the channel feed, release records, Sparkle helpers,
    /// and `packs`. Built on first read from the client's release-key pins; without pins it is
    /// the check-only client (`decide()` raises `not-configured`).
    public nonisolated var update: UpdateClient {
        attachments.with { table in
            if let existing = table[Self.updateKey] as? UpdateClient { return existing }
            let built: UpdateClient
            if pinnedReleaseKeys.isEmpty {
                built = UpdateClient(core: core)
            } else {
                built =
                    (try? UpdateClient(
                        core: core, options: UpdateClientOptions(pinnedReleaseKeys: pinnedReleaseKeys)))
                    ?? UpdateClient(core: core)
            }
            table[Self.updateKey] = built
            return built
        }
    }

    /// The pack facet (`update.packs`).
    public nonisolated var packs: PacksClient { update.packs }
}
