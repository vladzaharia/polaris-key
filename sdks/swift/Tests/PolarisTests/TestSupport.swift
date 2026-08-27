// Shared test scaffolding: an in-test Ed25519 signer that emits byte-identical compact JWS
// to the Worker's, builders for the two signed document shapes, and a routing URLProtocol
// stub so a whole `PolarisKeyClient` can be driven offline.
//
// Everything here exists so the wire-contract-v2 regression tests can present the exact
// artifacts an attacker would: a manifest that substitutes a pinned kid, a hand-written
// cache, a header with two `alg` members, an oversized header.

import CryptoKit
import Foundation

@testable import PolarisKey

// ── Signing ────────────────────────────────────────────────────────────────────────

struct TestSigner {
    let kid: String
    let key: Curve25519.Signing.PrivateKey

    init(kid: String = "test-kid", key: Curve25519.Signing.PrivateKey = .init()) {
        self.kid = kid
        self.key = key
    }

    var publicKeyB64: String { Base64URL.encode(key.publicKey.rawRepresentation) }
    var trust: TrustSet { [kid: publicKeyB64] }

    /// The canonical protected header. `typ: nil` reproduces a v1 header exactly.
    func header(typ: String? = JwsTyp.config.rawValue) -> String {
        guard let typ else { return #"{"alg":"EdDSA","kid":"\#(kid)"}"# }
        return #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(kid)"}"#
    }

    /// Sign arbitrary RAW header/payload JSON — for the cases a Codable model cannot express
    /// (duplicate members, oversized members, a wrong `typ`).
    func signRaw(header: String, payload: String) -> String {
        let signingInput =
            Base64URL.encode(string: header) + "." + Base64URL.encode(string: payload)
        let sig = try! key.signature(for: Data(signingInput.utf8))
        return signingInput + "." + Base64URL.encode(sig)
    }

    func sign(payloadJSON: String, typ: String? = JwsTyp.config.rawValue) -> String {
        signRaw(header: header(typ: typ), payload: payloadJSON)
    }

    func sign<T: Encodable>(_ value: T, typ: String? = JwsTyp.config.rawValue) -> String {
        let data = try! JSONEncoder().encode(value)
        return sign(payloadJSON: String(decoding: data, as: UTF8.self), typ: typ)
    }
}

// ── Document builders ──────────────────────────────────────────────────────────────

enum Fixtures {
    static func doc(
        aud: String = "djdl",
        iss: String = POLARIS_ISSUER,
        deviceId: String = "dev",
        licenseId: String = "lic",
        schemaVersion: Int = 1,
        issuedAt: Int,
        expiresAt: Int? = nil,
        graceUntil: Int? = nil,
        config: [String: ManagedEntry] = [:],
        secrets: [String: ManagedEntry] = [:],
        entitlements: [String: ManagedEntry] = [:]
    ) -> ManagedConfigDoc {
        ManagedConfigDoc(
            schemaVersion: schemaVersion, aud: aud, iss: iss, licenseId: licenseId,
            deviceId: deviceId, issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + DOC_EXPIRY_SECONDS),
            graceUntil: graceUntil ?? (issuedAt + 30 * SECONDS_PER_DAY),
            profile: DocProfile(name: "Ada", firstName: "Ada", email: "a@e.com", activatedAt: 1),
            payload: ManagedPayload(
                config: config, secrets: secrets, entitlements: entitlements))
    }

    static func manifest(
        aud: String = "djdl",
        iss: String = POLARIS_ISSUER,
        issuedAt: Int,
        expiresAt: Int? = nil,
        keys: [TrustManifestKey]
    ) -> TrustManifestDoc {
        TrustManifestDoc(
            schemaVersion: 1, aud: aud, iss: iss, issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + 30 * SECONDS_PER_DAY),
            jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
            cacheSeconds: 3600, keys: keys)
    }

    static func manifestKey(
        kid: String, publicKey: String, status: String = "active"
    ) -> TrustManifestKey {
        TrustManifestKey(
            kid: kid, alg: "EdDSA", kty: "OKP", crv: "Ed25519", publicKey: publicKey,
            status: status)
    }

    static func entry(_ value: JSONValue, _ state: ManagementState = .default) -> ManagedEntry {
        ManagedEntry(state: state, value: value, updatedAt: 1)
    }
}

// ── A routing HTTP stub ────────────────────────────────────────────────────────────

/// A `URLProtocol` that answers by PATH, records every request, and defaults to `200 {}` so
/// the report-snapshot POST never has to be stubbed explicitly.
final class StubServer: URLProtocol {
    struct Reply: Sendable {
        let status: Int
        let body: Data
        let headers: [String: String]

        init(status: Int = 200, body: String = "{}", headers: [String: String] = [:]) {
            self.status = status
            self.body = Data(body.utf8)
            self.headers = headers
        }
    }

    nonisolated(unsafe) private static var routes:
        [String: @Sendable (URLRequest) -> Reply] = [:]
    nonisolated(unsafe) private static var log: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        routes = [:]
        log = []
    }

    static func route(_ path: String, _ handler: @escaping @Sendable (URLRequest) -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        routes[path] = handler
    }

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    static func requests(forPath path: String) -> [URLRequest] {
        requests.filter { $0.url?.path == path }
    }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        StubServer.lock.lock()
        StubServer.log.append(request)
        let handler = StubServer.routes[request.url?.path ?? ""]
        StubServer.lock.unlock()

        let reply = handler?(request) ?? Reply()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
