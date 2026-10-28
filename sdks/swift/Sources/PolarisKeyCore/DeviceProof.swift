// The device proof `pkey-proof/1` (WIRE-CONTRACT-V5 §12.11.1, §15.8; plans/CC-01.md R-6) in
// Swift, mirroring client-core's deviceProof.ts and deviceKeys.ts (CC-26.1; CC-26.4 here): the
// message a device signs, a strict verifier for it, the signer over a `DeviceKeyPort` and the
// `PUT /<p>/devices/keys` request. The vectors are `conformance/corpus/v2/device-proof.json`.
// The signer asks the port for signatures and public halves only; it re-verifies its own
// result before returning it.

import CryptoKit
import Foundation

/// The nine purposes, in the order of V5 §12.11.1.
public enum DeviceProofPurpose: String, Sendable, CaseIterable, Codable {
    case keys
    case nonce
    case exchange
    case link
    case nearbyStart = "nearby-start"
    case nearbyPoll = "nearby-poll"
    case nearbyApprove = "nearby-approve"
    case vouch
    case restore
}

/// A proof could not be built or did not verify. The text never names a key or a signature.
public enum DeviceProofError: Error, Sendable, Equatable {
    case badField
    case badProduct
    /// `signDeviceProof` is never used for `keys`; use `signKeysProof`.
    case useSignKeysProof
    case keysChanged
    case didNotVerify
}

/// The fields of a proof; `message` is the bytes a device signs.
public struct DeviceProofFields: Sendable, Equatable {
    public var purpose: String
    public var product: String
    public var deviceId: String
    public var value: String
    /// Base64url SHA-256 of the presented provider token, or `-`.
    public var tokenHash: String

    public init(purpose: String, product: String, deviceId: String, value: String, tokenHash: String = "-") {
        self.purpose = purpose
        self.product = product
        self.deviceId = deviceId
        self.value = value
        self.tokenHash = tokenHash
    }
}

public struct DeviceProof: Sendable, Equatable {
    public var fields: DeviceProofFields
    /// The device's signing key, raw 32 bytes in base64url.
    public var signKey: String
    /// The 64-byte signature, base64url.
    public var sig: String

    public init(fields: DeviceProofFields, signKey: String, sig: String) {
        self.fields = fields
        self.signKey = signKey
        self.sig = sig
    }
}

public enum DeviceProofs {
    public static let version = "pkey-proof/1"
    /// The `keys` proof's skew window, in seconds either side of now.
    public static let keysSkewSeconds = 300

    /// The `keys` purpose's value: `<signKey>.<agreeKey>.<issuedAt>`.
    public static func keysValue(signKey: String, agreeKey: String, issuedAt: Int) -> String {
        "\(signKey).\(agreeKey).\(issuedAt)"
    }

    /// One line: non-empty, every byte in 0x21...0x7e.
    private static func lineOK(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.allSatisfy { $0 >= 0x21 && $0 <= 0x7e }
    }

    /// The bytes a device signs, or nil when a field would break the line format.
    public static func message(_ f: DeviceProofFields) -> Data? {
        let lines = [version, f.purpose, f.product, f.deviceId, f.value, f.tokenHash]
        guard lines.allSatisfy(lineOK) else { return nil }
        return Data(lines.joined(separator: "\n").utf8)
    }

    /// A canonical base64url of exactly 32 bytes, decoded, or nil.
    static func raw32(_ s: String) -> [UInt8]? {
        guard s.utf8.count == 43, Base64URL.isCanonical(s), let d = Base64URL.decode(s), d.count == 32 else {
            return nil
        }
        return [UInt8](d)
    }

    /// The five low-order u-coordinates of Curve25519, little-endian.
    private static let lowOrderU: [[UInt8]] = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ].map(unhex)

    private static func unhex(_ h: String) -> [UInt8] {
        let c = Array(h.utf8)
        func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
        return stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) }
    }

    /// True for a 32-byte u-coordinate of small order, in any spelling: the high bit is masked
    /// and the value reduced mod p first (RFC 7748 §5). False for any other length.
    public static func isX25519LowOrder(_ enc: [UInt8]) -> Bool {
        guard enc.count == 32 else { return false }
        var u = enc
        u[31] &= 0x7f
        if !Ed25519Strict.lessThan(u, Ed25519Strict.p) {
            // 2^255 > u >= p: subtract p once.
            var borrow = 0
            for i in 0..<32 {
                let d = Int(u[i]) - Int(Ed25519Strict.p[i]) - borrow
                u[i] = UInt8(truncatingIfNeeded: d)
                borrow = d < 0 ? 1 : 0
            }
        }
        return lowOrderU.contains(u)
    }

    /// The one X25519 spelling an issuer accepts: bit 255 clear, u < p, not low-order.
    static func agreeKeyOK(_ s: String) -> Bool {
        guard let k = raw32(s), k[31] & 0x80 == 0, Ed25519Strict.lessThan(k, Ed25519Strict.p) else {
            return false
        }
        return !isX25519LowOrder(k)
    }

    private static func keysValueOK(_ p: DeviceProof, now: Int?) -> Bool {
        let parts = p.fields.value.split(separator: ".", omittingEmptySubsequences: false)
        guard p.fields.tokenHash == "-", let now, parts.count == 3, String(parts[0]) == p.signKey,
            agreeKeyOK(String(parts[1]))
        else { return false }
        let digits = parts[2]
        guard digits.count <= 16, !digits.isEmpty, digits.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
            digits == "0" || digits.first != "0", let issuedAt = Int(digits)
        else { return false }
        return abs(issuedAt - now) <= keysSkewSeconds
    }

    /// True only for a strict Ed25519 proof by `signKey` (V5 §12.11.1); it never says why not.
    /// `now` (epoch seconds) is needed for purpose `keys`.
    public static func verify(_ proof: DeviceProof, now: Int? = nil) -> Bool {
        guard DeviceProofPurpose(rawValue: proof.fields.purpose) != nil,
            let key = raw32(proof.signKey), Ed25519Strict.acceptablePoint(key),
            let message = self.message(proof.fields)
        else { return false }
        if proof.fields.purpose == DeviceProofPurpose.keys.rawValue, !keysValueOK(proof, now: now) {
            return false
        }
        guard proof.sig.utf8.count == 86, Base64URL.isCanonical(proof.sig),
            let sigData = Base64URL.decode(proof.sig), sigData.count == 64
        else { return false }
        let sig = [UInt8](sigData)
        guard Ed25519Strict.prechecks(key: key, sig: sig),
            let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: key)
        else { return false }
        return pub.isValidSignature(sig, for: message)
    }

    static func slugOK(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...64).contains(b.count) else { return false }
        func alnum(_ c: UInt8) -> Bool { (c >= 97 && c <= 122) || (c >= 48 && c <= 57) }
        return alnum(b[0]) && b.dropFirst().allSatisfy { alnum($0) || $0 == 45 }
    }

    private static func nowSeconds() -> Int { Int(Date().timeIntervalSince1970) }

    private static func refuseMemoryOnly(_ port: any DeviceKeyPort, allowEphemeral: Bool) async throws {
        if allowEphemeral { return }
        if try await port.persistence() == .memory { throw DeviceKeyError.unsupported("memory-only") }
    }

    /// Builds the message for `purpose`, signs it through the port and returns the proof. Throws
    /// `DeviceProofError` when a field breaks the line format, when the keys changed while
    /// signing, or when the result would not verify. Never for `keys`: see `signKeysProof`.
    public static func sign(
        _ port: any DeviceKeyPort, purpose: DeviceProofPurpose, product: String, deviceId: String,
        value: String, tokenHash: String = "-", now: Int? = nil
    ) async throws -> DeviceProof {
        guard purpose != .keys else { throw DeviceProofError.useSignKeysProof }
        return try await signAny(
            port,
            DeviceProofFields(
                purpose: purpose.rawValue, product: product, deviceId: deviceId, value: value,
                tokenHash: tokenHash),
            now: now)
    }

    private static func signAny(_ port: any DeviceKeyPort, _ fields: DeviceProofFields, now: Int?) async throws
        -> DeviceProof
    {
        let before = try await port.ensure()
        guard let message = message(fields) else { throw DeviceProofError.badField }
        let sig = Base64URL.encode(try await port.sign(message))
        guard let after = try await port.publicKeys(), after.signKey == before.signKey,
            after.generation == before.generation
        else { throw DeviceProofError.keysChanged }
        let proof = DeviceProof(fields: fields, signKey: before.signKey, sig: sig)
        guard verify(proof, now: now ?? nowSeconds()) else { throw DeviceProofError.didNotVerify }
        return proof
    }

    /// The `keys` proof: the value names the port's own `signKey` and `agreeKey` and `issuedAt`.
    /// Refuses a memory-only port unless `allowEphemeral` (a flow that registers nothing).
    public static func signKeys(
        _ port: any DeviceKeyPort, product: String, deviceId: String, issuedAt: Int? = nil,
        allowEphemeral: Bool = false
    ) async throws -> (proof: DeviceProof, keys: DevicePublicKeys, issuedAt: Int) {
        guard slugOK(product) else { throw DeviceProofError.badProduct }
        try await refuseMemoryOnly(port, allowEphemeral: allowEphemeral)
        let at = issuedAt ?? nowSeconds()
        let keys = try await port.ensure()
        let proof = try await signAny(
            port,
            DeviceProofFields(
                purpose: DeviceProofPurpose.keys.rawValue, product: product, deviceId: deviceId,
                value: keysValue(signKey: keys.signKey, agreeKey: keys.agreeKey, issuedAt: at)),
            now: at)
        guard proof.signKey == keys.signKey else { throw DeviceProofError.keysChanged }
        return (proof, keys, at)
    }

    /// The request for `PUT <base>/<product>/devices/keys` for the port's keys (CC-03.2). The
    /// caller sends it with the device bearer and `X-PKey-Device`; resending it is safe.
    public static func keysRequest(
        _ port: any DeviceKeyPort, product: String, deviceId: String, issuedAt: Int? = nil,
        allowEphemeral: Bool = false
    ) async throws -> (path: String, body: DeviceKeysRequest) {
        let r = try await signKeys(
            port, product: product, deviceId: deviceId, issuedAt: issuedAt, allowEphemeral: allowEphemeral)
        return (
            "/\(product)/devices/keys",
            DeviceKeysRequest(
                signKey: r.keys.signKey, agreeKey: r.keys.agreeKey, issuedAt: r.issuedAt, sig: r.proof.sig)
        )
    }
}

/// The body of `PUT /<p>/devices/keys` (CC-03.2): `sig` is the `keys` proof.
public struct DeviceKeysRequest: Codable, Sendable, Equatable {
    public var signKey: String
    public var agreeKey: String
    public var issuedAt: Int
    public var sig: String
}

/// The answer of `PUT /<p>/devices/keys`.
public struct DeviceKeysResponse: Codable, Sendable, Equatable {
    public var keySeq: Int
}
