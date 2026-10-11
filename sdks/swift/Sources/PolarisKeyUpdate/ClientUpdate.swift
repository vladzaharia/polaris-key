// `client.update` (notes/SDK-PARITY-PASS.md §2.4, SP-S03).
//
// The umbrella `PolarisKey` never links Sparkle, packs or libzstd, so the update client cannot
// be a stored property of `PolarisKeyClient`. Importing `PolarisKeyUpdate` adds it lazily over
// the client's Core. A packs host passes its `PacksClient` as `UpdateClientOptions.content`.

import Foundation
import PolarisKey
import PolarisKeyCore

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

    /// The update client: `check`, `decide`, the channel feed, release records and Sparkle
    /// helpers. Built on first read from the client's release-key pins; without pins it is the
    /// check-only client (`decide()` raises `not-configured`, or `invalid-options` when pins fail).
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

}

// ── Boot hooks (§3.4) ───────────────────────────────────────────────────────────────────────

extension PolarisKeyClient {
    /// Install `client.boot()`'s signed-decision stage. A packs host supplies content through
    /// `UpdateClientOptions.content`, whose hooks are composed below without linking packs here.
    public nonisolated func installUpdateBootHooks() {
        let update = self.update
        var hooks = bootHooks
        if !pinnedReleaseKeys.isEmpty {
            hooks.decide = {
                guard let check = try? await update.decide() else { return BootEvent.Decision.none }
                return bootDecision(check.decision)
            }
        }
        if let content = update.content, content.configured {
            hooks.fetch = { send in
                do {
                    let result = try await content.bootFetchStage(send: send)
                    return BootFetchAnswer(result: result.result, installed: result.installed)
                } catch {
                    return BootFetchAnswer(result: .failed, installed: [])
                }
            }
            hooks.packOptions = {
                guard let lists = try? await content.bootPackLists() else {
                    return BootPackLists(required: [], essential: [])
                }
                return BootPackLists(required: lists.required, essential: lists.essential)
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
