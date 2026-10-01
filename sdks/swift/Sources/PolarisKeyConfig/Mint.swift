// Edge-mint — `GET /<p>/config/mint/<recipeId>/token` (Config, P0-12).
//
// A product declares a recipe (alg, key, claims template, lifetime) and an operator approves it;
// the Worker signs a short-lived token for a third party (Apple MusicKit's developer token is the
// first instance) for any device of the product that presents its device token. This is how a
// catalog secret with `delivery: "edgeMint"` reaches a runtime without the signing key ever
// leaving the Worker.
//
// THE CACHE IS MEMORY ONLY. A minted token is a live credential for someone else's API, so it is
// never written to the cache file or the keychain, and it dies with the process. Within one
// process it is reused until `expiresAt` minus a 30-second margin. Mirrors `@polaris-key/node`'s
// `config/mint.ts`.
//
// A CACHED TOKEN IS BOUND TO THE DEVICE TOKEN IT WAS MINTED WITH. A hit counts only while the
// client still holds that same device token, so `license.deactivate()`, a cleared or revoked
// token, or a different identity signing in all invalidate it: the call then takes the normal
// path, which refuses with `unauthorized` before any request when no token is held.

import Foundation
import PolarisKeyCore

/// What a mint returns. Printing it (`print`, `String(describing:)`, `debugPrint`, `dump`) shows
/// `token` as `[redacted]`.
public struct MintedToken: Sendable, Equatable {
    public let token: String
    /// Epoch seconds.
    public let expiresAt: Int

    public init(token: String, expiresAt: Int) {
        self.token = token
        self.expiresAt = expiresAt
    }
}

extension MintedToken: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "MintedToken(token: [redacted], expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["token": "[redacted]", "expiresAt": expiresAt], displayStyle: .struct)
    }
}

/// A cached token is reused until this many seconds before its `expiresAt`.
public let MINT_REUSE_MARGIN_SECONDS = 30

/// The single re-acquire, injected by the facade: the ROUTE (`POST /license/token`, or
/// re-registration for a licence-less device) belongs to another module.
public typealias ReacquireToken = @Sendable (String) async -> String?

enum MintEndpoint {
    /// The router's recipe-id alphabet (`MINT_ID` in the Worker's `services/config/routes.ts`):
    /// a traversal or an encoded separator can never reach the recipe lookup, so an id outside it
    /// is refused before it is sent.
    static func isRecipeId(_ id: String) -> Bool {
        !id.isEmpty
            && id.unicodeScalars.allSatisfy { scalar in
                ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "-"
            }
    }

    /// One mint (with the single re-acquire), and the device token that was presented for it.
    static func mint(
        _ core: CoreContext, recipeId: String, reacquire: ReacquireToken?
    ) async throws -> (deviceToken: String, minted: MintedToken) {
        guard let token = await core.token else {
            throw PolarisError(
                code: "unauthorized",
                message: "edge-mint needs a device token: activate, enrol, sign in or register first.")
        }
        var presented = token
        var response = try await get(core, token: presented, recipeId: recipeId)
        if response.status == 401, let reacquire, let next = await reacquire(token) {
            try? await core.setToken(next)
            presented = next
            response = try await get(core, token: presented, recipeId: recipeId)
        }
        if response.status == 200 {
            guard let body = try? JSONDecoder().decode(MintBody.self, from: response.body) else {
                throw PolarisError(
                    code: "bad_response", message: "edge-mint answered without a token and its expiry.")
            }
            return (presented, MintedToken(token: body.token, expiresAt: body.expiresAt))
        }
        let error = try? JSONDecoder().decode(MintError.self, from: response.body)
        throw PolarisError(
            code: error?.code ?? "http_\(response.status)",
            message: error?.message
                ?? "edge-mint of \"\(recipeId)\" failed with status \(response.status).")
    }

    private static func get(_ core: CoreContext, token: String, recipeId: String) async throws
        -> PolarisResponse
    {
        do {
            return try await core.request(
                core.endpoints.url("config/mint/\(recipeId)/token"),
                headers: ["authorization": "Bearer \(token)"])
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: "network-error", message: "\(error)")
        }
    }
}

private struct MintBody: Decodable {
    let token: String
    let expiresAt: Int
}

/// The Worker's flat (`{"error":"x"}`) or nested (`{"error":{"code":"x"}}`) error body.
private struct MintError: Decodable {
    let code: String?
    let message: String?

    private enum Keys: String, CodingKey { case error, message }
    private enum Nested: String, CodingKey { case code }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        message = try? c.decode(String.self, forKey: .message)
        if let flat = try? c.decode(String.self, forKey: .error) {
            code = flat
        } else if let nested = try? c.nestedContainer(keyedBy: Nested.self, forKey: .error) {
            code = try? nested.decode(String.self, forKey: .code)
        } else {
            code = nil
        }
    }
}
