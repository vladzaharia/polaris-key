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
        let result = try attachments.with { table in
            if table[Self.updateKey] != nil {
                throw PolarisError(
                    code: ErrorCode.invalidOptions,
                    message: "client.update is already built; call configureUpdate(_:) before the first read.")
            }
            table[Self.updateKey] = built
            return built
        }
        installUpdateBootHooks()
        return result
    }

    /// The update client: `check`, `decide`, the channel feed, release records, Sparkle helpers,
    /// and `packs`. Built on first read from the client's release-key pins; without pins it is
    /// the check-only client (`decide()` raises `not-configured`, or `invalid-options` when the pins were refused).
    public nonisolated var update: UpdateClient {
        var fresh = false
        let client = attachments.with { table -> UpdateClient in
            if let existing = table[Self.updateKey] as? UpdateClient { return existing }
            fresh = true
            let built: UpdateClient
            if pinnedReleaseKeys.isEmpty {
                built = UpdateClient(core: core)
            } else {
                do {
                    built = try UpdateClient(
                        core: core, options: UpdateClientOptions(pinnedReleaseKeys: pinnedReleaseKeys))
                } catch {
                    // Refused pins are not "no pins": keep the refusal so `decide()` names it.
                    let reason =
                        (error as? PolarisError)
                        ?? PolarisError(code: ErrorCode.invalidOptions, message: "\(error)")
                    built = UpdateClient(core: core, configurationError: reason)
                }
            }
            table[Self.updateKey] = built
            return built
        }
        if fresh { installUpdateBootHooks() }
        return client
    }

    /// The pack facet (`update.packs`).
    public nonisolated var packs: PacksClient { update.packs }
}

// ── Boot hooks (§3.4) ───────────────────────────────────────────────────────────────────────

extension PolarisKeyClient {
    /// Install `client.boot()`'s decide and fetch stages over the update client: the signed
    /// decision (when release keys are pinned) and the required packs (when the content stamp
    /// names any). Called by `client.update`'s first read; call again after `configureUpdate`.
    public nonisolated func installUpdateBootHooks() {
        let update = self.update
        let packs = update.packs
        var hooks = BootHooks()
        if !pinnedReleaseKeys.isEmpty {
            hooks.decide = {
                guard let check = try? await update.decide() else { return BootEvent.Decision.none }
                return bootDecision(check.decision)
            }
        }
        if packs.configured {
            hooks.fetch = { send in
                do {
                    let r = try await packs.bootFetch(send: send)
                    return BootFetchAnswer(result: r.result, installed: r.installed)
                } catch {
                    return BootFetchAnswer(result: .failed, installed: [])
                }
            }
            hooks.packOptions = {
                guard let o = try? await packs.bootOptions() else {
                    return BootPackLists(required: [], essential: [])
                }
                return BootPackLists(required: o.requiredPacks, essential: o.essentialPacks)
            }
        }
        setBootHooks(hooks)
    }

    /// Mark this launch (the app boot guard, §3.15).
    @discardableResult
    public func markBootAttempt() async -> BootGuardOutcome { await bootGuard.markBootAttempt() }

    /// This launch is healthy (§3.15).
    public func confirmBoot() async { await bootGuard.confirmBoot() }
}

/// The boot machine's `decide.done` for an update decision: a mandatory offer is `required`,
/// any other offer `optional`, everything else `none`.
public func bootDecision(_ decision: UpdateDecision) -> BootEvent.Decision {
    switch decision {
    case .binary(_, _, _, let mandatory, _, _, _, _), .store(_, _, let mandatory, _, _, _),
        .platform(_, let mandatory, _, _, _):
        return mandatory ? .required : .optional
    case .codeReady: return .optional
    case .none, .blocked, .packs: return .none
    }
}
