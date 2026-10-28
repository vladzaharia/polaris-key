// WIRE-CONTRACT-V5 §15.2 and §15.3 (CC-11.1): the device certificate (`pkey-peer+jws`), the
// roster (`pkey-ring+jws`), roster replacement and peer admission. Swift mirror of client-core's
// `peer/cert.ts`: pure functions over strings and a clock, no I/O, none throws. Both documents
// are signed by the product key and verified against the effective product set (§1). A failing
// check names the step that refused it, in the order §15.2 lists them. The corpus sections are
// `peerCertCases`, `ringCases` and `peerAdmissionCases`.

import Foundation

/// §15.1 limits.
public let MAX_PEER_CERT_SECONDS = 604_800
public let RING_SECONDS = 604_800
public let MAX_RING_DEVICES = 128

/// A verified device certificate's claims.
public struct PeerCert: Sendable, Equatable {
    public let sub: String
    public let deviceId: String
    public let signKey: String
    public let agreeKey: String
    public let ringEpoch: Int
    public let issuedAt: Int
    public let expiresAt: Int
}

/// One roster entry: a device and its two public keys.
public struct PeerDeviceKeys: Sendable, Equatable, Codable {
    public let deviceId: String
    public let signKey: String
    public let agreeKey: String

    public init(deviceId: String, signKey: String, agreeKey: String) {
        self.deviceId = deviceId
        self.signKey = signKey
        self.agreeKey = agreeKey
    }
}

/// A verified roster's claims.
public struct DeviceRing: Sendable, Equatable {
    public let sub: String
    public let epoch: Int
    public let issuedAt: Int
    public let expiresAt: Int
    public let devices: [PeerDeviceKeys]
}

/// The step that refused a certificate, in §15.2's order (`peerCertCases` `expect.reason`).
public enum PeerCertRefusal: String, Sendable, Equatable, CaseIterable {
    case jwsRejected = "jws-rejected"
    case issuerOrAudience = "issuer-or-audience"
    case integer
    case subjectOrDevice = "subject-or-device"
    case keys
    case lifetime
    case clock
    case subMismatch = "sub-mismatch"
    case ownDevice = "own-device"
    case staticMismatch = "static-mismatch"
}

/// §15.2 step 7: the Noise session the certificate is shown in. Mode `a` also names the
/// verifier's own subject and device id; modes `v` and `p` check the key only.
public struct PeerSession: Sendable, Equatable {
    public enum Mode: String, Sendable, Equatable { case a, v, p }
    public var mode: Mode
    /// The Noise remote static key, canonical base64url.
    public var remoteStatic: String
    public var ownSub: String?
    public var ownDeviceId: String?

    public init(mode: Mode, remoteStatic: String, ownSub: String? = nil, ownDeviceId: String? = nil) {
        self.mode = mode
        self.remoteStatic = remoteStatic
        self.ownSub = ownSub
        self.ownDeviceId = ownDeviceId
    }
}

public struct VerifyPeerCertOptions: Sendable {
    /// The effective product set.
    public var trust: TrustSet
    /// The app's product: `aud` must equal it.
    public var expectedAud: String
    /// The effective clock (§4.2), in seconds. Nil reads the system clock.
    public var now: Int?
    /// Nil checks the certificate alone (steps 1 to 6).
    public var session: PeerSession?

    public init(trust: TrustSet, expectedAud: String, now: Int? = nil, session: PeerSession? = nil) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.now = now
        self.session = session
    }
}

public enum VerifyPeerCertResult: Sendable, Equatable {
    case ok(PeerCert)
    case refused(PeerCertRefusal)

    public var cert: PeerCert? {
        if case .ok(let c) = self { return c }
        return nil
    }
}

public enum PeerDocs {
    private static func nowSeconds() -> Int { Int(Date().timeIntervalSince1970) }

    private static func matches(_ pattern: String, _ s: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static let subPattern = #"^ps_[A-Za-z0-9_-]{22}$"#
    private static let devicePattern = #"^[A-Za-z0-9_-]{32}$"#

    /// §15.2 step 4 for one `(signKey, agreeKey)` pair. A verifier stays lenient about the
    /// X25519 spelling: only a low-order point is refused.
    static func keysOK(_ signKey: JSONValue?, _ agreeKey: JSONValue?) -> Bool {
        guard let s = signKey?.stringValue.flatMap(DeviceProofs.raw32),
            let a = agreeKey?.stringValue.flatMap(DeviceProofs.raw32)
        else { return false }
        return Ed25519Strict.acceptablePoint(s) && !DeviceProofs.isX25519LowOrder(a)
    }

    private static func subOK(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return matches(subPattern, s)
    }

    private static func deviceOK(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return matches(devicePattern, s)
    }

    private static func int(
        _ d: [String: JSONValue], _ name: String, _ min: Int, _ nonWire: NonWireIntegers
    ) -> Int? {
        guard let i = d[name]?.exactInt, wireInteger(i, pointer: "/\(name)", min: min, in: nonWire)
        else { return nil }
        return i
    }

    private static func payload(_ jws: String, _ trust: TrustSet, _ typ: JwsTyp) -> (
        [String: JSONValue], NonWireIntegers
    )? {
        guard let v = JWSVerifier.verify(jws, trust: trust, typ: typ, requireTyp: true),
            let value = try? JSONDecoder().decode(JSONValue.self, from: v.payload),
            case .object(let d) = value
        else { return nil }
        return (d, v.nonWireIntegers)
    }

    /// §15.2 steps 1 to 7, in order; the first failing step names the reason.
    public static func verifyPeerCert(_ jws: String, options o: VerifyPeerCertOptions)
        -> VerifyPeerCertResult
    {
        guard let (d, nonWire) = payload(jws, o.trust, .peer) else { return .refused(.jwsRejected) }
        guard d["iss"]?.stringValue == POLARIS_ISSUER, d["aud"]?.stringValue == o.expectedAud else {
            return .refused(.issuerOrAudience)
        }
        guard let epoch = int(d, "ringEpoch", 1, nonWire), let iat = int(d, "issuedAt", 0, nonWire),
            let exp = int(d, "expiresAt", 0, nonWire)
        else { return .refused(.integer) }
        guard subOK(d["sub"]), deviceOK(d["deviceId"]), let sub = d["sub"]?.stringValue,
            let deviceId = d["deviceId"]?.stringValue
        else { return .refused(.subjectOrDevice) }
        guard keysOK(d["signKey"], d["agreeKey"]), let signKey = d["signKey"]?.stringValue,
            let agreeKey = d["agreeKey"]?.stringValue
        else { return .refused(.keys) }
        let span = saturatingAdd(exp, -iat)
        guard span >= 1, span <= MAX_PEER_CERT_SECONDS else { return .refused(.lifetime) }
        let now = o.now ?? nowSeconds()
        if iat > saturatingAdd(now, CLOCK_SKEW_SECONDS) || now > saturatingAdd(exp, CLOCK_SKEW_SECONDS) {
            return .refused(.clock)
        }
        if let s = o.session {
            if s.mode == .a {
                if sub != s.ownSub { return .refused(.subMismatch) }
                if deviceId == s.ownDeviceId { return .refused(.ownDevice) }
            }
            if agreeKey != s.remoteStatic { return .refused(.staticMismatch) }
        }
        return .ok(
            PeerCert(
                sub: sub, deviceId: deviceId, signKey: signKey, agreeKey: agreeKey, ringEpoch: epoch,
                issuedAt: iat, expiresAt: exp))
    }

    // ── The roster ───────────────────────────────────────────────────────────────────────

    public enum RingRefusal: String, Sendable, Equatable, CaseIterable {
        case jwsRejected = "jws-rejected"
        case issuerOrAudience = "issuer-or-audience"
        case integer, subject, lifetime
        case devicesSize = "devices-size"
        case device, keys, unsorted
        case duplicateId = "duplicate-id"
        case duplicateKey = "duplicate-key"
    }

    public enum VerifyRingResult: Sendable, Equatable {
        case ok(DeviceRing)
        case refused(RingRefusal)

        public var ring: DeviceRing? {
            if case .ok(let r) = self { return r }
            return nil
        }
    }

    /// §15.3: the roster's own checks. The clock is a separate question (`ringExpired`).
    public static func verifyRing(_ jws: String, trust: TrustSet, expectedAud: String) -> VerifyRingResult {
        guard let (d, nonWire) = payload(jws, trust, .ring) else { return .refused(.jwsRejected) }
        guard d["iss"]?.stringValue == POLARIS_ISSUER, d["aud"]?.stringValue == expectedAud else {
            return .refused(.issuerOrAudience)
        }
        guard let epoch = int(d, "epoch", 1, nonWire), let iat = int(d, "issuedAt", 0, nonWire),
            let exp = int(d, "expiresAt", 0, nonWire)
        else { return .refused(.integer) }
        guard subOK(d["sub"]), let sub = d["sub"]?.stringValue else { return .refused(.subject) }
        let span = saturatingAdd(exp, -iat)
        guard span >= 1, span <= RING_SECONDS else { return .refused(.lifetime) }
        guard case .array(let entries)? = d["devices"], entries.count >= 1, entries.count <= MAX_RING_DEVICES
        else { return .refused(.devicesSize) }
        var devices: [PeerDeviceKeys] = []
        for e in entries {
            guard case .object(let o) = e, deviceOK(o["deviceId"]), let id = o["deviceId"]?.stringValue else {
                return .refused(.device)
            }
            guard keysOK(o["signKey"], o["agreeKey"]), let sk = o["signKey"]?.stringValue,
                let ak = o["agreeKey"]?.stringValue
            else { return .refused(.keys) }
            devices.append(PeerDeviceKeys(deviceId: id, signKey: sk, agreeKey: ak))
        }
        // Device ids ascend strictly by their bytes: an equal neighbour is a duplicate, a lower
        // one is out of order.
        for k in 1..<max(devices.count, 1) {
            let a = Array(devices[k - 1].deviceId.utf8)
            let b = Array(devices[k].deviceId.utf8)
            if a == b { return .refused(.duplicateId) }
            if !a.lexicographicallyPrecedes(b) { return .refused(.unsorted) }
        }
        if Set(devices.map(\.signKey)).count != devices.count || Set(devices.map(\.agreeKey)).count != devices.count {
            return .refused(.duplicateKey)
        }
        return .ok(DeviceRing(sub: sub, epoch: epoch, issuedAt: iat, expiresAt: exp, devices: devices))
    }

    /// §15.3: a roster is expired once `now > expiresAt + 300`.
    public static func ringExpired(_ ring: DeviceRing, now: Int? = nil) -> Bool {
        (now ?? nowSeconds()) > saturatingAdd(ring.expiresAt, CLOCK_SKEW_SECONDS)
    }

    /// The held ring, or nil when there is none, it does not verify, or it is expired.
    package static func liveRing(_ heldJws: String?, trust: TrustSet, expectedAud: String, now: Int?) -> DeviceRing? {
        guard let heldJws, case .ok(let held) = verifyRing(heldJws, trust: trust, expectedAud: expectedAud),
            !ringExpired(held, now: now)
        else { return nil }
        return held
    }

    public enum RingReplaceRefusal: String, Sendable, Equatable, CaseIterable {
        case newRejected = "new-rejected"
        case otherProductOrSubject = "other-product-or-subject"
        case epochNotHigher = "epoch-not-higher"
        case newExpired = "new-expired"
    }

    public enum RingReplacement: Sendable, Equatable {
        case replace(DeviceRing)
        case keep(RingReplaceRefusal)
    }

    /// §15.3 "Held ring and replacement": the held ring is replaced only by a roster that
    /// verifies, has the same `aud` and `sub`, a higher epoch and is not expired. An expired held
    /// ring counts as no ring at all.
    public static func replaceRing(
        held heldJws: String?, new newJws: String, trust: TrustSet, expectedAud: String, now: Int? = nil
    ) -> RingReplacement {
        guard case .ok(let next) = verifyRing(newJws, trust: trust, expectedAud: expectedAud) else {
            return .keep(.newRejected)
        }
        if let held = liveRing(heldJws, trust: trust, expectedAud: expectedAud, now: now) {
            if next.sub != held.sub { return .keep(.otherProductOrSubject) }
            if next.epoch <= held.epoch { return .keep(.epochNotHigher) }
        }
        if ringExpired(next, now: now) { return .keep(.newExpired) }
        return .replace(next)
    }

    // ── Peer admission ───────────────────────────────────────────────────────────────────

    public enum RingSync: String, Sendable, Equatable { case none, request }

    public enum PeerAdmission: Sendable, Equatable {
        case admit(PeerCert, ringSync: RingSync)
        case refused(reason: String)
    }

    /// §15.3 "Peer admission". `ringSync == .request` means the certificate is on a newer epoch
    /// than the held roster: ask the peer for `RING`.
    public static func admitPeer(
        certJws: String, heldRing heldJws: String?, options o: VerifyPeerCertOptions
    ) -> PeerAdmission {
        guard case .ok(let c) = verifyPeerCert(certJws, options: o) else {
            return .refused(reason: "cert-invalid")
        }
        guard let ring = liveRing(heldJws, trust: o.trust, expectedAud: o.expectedAud, now: o.now) else {
            return .admit(c, ringSync: .none)
        }
        // A certificate of another account is judged by the session's own checks, never by this
        // ring's epoch: its numbers belong to a different roster.
        if c.sub != ring.sub { return .refused(reason: "cert-invalid") }
        if ring.epoch > c.ringEpoch {
            let listed = ring.devices.contains {
                $0.deviceId == c.deviceId && $0.signKey == c.signKey && $0.agreeKey == c.agreeKey
            }
            return listed ? .admit(c, ringSync: .none) : .refused(reason: "peer_revoked")
        }
        return .admit(c, ringSync: c.ringEpoch > ring.epoch ? .request : .none)
    }
}
