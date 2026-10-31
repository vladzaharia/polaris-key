// Game Center identity for the exchange (I-44.5, WIRE-CONTRACT-V5 §12.11.7): standalone, so the
// Godot natives (I-48) link it alone. It depends on no other target.
//
//   1. the local player must already be signed in to Game Center. The client sets
//      `GKLocalPlayer.local.authenticateHandler` to learn that, and never presents the view
//      controller the handler may hand it: a launch never shows Game Center's sign-in. A player who
//      is not signed in fails the rung (`GameCenterFailure.notAuthenticated`).
//   2. `scopedIDsArePersistent()` must be true. When it is not, the team player id can change under
//      the player and a link made on it would break: the identity is not offered at all.
//   3. `fetchItemsForIdentityVerificationSignature()` yields the key URL, signature, salt and
//      timestamp. The client adds `teamPlayerID` and the main bundle id, and encodes the `gc1.`
//      token (`GameCenterToken`).
//
// Game Center takes no nonce, so none is signed into the token. The exchange proof binds SHA-256
// of the token to the Worker's nonce and the device key instead.
//
// Secrets: the signature and the token are bearer material for 120 seconds. Neither reaches a log,
// `description`, `debugDescription` or a mirror.
//
// The signature hash and the timestamp's unit (milliseconds, big-endian) come from open-source
// verifiers, not from Apple. The timestamp is passed through exactly as GameKit returns it; the
// real-device confirmation is a later step (owner §8y.4). The tests use fakes only.

import Foundation

#if canImport(GameKit)
    import GameKit
#endif

/// The `subject_token_type` of a Game Center token (§12.11.7).
public let gameCenterSubjectTokenType = "urn:polaris-key:token-type:gamecenter-signature"

/// Why no Game Center token could be made. The messages carry no player data.
public enum GameCenterFailure: Error, Sendable, Equatable, CustomStringConvertible {
    /// GameKit is not on this platform, or the app has no Game Center capability.
    case unsupported
    /// The player is not signed in to Game Center. The client never starts that sign-in.
    case notAuthenticated
    /// `scopedIDsArePersistent()` is false: the team player id may change, so it is not offered.
    case idsNotPersistent
    /// Apple's identity-verification call failed.
    case verificationFailed
    /// The token would be longer than 4096 characters, or a field is empty.
    case malformed

    public var description: String {
        switch self {
        case .unsupported: return "Game Center is not available here."
        case .notAuthenticated: return "The player is not signed in to Game Center."
        case .idsNotPersistent: return "Game Center player ids are not persistent for this player."
        case .verificationFailed: return "Game Center could not sign an identity verification."
        case .malformed: return "The Game Center token is malformed."
        }
    }
}

/// What Apple's identity-verification call returns. A secret for the life of the signature.
public struct GameCenterSignature: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    public let publicKeyURL: URL
    public let signature: Data
    public let salt: Data
    /// As Apple returns it (milliseconds since the epoch; see the note at the top).
    public let timestamp: UInt64

    public init(publicKeyURL: URL, signature: Data, salt: Data, timestamp: UInt64) {
        self.publicKeyURL = publicKeyURL
        self.signature = signature
        self.salt = salt
        self.timestamp = timestamp
    }

    public var description: String { "GameCenterSignature(<redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["signature": "[redacted]", "salt": "[redacted]"], displayStyle: .struct)
    }
}

/// The `gc1.` token (§12.11.7): `gc1.<publicKeyURL>.<signature>.<salt>.<timestamp>.<teamPlayerID>.<bundleId>`.
/// Every field but the timestamp is base64url without padding over its bytes (strings as UTF-8);
/// the timestamp is plain decimal; the whole token is at most 4096 characters.
public enum GameCenterToken {
    public static let prefix = "gc1"
    public static let maxLength = 4096

    public static func encode(_ signature: GameCenterSignature, teamPlayerID: String, bundleID: String) throws
        -> String
    {
        let key = signature.publicKeyURL.absoluteString
        guard !key.isEmpty, !signature.signature.isEmpty, !signature.salt.isEmpty, !teamPlayerID.isEmpty,
            !bundleID.isEmpty
        else { throw GameCenterFailure.malformed }
        let token = [
            prefix, b64(Data(key.utf8)), b64(signature.signature), b64(signature.salt),
            String(signature.timestamp), b64(Data(teamPlayerID.utf8)), b64(Data(bundleID.utf8)),
        ].joined(separator: ".")
        guard token.count <= maxLength else { throw GameCenterFailure.malformed }
        return token
    }

    private static func b64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// The GameKit calls, behind a port so tests use a fake (there is no Game Center in `swift test`).
public protocol GameCenterPlayerPort: Sendable {
    /// True when the local player is signed in. Never presents a view.
    func isAuthenticated() async -> Bool
    func scopedIDsArePersistent() async -> Bool
    func teamPlayerID() async -> String
    func identityVerification() async throws -> GameCenterSignature
}

/// The parts of a `gc1.` token before they are encoded: what Godot's GDScript encoder is handed (Q-5),
/// so the transcripts prove the encoder that ships. Secrets for the life of the signature, like
/// [GameCenterSignature].
public struct GameCenterFields: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    public let publicKeyURL: String
    public let signature: Data
    public let salt: Data
    public let timestamp: UInt64
    public let teamPlayerID: String
    public let bundleID: String

    public var description: String { "GameCenterFields(<redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["signature": "[redacted]", "salt": "[redacted]"], displayStyle: .struct)
    }

    public init(
        publicKeyURL: String, signature: Data, salt: Data, timestamp: UInt64, teamPlayerID: String, bundleID: String
    ) {
        self.publicKeyURL = publicKeyURL
        self.signature = signature
        self.salt = salt
        self.timestamp = timestamp
        self.teamPlayerID = teamPlayerID
        self.bundleID = bundleID
    }
}

public struct GameCenterIdentity: Sendable {
    private let port: any GameCenterPlayerPort
    private let bundleID: @Sendable () -> String?

    /// `bundleID` defaults to the main bundle's identifier.
    public init(
        port: any GameCenterPlayerPort = GameKitPlayer(),
        bundleID: @escaping @Sendable () -> String? = { Bundle.main.bundleIdentifier }
    ) {
        self.port = port
        self.bundleID = bundleID
    }

    /// A fresh `gc1.` token for the signed-in local player, or a `GameCenterFailure`.
    public func token() async throws -> String {
        guard await port.isAuthenticated() else { throw GameCenterFailure.notAuthenticated }
        guard await port.scopedIDsArePersistent() else { throw GameCenterFailure.idsNotPersistent }
        let signature: GameCenterSignature
        do {
            signature = try await port.identityVerification()
        } catch {
            if error is CancellationError { throw error }
            throw GameCenterFailure.verificationFailed
        }
        guard let bundle = bundleID(), !bundle.isEmpty else { throw GameCenterFailure.malformed }
        return try GameCenterToken.encode(signature, teamPlayerID: await port.teamPlayerID(), bundleID: bundle)
    }

    /// The raw parts of a token for the signed-in local player (a host that encodes the token itself),
    /// or a `GameCenterFailure`. The same checks as [token]; the length limit is the encoder's.
    public func fields() async throws -> GameCenterFields {
        guard await port.isAuthenticated() else { throw GameCenterFailure.notAuthenticated }
        guard await port.scopedIDsArePersistent() else { throw GameCenterFailure.idsNotPersistent }
        let signature: GameCenterSignature
        do {
            signature = try await port.identityVerification()
        } catch {
            if error is CancellationError { throw error }
            throw GameCenterFailure.verificationFailed
        }
        guard let bundle = bundleID(), !bundle.isEmpty else { throw GameCenterFailure.malformed }
        let team = await port.teamPlayerID()
        let key = signature.publicKeyURL.absoluteString
        guard !key.isEmpty, !signature.signature.isEmpty, !signature.salt.isEmpty, !team.isEmpty else {
            throw GameCenterFailure.malformed
        }
        return GameCenterFields(
            publicKeyURL: key, signature: signature.signature, salt: signature.salt, timestamp: signature.timestamp,
            teamPlayerID: team, bundleID: bundle)
    }
}

/// GameKit itself. Not exercised by `swift test`; the real-device run is the owner's.
public struct GameKitPlayer: GameCenterPlayerPort {
    public init() {}

    #if canImport(GameKit)
        public func isAuthenticated() async -> Bool {
            await GameCenterAuthentication.shared.authenticateSilently()
        }

        public func scopedIDsArePersistent() async -> Bool {
            await MainActor.run { GKLocalPlayer.local.scopedIDsArePersistent() }
        }

        public func teamPlayerID() async -> String {
            await MainActor.run { GKLocalPlayer.local.teamPlayerID }
        }

        public func identityVerification() async throws -> GameCenterSignature {
            let (url, signature, salt, timestamp) = try await GKLocalPlayer.local
                .fetchItemsForIdentityVerificationSignature()
            return GameCenterSignature(publicKeyURL: url, signature: signature, salt: salt, timestamp: timestamp)
        }
    #else
        public func isAuthenticated() async -> Bool { false }
        public func scopedIDsArePersistent() async -> Bool { false }
        public func teamPlayerID() async -> String { "" }
        public func identityVerification() async throws -> GameCenterSignature {
            throw GameCenterFailure.unsupported
        }
    #endif
}

#if canImport(GameKit)
    /// Sets `authenticateHandler` once (and only when none is set) and waits for its first answer. The handler may be given a
    /// view controller to present; it is dropped on the floor (a launch never shows Game Center).
    @MainActor
    final class GameCenterAuthentication {
        static let shared = GameCenterAuthentication()
        private var waiting: [CheckedContinuation<Bool, Never>] = []
        private var installed = false
        private var pending: Bool { !waiting.isEmpty }

        func authenticateSilently() async -> Bool {
            if GKLocalPlayer.local.isAuthenticated { return true }
            // The handler already ran and the player is still out: it will not run again.
            if installed && !pending { return false }
            // A handler somebody else set (the game's own Game Center plugin) keeps its place: setting ours
            // would replace theirs. Wait for it to sign the player in instead, up to the same bound.
            // [U] whether the getter reports a handler set elsewhere: confirm on a device.
            if !installed && GKLocalPlayer.local.authenticateHandler != nil {
                return await waitForForeignHandler()
            }
            return await withCheckedContinuation { continuation in
                waiting.append(continuation)
                // GameKit may never call back (no capability, no network): the rung gives up.
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    GameCenterAuthentication.shared.answered()
                }
                guard !installed else { return }
                installed = true
                GKLocalPlayer.local.authenticateHandler = { _, _ in
                    Task { @MainActor in GameCenterAuthentication.shared.answered() }
                }
            }
        }

        private func waitForForeignHandler() async -> Bool {
            for _ in 0..<40 {
                if GKLocalPlayer.local.isAuthenticated { return true }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            return GKLocalPlayer.local.isAuthenticated
        }

        private func answered() {
            let result = GKLocalPlayer.local.isAuthenticated
            let pending = waiting
            waiting = []
            for continuation in pending { continuation.resume(returning: result) }
        }
    }
#endif
