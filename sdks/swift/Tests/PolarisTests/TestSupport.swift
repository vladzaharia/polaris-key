// Shared test scaffolding: an in-test Ed25519 signer that emits byte-identical compact JWS to
// the Worker's, builders for the four v3 signed shapes, and a routing `PolarisTransport` stub so
// a whole `PolarisClient` can be driven with no network.
//
// Everything here exists so the wire-contract regression tests can present the exact artifacts an
// attacker would: a manifest that substitutes a pinned kid, a hand-written cache, a header with
// two `alg` members, an oversized header, a bundle minted for another machine.

import CryptoKit
import Foundation
import PolarisConfig
import PolarisCore
import PolarisLicense

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

    /// The canonical protected header. `typ: nil` reproduces the untyped header v3 now refuses.
    func header(typ: String?) -> String {
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

    func sign(payloadJSON: String, typ: String?) -> String {
        signRaw(header: header(typ: typ), payload: payloadJSON)
    }

    func sign<T: Encodable>(_ value: T, typ: JwsTyp) -> String {
        let data = try! JSONEncoder().encode(value)
        return sign(payloadJSON: String(decoding: data, as: UTF8.self), typ: typ.rawValue)
    }

    func sign(_ doc: LicenseDoc) -> String { sign(doc, typ: .license) }
    func sign(_ doc: ConfigDoc) -> String { sign(doc, typ: .config) }
    func sign(_ doc: TrustManifestDoc) -> String { sign(doc, typ: .trust) }
    func sign(_ doc: BundleDoc) -> String { sign(doc, typ: .bundle) }
}

// ── Document builders ──────────────────────────────────────────────────────────────

enum Fixtures {
    static func license(
        aud: String = "djdl",
        iss: String = POLARIS_ISSUER,
        deviceId: String = "dev",
        licenseId: String = "lic",
        issuedAt: Int,
        expiresAt: Int? = nil,
        graceUntil: Int? = nil,
        entitlements: [String: ManagedEntry] = [:]
    ) -> LicenseDoc {
        LicenseDoc(
            iss: iss, aud: aud, deviceId: deviceId, issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + DOC_EXPIRY_SECONDS),
            graceUntil: graceUntil ?? (issuedAt + 30 * SECONDS_PER_DAY),
            licenseId: licenseId,
            profile: DocProfile(
                name: "Ada", firstName: "Ada", email: "a@e.com", activatedAt: 1),
            entitlements: entitlements)
    }

    static func config(
        aud: String = "djdl",
        iss: String = POLARIS_ISSUER,
        deviceId: String = "dev",
        schemaVersion: Int = 1,
        issuedAt: Int,
        expiresAt: Int? = nil,
        graceUntil: Int? = nil,
        config: [String: ManagedEntry] = [:],
        secrets: [String: ManagedEntry] = [:]
    ) -> ConfigDoc {
        ConfigDoc(
            iss: iss, aud: aud, deviceId: deviceId, issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + DOC_EXPIRY_SECONDS),
            graceUntil: graceUntil ?? (issuedAt + 30 * SECONDS_PER_DAY),
            schemaVersion: schemaVersion, config: config, secrets: secrets)
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

    static func bundle(
        bundleId: String = "01JBUNDLE0000000000000TEST",
        aud: String = "djdl",
        deviceId: String = "dev",
        issuedAt: Int,
        expiresAt: Int? = nil,
        license: String? = nil,
        config: String? = nil,
        trust: String
    ) -> BundleDoc {
        BundleDoc(
            bundleId: bundleId, aud: aud, deviceId: deviceId, issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + 30 * SECONDS_PER_DAY),
            docs: BundleDocs(license: license, config: config), trust: trust)
    }

    static func entry(_ value: JSONValue, _ state: ManagementState = .default) -> ManagedEntry {
        ManagedEntry(state: state, value: value, updatedAt: 1)
    }
}

// ── A routing transport stub ───────────────────────────────────────────────────────

/// A `PolarisTransport` that answers by PATH, records every request, and defaults to `200 {}` so
/// the telemetry POST never has to be stubbed explicitly.
///
/// An actor rather than a locked class: it is the only mutable state a test shares between the
/// client's tasks, and letting the compiler prove that is cheaper than reviewing it.
actor StubServer {
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

    private var routes: [String: @Sendable (PolarisRequest) -> Reply] = [:]
    private var log: [PolarisRequest] = []

    func route(_ path: String, _ handler: @escaping @Sendable (PolarisRequest) -> Reply) {
        routes[path] = handler
    }

    func reply(_ path: String, status: Int = 200, body: String = "{}") {
        route(path) { _ in Reply(status: status, body: body) }
    }

    func reset() {
        routes = [:]
        log = []
    }

    func handle(_ request: PolarisRequest) -> Reply {
        log.append(request)
        return routes[request.url.path]?(request) ?? Reply()
    }

    var requests: [PolarisRequest] { log }

    func requests(forPath path: String) -> [PolarisRequest] {
        log.filter { $0.url.path == path }
    }

    /// A transport bound to this server.
    nonisolated var transport: StubTransport { StubTransport(server: self) }
}

struct StubTransport: PolarisTransport {
    let server: StubServer

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let reply = await server.handle(request)
        return PolarisResponse(
            status: reply.status, body: reply.body, headers: reply.headers)
    }
}

/// A transport that fails every request the way a dropped connection does — for the tests that
/// prove a code path never dials, and the ones that prove it survives when the control plane is
/// unreachable.
struct ExplodingTransport: PolarisTransport {
    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        throw PolarisError(code: "transport", message: "no network in this test")
    }
}
