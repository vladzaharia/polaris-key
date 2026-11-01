// Silent restore, rung 2 of the automatic sign-in ladder (WIRE-CONTRACT-V5 §12.11.8, I-49.9).
//
// A device that was signed in keeps a restore key in an end-to-end platform backup (the synchronizable
// Keychain item of `PlatformBackupStore`). A new device of the same person redeems it, once, and is
// signed in with no click.
//
//   rung 2   read the item; the `restore` grant with proof value `<restore_id>.<device_key>` and the
//            SHA-256 of the secret on line 6 (`DeviceProofPurpose.restore`); `200` is a sign-in,
//            `confirm` / `choose` are the exchange's results and enrolment follows `choice.complete`
//   enrol    after any completed sign-in, from any rung, and on rung 1 at most once every 24 hours:
//            `POST restore {restoreId of the item}`; the item is written only on a `201`
//   sign-out `DELETE restore`, the synchronizable item, and the signed-out flag (CoreContext, outside
//            every backup): while the flag is set rung 2 does not run and nothing is enrolled
//
// Rules this file keeps:
//   - the item is the platform backup's, behind the `RestoreItemStore` port. The Apple adapter is
//     `PlatformBackupStore` (the umbrella wires it). An unavailable store (no entitlement, no iCloud
//     Keychain) reads as "no item": the ladder goes on to rung 3 and nothing is enrolled;
//   - a refusal leaves the item alone. A synchronizable delete reaches every device on the Apple ID, and
//     a newer write may be on its way, so `invalid_grant` is never a reason to delete (Android's local
//     item is the one that deletes). `429`, `5xx`, a network failure and an unavailable store leave it too;
//   - a key that was consumed and then refused (`terms`, `device_limit`, `not_entitled`, ...) falls to
//     rung 3. The next enrolment replaces the dead key;
//   - sign-out deletes the item and sends `DELETE restore` first, while the bearer still exists, whatever
//     the Worker's own `signout` then answers (or if it cannot be reached). A DELETE that cannot be
//     delivered is queued (a local record, kept out of device backups) and retried before any other call
//     at the next launch, and before any enrolment. The Worker's own `signout` also deletes this device's
//     key in the same request, so the queue is cleared once that is accepted;
//   - rung 1's daily check runs detached, after the sign-in result is returned; a failure is swallowed and
//     the next launch checks again. A sign-out waits for one in flight, then revokes what it enrolled;
//   - the secret is never logged, printed or put in an error: `RestoreItem` redacts it.

import Foundation
import PolarisKeyCore
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

/// The restore key the platform backup carries: an id and a secret. Printing it shows the secret `[redacted]`.
public struct RestoreItem: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// `rk_` and 22 base64url characters.
    public let restoreId: String
    /// `rs_` and 43 base64url characters. A secret.
    public let secret: String

    public init(restoreId: String, secret: String) {
        self.restoreId = restoreId
        self.secret = secret
    }

    public var description: String { "RestoreItem(restoreId: \(restoreId), secret: \(redactedCredential))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self, children: ["restoreId": restoreId, "secret": redactedCredential], displayStyle: .struct)
    }
}

/// The platform backup has no restore item store here (no entitlement, no iCloud Keychain).
public enum RestoreStoreError: Error, Sendable, Equatable {
    case unavailable
}

/// Where the restore item lives: the platform backup. One item per product (and per access group).
/// Every call may throw `RestoreStoreError.unavailable`, which a caller treats as "no backup here".
public protocol RestoreItemStore: Sendable {
    func read() async throws -> RestoreItem?
    func write(_ item: RestoreItem) async throws
    /// An absent item is success. On Apple this reaches every device on the Apple ID.
    func delete() async throws
}

/// Makes the store for an access group (`AutoSignInOptions.backupAccessGroup`), or nil for none.
public typealias RestoreStoreFactory = @Sendable (_ accessGroup: String?) -> (any RestoreItemStore)?

/// The daily check running off the ladder's path.
struct RestoreDailyState: Sendable {
    var running = false
    var task: Task<Void, Never>?
}

/// What the ladder and the enrolment share: the option, the access group and the store.
struct RestoreSetup: Sendable {
    var enabled = true
    var accessGroup: String?
    var factory: RestoreStoreFactory?
    var fixed: (any RestoreItemStore)?
}

/// `POST restore`. Printing it shows the secret of `.enrolled` as `[redacted]`.
enum RestoreEnrolResult: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// `201`: a new key. The caller writes it to the backup.
    case enrolled(restoreId: String, secret: String)
    /// `200 {"status":"current"}`: the item stays as it is.
    case current
    /// `404` (the feature is off), or discovery names no `restore` member: nothing was sent.
    case unavailable
    /// `403 account_required`, `429`, a Worker error.
    case refused(code: String, status: Int)

    var description: String {
        switch self {
        case .enrolled(let id, _): return "RestoreEnrolResult.enrolled(restoreId: \(id), secret: \(redactedCredential))"
        case .current: return "RestoreEnrolResult.current"
        case .unavailable: return "RestoreEnrolResult.unavailable"
        case .refused(let code, let status): return "RestoreEnrolResult.refused(code: \(code), status: \(status))"
        }
    }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["result": description], displayStyle: .struct) }
}

enum Restore {
    static let grantType = "urn:polaris-key:grant-type:restore"
    /// The local, non-synced records (`Store.readRecord`): the file store keeps them out of device backups.
    static let checkedRecord = "restore-checked"
    static let pendingDeleteRecord = "restore-delete-pending"
    /// A rung-1 launch checks the key at most this often.
    static let checkSeconds = 86_400

    static func idOK(_ s: String) -> Bool {
        s.hasPrefix("rk_") && IdentityClient.urlSafe(String(s.dropFirst(3)), count: 22)
    }

    static func secretOK(_ s: String) -> Bool {
        s.hasPrefix("rs_") && IdentityClient.urlSafe(String(s.dropFirst(3)), count: 43)
    }

    static func itemOK(_ item: RestoreItem) -> Bool { idOK(item.restoreId) && secretOK(item.secret) }
}

extension IdentityClient {
    /// Hand over the factory that makes the platform backup store (the umbrella installs the Keychain
    /// one). Nil, with no fixed store, means the ladder has no rung 2 and nothing is enrolled.
    public func installRestoreStoreFactory(_ factory: RestoreStoreFactory?) {
        restoreSetup.with {
            $0.factory = factory
            $0.fixed = nil
        }
    }

    /// Use exactly this store (tests, and hosts with a store of their own). Nil removes it.
    public func installRestoreStore(_ store: (any RestoreItemStore)?) {
        restoreSetup.with {
            $0.fixed = store
            $0.factory = nil
        }
    }

    func restoreStore() -> (any RestoreItemStore)? {
        let setup = restoreSetup.current
        return setup.fixed ?? setup.factory?(setup.accessGroup)
    }

    // ── Rung 2 ───────────────────────────────────────────────────────────────────────────

    /// The ladder's rung 2: nil goes on to rung 3.
    func restoreRung(generation: Int) async throws -> AutoSignInResult? {
        guard let store = restoreStore() else { return nil }
        let item: RestoreItem
        do {
            guard let held = try await store.read(), Restore.itemOK(held) else { return nil }
            item = held
        } catch {
            try Task.checkCancellation()
            return nil
        }
        guard await restoreAvailable(load: true) else { return nil }
        do {
            switch try await redeemRestore(item, proofValue: nil, ladderGeneration: generation) {
            case .signedIn(let ready): return .signedIn(ready)
            case .confirm(let pending): return .confirm(pending)
            case .choose(let pending): return .choose(pending)
            case .needsSignIn, .unavailable: return nil
            }
        } catch is SignedOutDuringLadder {
            return .needsSignIn(linkHandle: nil, reason: .signedOut)
        } catch let error as CancellationError {
            throw error
        } catch {
            // `invalid_grant`, `429`, a Worker or network failure, or a consumed key that was then refused:
            // the item stays, and rung 3 is next.
            try Task.checkCancellation()
            return nil
        }
    }

    /// The `restore` grant (§12.11.8). `proofValue` replaces `<restore_id>.<device_key>` (conformance only).
    /// A refusal is an `ExchangeError` that changes nothing local. With `ladderGeneration` the token is
    /// stored only if no sign-out happened since, and the signed-out state is not ended.
    func redeemRestore(_ item: RestoreItem, proofValue: String?, ladderGeneration: Int?) async throws
        -> ExchangeOutcome
    {
        guard Restore.itemOK(item) else {
            throw PolarisError(code: ErrorCode.invalidArgument, message: "the restore item is malformed.")
        }
        guard let token = await restoreTokenURL() else {
            return .unavailable(code: ErrorCode.platformIdentityUnavailable)
        }
        guard let port = try await exchangePort() else {
            return .unavailable(code: ErrorCode.platformIdentityUnavailable)
        }
        let keys = try await port.ensure()
        let proof = try await DeviceProofs.sign(
            port, purpose: .restore, product: core.product, deviceId: await core.deviceId,
            value: proofValue ?? "\(item.restoreId).\(keys.signKey)",
            tokenHash: Base64URL.encode(Data(SHA256.hash(data: Data(item.secret.utf8)))))
        let pairs: [(String, String)] = [
            ("grant_type", Restore.grantType), ("client_id", core.product),
            ("restore_id", item.restoreId), ("restore_secret", item.secret),
            ("device_key", keys.signKey), ("agree_key", keys.agreeKey), ("proof", proof.sig),
        ]
        let form = pairs.map { "\(ManageLink.formEncode($0.0))=\(ManageLink.formEncode($0.1))" }
            .joined(separator: "&")
        let response = try await exchangeSend(
            token, contentType: IdentityRedirect.tokenContentType, body: Data(form.utf8))
        return try await exchangeOutcome(response, ladderGeneration: ladderGeneration)
    }

    // ── Enrolment ────────────────────────────────────────────────────────────────────────

    /// `POST restore` with the device bearer and `{}` or `{restoreId}`.
    func restoreEnrolWire(restoreId: String?) async throws -> RestoreEnrolResult {
        guard await restoreAvailable(load: true), let url = await restoreURL(derive: false) else {
            return .unavailable
        }
        var body: [String: JSONValue] = [:]
        if let restoreId { body["restoreId"] = .string(restoreId) }
        let response = try await withBearer(
            url, method: "POST", headers: ["content-type": "application/json"],
            body: try JSONEncoder().encode(JSONValue.object(body)))
        if response.status == 404 { return .unavailable }
        let object = exchangeBody(response)?.objectValue ?? [:]
        if response.status == 201 {
            guard let id = object["restoreId"]?.stringValue, Restore.idOK(id),
                let secret = object["secret"]?.stringValue, Restore.secretOK(secret)
            else {
                throw PolarisError(
                    code: ErrorCode.badResponse, message: "the restore route answered without a key.")
            }
            return .enrolled(restoreId: id, secret: secret)
        }
        if response.status == 200 {
            guard object["status"]?.stringValue == "current" else {
                throw PolarisError(
                    code: ErrorCode.badResponse, message: "the restore route answered an unknown status.")
            }
            return .current
        }
        let refusal = exchangeRefusal(response)
        return .refused(code: refusal.code, status: refusal.status)
    }

    /// Enrol or check this device's key and write a new one to the backup. Quiet: nothing here throws.
    /// `load` lets it fetch discovery when none is loaded.
    func restoreEnrol(load: Bool) async {
        guard let store = restoreStore() else { return }
        let item: RestoreItem?
        do { item = try await store.read() } catch { return }
        guard await core.token != nil, await restoreAvailable(load: load) else { return }
        await restoreFlushPending()
        let id = item.map(\.restoreId).flatMap { Restore.idOK($0) ? $0 : nil }
        guard let result = try? await restoreEnrolWire(restoreId: id) else { return }
        switch result {
        case .enrolled(let newId, let secret):
            do {
                try await store.write(RestoreItem(restoreId: newId, secret: secret))
                await stampChecked()
            } catch {}
        case .current:
            await stampChecked()
        case .unavailable, .refused:
            break
        }
    }

    /// After any completed sign-in, from any rung (a person-started one included): enrol.
    func restoreSignInCompleted() async {
        guard restoreSetup.current.enabled, restoreStore() != nil else { return }
        guard !(await core.explicitSignOut()) else { return }
        await restoreEnrol(load: false)
    }

    /// Rung 1's daily check, detached: the sign-in result is returned first and a launch never waits for it.
    /// A failure is swallowed (the next launch checks again). `generation` is the sign-out generation the
    /// ladder read: a sign-out since then stops the check. One check runs at a time.
    func restoreLaunchDailyCheck(generation: Int) {
        guard restoreSetup.current.enabled, restoreStore() != nil else { return }
        restoreDaily.with { state in
            guard !state.running else { return }
            state.running = true
            state.task = Task.detached(priority: .utility) { [self] in
                if await core.signOutGeneration == generation { await restoreDailyCheck() }
                restoreDaily.with { $0.running = false }
            }
        }
    }

    /// Wait for the daily check in flight, if any (sign-out, and tests).
    func restoreAwaitDailyCheck() async {
        let task = restoreDaily.current.task
        await task?.value
    }

    /// At most once every 24 hours, check the key and enrol when there is none.
    func restoreDailyCheck() async {
        guard restoreSetup.current.enabled, restoreStore() != nil else { return }
        guard !(await core.explicitSignOut()) else { return }
        let now = await core.now()
        if let last = await checkedAt(), last <= now, now - last < Restore.checkSeconds { return }
        await restoreEnrol(load: true)
    }

    // ── Deletion ─────────────────────────────────────────────────────────────────────────

    /// `DELETE restore`: true when it is settled (`204`, or an answer no retry would change), false for a
    /// `429` or a `5xx`. A network failure throws. It runs whatever the state of Identity and the gates.
    func restoreDeleteWire() async throws -> Bool {
        if await core.discoveryDocument == nil { await core.discover() }
        // Offline with no discovery document: the revocation cannot be addressed yet, so it is not settled
        // and stays queued. A document that names no usable endpoint leaves nothing to send.
        guard await core.discoveryDocument != nil else { return false }
        guard let url = await restoreURL(derive: true) else { return true }
        let response = try await withBearer(url, method: "DELETE")
        if response.status == 429 || response.status >= 500 { return false }
        return true
    }

    /// Send `DELETE restore`; queue it when it cannot be settled (no bearer, no Worker).
    func restoreSendDelete() async {
        guard await core.token != nil else { return await setPendingDelete(true) }
        do {
            await setPendingDelete(try await restoreDeleteWire() ? false : true)
        } catch {
            await setPendingDelete(true)
        }
    }

    /// A delete queued by an earlier launch goes first, before any other call.
    func restoreFlushPending() async {
        guard await pendingDelete(), await core.token != nil else { return }
        await restoreSendDelete()
    }

    /// Sign-out, before the Worker's `signout` and whatever it answers: the synchronizable item goes (every
    /// device on the Apple ID loses it; their next daily check enrols their own), so does the check clock, and
    /// `DELETE restore` is sent while the bearer is still there, or queued when it cannot be delivered. A daily
    /// check in flight finishes first, so it cannot write an item after this has deleted it.
    func restoreSignOutPrelude() async {
        guard let store = restoreStore() else { return }
        await restoreAwaitDailyCheck()
        try? await store.delete()
        await core.store.writeRecord(Restore.checkedRecord, nil)
        await setPendingDelete(true)
        await restoreSendDelete()
    }

    /// Sign-out, once it is decided. `serverRevoked` is true when the Worker's `signout` ran, which deleted the
    /// key in the same request; false is a sign-out with no session (a revoked platform credential), where an
    /// item that was there is dropped and its revocation queued.
    func restoreAfterSignOut(serverRevoked: Bool) async {
        // A daily check that began during the Worker's sign-out finishes first, so its item goes with the rest.
        await restoreAwaitDailyCheck()
        var hadItem = false
        if let store = restoreStore() {
            hadItem = ((try? await store.read()) ?? nil) != nil
            try? await store.delete()
        }
        await core.store.writeRecord(Restore.checkedRecord, nil)
        if serverRevoked {
            await setPendingDelete(false)
        } else if hadItem {
            await setPendingDelete(true)
        }
    }

    /// `AutoSignInOptions.restore == false`: never enrol, revoke what is enrolled and drop the item.
    func restoreOptOut() async {
        guard let store = restoreStore() else { return }
        let held = (try? await store.read()) ?? nil
        // A device whose item a sibling deleted still holds a key of its own: the check record says so.
        let hadCheck = await checkedAt() != nil
        guard held != nil || hadCheck else { return }
        await restoreSendDelete()
        try? await store.delete()
        await core.store.writeRecord(Restore.checkedRecord, nil)
    }

    // ── Discovery and local records ──────────────────────────────────────────────────────

    /// Discovery names the restore member and its endpoint. Without `load` only a loaded document counts,
    /// so an enrolment after a sign-in never causes a discovery request of its own.
    func restoreAvailable(load: Bool) async -> Bool {
        if await core.discoveryDocument == nil {
            guard load else { return false }
            await core.discover()
        }
        guard let fragment = await core.discoveryDocument?.identity else { return false }
        return fragment.restore && !(fragment.restoreEndpoint ?? "").isEmpty
    }

    private func restoreTokenURL() async -> URL? {
        guard await restoreAvailable(load: true) else { return nil }
        try? await core.requireService(.identity, feature: Feature.identityRestore)
        let root = core.endpoints.url("").absoluteString
        guard let raw = await core.discoveryDocument?.identity?.token, raw.hasPrefix(root) else { return nil }
        return URL(string: raw)
    }

    /// The restore endpoint on this product. A revocation also works with no `restore` member (discovery
    /// leaves it out while the feature is off, but `DELETE` is answered whatever the gates say): it is
    /// then the token endpoint's sibling.
    private func restoreURL(derive: Bool) async -> URL? {
        if await core.discoveryDocument == nil { await core.discover() }
        guard let fragment = await core.discoveryDocument?.identity else { return nil }
        let root = core.endpoints.url("").absoluteString
        if let raw = fragment.restoreEndpoint, raw.hasPrefix(root) {
            return fragment.restore || derive ? URL(string: raw) : nil
        }
        guard derive, let token = fragment.token, token.hasPrefix(root), token.hasSuffix("/token") else {
            return nil
        }
        return URL(string: String(token.dropLast("token".count)) + "restore")
    }

    private func checkedAt() async -> Int? {
        guard let data = await core.store.readRecord(Restore.checkedRecord) else { return nil }
        return Int(String(decoding: data, as: UTF8.self))
    }

    private func stampChecked() async {
        await core.store.writeRecord(Restore.checkedRecord, Data(String(await core.now()).utf8))
    }

    private func pendingDelete() async -> Bool {
        await core.store.readRecord(Restore.pendingDeleteRecord) != nil
    }

    private func setPendingDelete(_ on: Bool) async {
        await core.store.writeRecord(Restore.pendingDeleteRecord, on ? Data("1".utf8) : nil)
    }
}
