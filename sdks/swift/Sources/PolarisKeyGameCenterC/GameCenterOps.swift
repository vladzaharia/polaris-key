// The Game Center op behind the Godot opt-in extension (I-48.6a): one JSON request in, one JSON
// reply out, like PolarisKeyPlatform's router, but a separate target and a separate C surface so
// GameKit is linked only by a host that asks for it (Q-4, reversed by the lead 2026-10-28).
//
//   {"op":"gc_identity"}  an asynchronous op: answers {"ok":true,"req":N} now and, later, one event
//                         {"ev":"gc_identity","req":N, …} through the event sink:
//                           {"ok":true, publicKeyUrl, signature, salt, timestamp, teamPlayerId, bundleId}
//                         every byte field is base64url without padding (Q-5: the GDScript encoder
//                         builds the `gc1.` token), the timestamp is a decimal string, or
//                           {"ok":false,"error":"not_authenticated|ids_not_persistent|unsupported|
//                                                verification_failed|malformed"}
//   {"op":"ping"}, {"op":"capabilities"}   synchronous.
//
// Secrets: the signature and the salt are bearer material for 120 seconds. They travel only in the
// event; nothing here logs or describes them.

import Foundation
import PolarisKeyGameCenter
import PolarisKeyPlatform

/// The router behind `pkgc_call`.
public final class GameCenterHost: Sendable {
    /// The process-wide host the C functions use.
    public static let shared = GameCenterHost(identity: GameCenterIdentity())

    public static let protocolVersion = 1

    public let sink: PlatformEventSink
    private let identity: GameCenterIdentity
    private let reqCounter = PlatformLock(0)

    public init(identity: GameCenterIdentity, sink: PlatformEventSink = PlatformEventSink()) {
        self.identity = identity
        self.sink = sink
    }

    public func call(_ json: String) -> String {
        guard let q = decodePlatformJSON(json) else { return encodePlatformJSON(["ok": false, "error": "bad_json"]) }
        return encodePlatformJSON(handle(q))
    }

    public func handle(_ q: PlatformObject) -> PlatformObject {
        switch q["op"]?.stringValue {
        case nil:
            return ["ok": false, "error": "missing_op"]
        case "ping":
            return ["ok": true, "protocol": .int(Self.protocolVersion)]
        case "capabilities":
            #if canImport(GameKit)
                let gameKit = true
            #else
                let gameKit = false
            #endif
            return ["ok": true, "protocol": .int(Self.protocolVersion), "gameCenter": .bool(gameKit)]
        case "gc_identity":
            let req = reqCounter.withLock { n -> Int in
                n += 1
                return n
            }
            let sink = self.sink
            let identity = self.identity
            Task.detached {
                var event = await Self.fields(identity)
                event["ev"] = "gc_identity"
                event["req"] = .int(req)
                sink.emit(event)
            }
            return ["ok": true, "req": .int(req)]
        case let op?:
            return ["ok": false, "error": "unknown_op", "op": .string(op)]
        }
    }

    static func fields(_ identity: GameCenterIdentity) async -> PlatformObject {
        do {
            let f = try await identity.fields()
            return [
                "ok": true, "publicKeyUrl": .string(f.publicKeyURL), "signature": .string(b64url(f.signature)),
                "salt": .string(b64url(f.salt)), "timestamp": .string(String(f.timestamp)),
                "teamPlayerId": .string(f.teamPlayerID), "bundleId": .string(f.bundleID),
            ]
        } catch let failure as GameCenterFailure {
            return ["ok": false, "error": .string(code(failure))]
        } catch {
            return ["ok": false, "error": "verification_failed"]
        }
    }

    static func code(_ failure: GameCenterFailure) -> String {
        switch failure {
        case .unsupported: return "unsupported"
        case .notAuthenticated: return "not_authenticated"
        case .idsNotPersistent: return "ids_not_persistent"
        case .verificationFailed: return "verification_failed"
        case .malformed: return "malformed"
        }
    }

    static func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
