// The release record — WIRE-CONTRACT-V4 §2.4 and client steps 12–16 (plans/P3-01.md §2.4, §2.5).
//
// `releaseRecordClaims` is step 14; `verifyReleaseRecord` runs steps 12–15 in the contract's
// order: HASH BEFORE SIGNATURE (a body over `MAX_RECORD_JWS_BYTES`, or with a byte outside ASCII,
// is refused without hashing), the key selected from the PINNED release keys only and refused
// when it is also a product key, the signature, the claims, then the cross-check against the
// feed's pin. Nothing here does I/O or throws. client-core's `record.ts` is the reference.

import CryptoKit
import Foundation

/// P2-04's `BUILD_ID_RE`: ASCII, so build-id uniqueness and §2.8's tie-break compare bytes.
public let BUILD_ID_PATTERN = "[a-z0-9][a-z0-9._-]{0,63}"
/// The record kinds a v4 client verifies and never acts on (P4-01, P4-13, P4-19).
public let RESERVED_RECORD_KINDS: [String] = ["pack", "revocation", "delegation"]

/// `@polaris-key/manifest`'s `DELIVERABLE_ID_PATTERN`; at most 64 bytes.
private let DELIVERABLE_PATTERN = #"[a-z][a-z0-9-]*(\.[a-z0-9-]+)*"#
/// P2-04's `VERSION_RE`. The record names no scheme: the pin's version parses under the feed's.
private let RECORD_VERSION_PATTERN = #"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}"#
private let RECORD_SHA256_PATTERN = "[0-9a-f]{64}"
private let MAX_BUILDS = 64
private let MAX_ARTIFACTS = 32

// ── The verified document ─────────────────────────────────────────────────────────────────────

public struct ReleaseRecordArtifact: Sendable, Equatable {
    public let name: String
    /// v4 reads only `payload`.
    public let role: String
    public let sha256: String
    public let size: Int
    public let contentType: String?

    public init(name: String, role: String, sha256: String, size: Int, contentType: String? = nil) {
        self.name = name
        self.role = role
        self.sha256 = sha256
        self.size = size
        self.contentType = contentType
    }
}

public struct ReleaseRecordBuild: Sendable, Equatable {
    public let id: String
    public let platform: String
    public let arch: String
    public let format: String
    public let buildNumber: String?
    public let minOS: String?
    /// Absent or any object: §2.8 reads `engine` and `minBinary`.
    public let requires: [String: JSONValue]?
    /// Empty for a store-only build.
    public let artifacts: [ReleaseRecordArtifact]

    public init(
        id: String, platform: String, arch: String, format: String, buildNumber: String? = nil,
        minOS: String? = nil, requires: [String: JSONValue]? = nil,
        artifacts: [ReleaseRecordArtifact]
    ) {
        self.id = id
        self.platform = platform
        self.arch = arch
        self.format = format
        self.buildNumber = buildNumber
        self.minOS = minOS
        self.requires = requires
        self.artifacts = artifacts
    }
}

public struct ReleaseRecordProvenance: Sendable, Equatable {
    public let commit: String?
    public let workflowRun: String?

    public init(commit: String? = nil, workflowRun: String? = nil) {
        self.commit = commit
        self.workflowRun = workflowRun
    }
}

/// A verified `pkey-release+jws` payload (WIRE-CONTRACT-V4 §2.4).
public struct ReleaseRecordDoc: Sendable, Equatable {
    public let schemaVersion: Int
    public let aud: String
    public let deliverable: String
    public let kind: String
    public let version: String
    public let seq: Int
    public let issuedAt: Int
    public let minSupportedSeq: Int?
    public let tag: String?
    public let channel: String?
    public let title: String?
    public let notes: String?
    public let provenance: ReleaseRecordProvenance?
    /// Present for `kind: app`.
    public let builds: [ReleaseRecordBuild]?
    /// The payload as decoded, reserved members (`content`, …) included.
    public let json: JSONValue

    public init(
        schemaVersion: Int = 1, aud: String, deliverable: String = "app", kind: String = "app",
        version: String, seq: Int, issuedAt: Int, minSupportedSeq: Int? = nil,
        tag: String? = nil, channel: String? = nil, title: String? = nil, notes: String? = nil,
        provenance: ReleaseRecordProvenance? = nil, builds: [ReleaseRecordBuild]?,
        json: JSONValue = .null
    ) {
        self.schemaVersion = schemaVersion
        self.aud = aud
        self.deliverable = deliverable
        self.kind = kind
        self.version = version
        self.seq = seq
        self.issuedAt = issuedAt
        self.minSupportedSeq = minSupportedSeq
        self.tag = tag
        self.channel = channel
        self.title = title
        self.notes = notes
        self.provenance = provenance
        self.builds = builds
        self.json = json
    }

    /// The typed view of a record object, or nil when a member is missing or mistyped. SHAPE
    /// only — `releaseRecordClaims` is the contract; a payload that passed it always converts.
    public init?(json: JSONValue) {
        guard let o = json.objectValue,
            let schemaVersion = o["schemaVersion"]?.exactInt, let aud = o["aud"]?.stringValue,
            let deliverable = o["deliverable"]?.stringValue, let kind = o["kind"]?.stringValue,
            let version = o["version"]?.stringValue, let seq = o["seq"]?.exactInt,
            let issuedAt = o["issuedAt"]?.exactInt
        else { return nil }
        var builds: [ReleaseRecordBuild]?
        if let raw = o["builds"] {
            guard let list = raw.arrayValue else { return nil }
            var out: [ReleaseRecordBuild] = []
            for b in list {
                guard let bo = b.objectValue, let id = bo["id"]?.stringValue,
                    let platform = bo["platform"]?.stringValue, let arch = bo["arch"]?.stringValue,
                    let format = bo["format"]?.stringValue,
                    let rawArtifacts = bo["artifacts"]?.arrayValue
                else { return nil }
                var artifacts: [ReleaseRecordArtifact] = []
                for a in rawArtifacts {
                    guard let ao = a.objectValue, let name = ao["name"]?.stringValue,
                        let role = ao["role"]?.stringValue, let sha = ao["sha256"]?.stringValue,
                        let size = ao["size"]?.exactInt
                    else { return nil }
                    artifacts.append(
                        ReleaseRecordArtifact(
                            name: name, role: role, sha256: sha, size: size,
                            contentType: ao["contentType"]?.stringValue))
                }
                out.append(
                    ReleaseRecordBuild(
                        id: id, platform: platform, arch: arch, format: format,
                        buildNumber: bo["buildNumber"]?.stringValue, minOS: bo["minOS"]?.stringValue,
                        requires: bo["requires"]?.objectValue, artifacts: artifacts))
            }
            builds = out
        }
        let provenance = o["provenance"]?.objectValue.map {
            ReleaseRecordProvenance(
                commit: $0["commit"]?.stringValue, workflowRun: $0["workflowRun"]?.stringValue)
        }
        self.init(
            schemaVersion: schemaVersion, aud: aud, deliverable: deliverable, kind: kind,
            version: version, seq: seq, issuedAt: issuedAt,
            minSupportedSeq: o["minSupportedSeq"]?.exactInt, tag: o["tag"]?.stringValue,
            channel: o["channel"]?.stringValue, title: o["title"]?.stringValue,
            notes: o["notes"]?.stringValue, provenance: provenance, builds: builds, json: json)
    }
}

// ── Step 14: the claims ───────────────────────────────────────────────────────────────────────

private func nonEmptyString(_ v: JSONValue?) -> Bool {
    guard let s = v?.stringValue else { return false }
    return !s.isEmpty
}

/// An optional string member: absent, or a string (a present `null` is refused).
private func optionalString(_ o: [String: JSONValue], _ key: String) -> Bool {
    guard let v = o[key] else { return true }
    return v.stringValue != nil
}

private func recordClaimsHold(
    _ doc: [String: JSONValue], expectedAud: String, nonWire: NonWireIntegers
) -> Bool {
    func int(_ v: JSONValue?, _ pointer: String, _ min: Int) -> Bool {
        guard let i = v?.exactInt else { return false }
        return wireInteger(i, pointer: pointer, min: min, in: nonWire)
    }

    guard int(doc["schemaVersion"], "/schemaVersion", 1), doc["schemaVersion"]?.exactInt == 1
    else { return false }
    guard doc["aud"]?.stringValue == expectedAud else { return false }
    guard let deliverable = doc["deliverable"]?.stringValue, deliverable.utf8.count <= 64,
        matchesWhole(DELIVERABLE_PATTERN, deliverable)
    else { return false }
    guard nonEmptyString(doc["kind"]) else { return false }
    guard let version = doc["version"]?.stringValue, matchesWhole(RECORD_VERSION_PATTERN, version)
    else { return false }
    guard int(doc["seq"], "/seq", 1), int(doc["issuedAt"], "/issuedAt", 0) else { return false }
    if doc["minSupportedSeq"] != nil, !int(doc["minSupportedSeq"], "/minSupportedSeq", 1) {
        return false
    }
    for key in ["tag", "channel", "title", "notes"] where !optionalString(doc, key) {
        return false
    }
    if let raw = doc["provenance"] {
        guard let p = raw.objectValue, optionalString(p, "commit"), optionalString(p, "workflowRun")
        else { return false }
    }

    guard let rawBuilds = doc["builds"] else { return doc["kind"]?.stringValue != "app" }
    guard let builds = rawBuilds.arrayValue, builds.count >= 1, builds.count <= MAX_BUILDS else {
        return false
    }
    var ids = Set<String>()
    for (i, rawBuild) in builds.enumerated() {
        guard let build = rawBuild.objectValue else { return false }
        // ASCII by the pattern, so the set compares bytes.
        guard let id = build["id"]?.stringValue, matchesWhole(BUILD_ID_PATTERN, id),
            ids.insert(id).inserted
        else { return false }
        guard nonEmptyString(build["platform"]), nonEmptyString(build["arch"]),
            nonEmptyString(build["format"])
        else { return false }
        guard optionalString(build, "buildNumber"), optionalString(build, "minOS") else {
            return false
        }
        if let requires = build["requires"], requires.objectValue == nil { return false }
        guard let artifacts = build["artifacts"]?.arrayValue, artifacts.count <= MAX_ARTIFACTS else {
            return false
        }
        var payloads = 0
        for (j, rawArtifact) in artifacts.enumerated() {
            guard let artifact = rawArtifact.objectValue else { return false }
            guard nonEmptyString(artifact["name"]), nonEmptyString(artifact["role"]) else {
                return false
            }
            if artifact["role"]?.stringValue == "payload" { payloads += 1 }
            guard let sha = artifact["sha256"]?.stringValue,
                matchesWhole(RECORD_SHA256_PATTERN, sha)
            else { return false }
            guard int(artifact["size"], "/builds/\(i)/artifacts/\(j)/size", 0) else { return false }
            guard optionalString(artifact, "contentType") else { return false }
        }
        if payloads > 1 { return false }
    }
    return true
}

/// Client step 14 over a verified record payload: true when every claim of §2.4 holds. A caller
/// holding a verified JWS passes its `nonWireIntegers`; a caller checking a value it built
/// passes none. Reserved and unknown kinds pass here; the cross-check refuses them where an app
/// record is expected.
public func releaseRecordClaims(
    _ payload: JSONValue, expectedAud: String, nonWire: NonWireIntegers = []
) -> Bool {
    guard let doc = payload.objectValue else { return false }
    return recordClaimsHold(doc, expectedAud: expectedAud, nonWire: nonWire)
}

// ── Steps 12–15 ───────────────────────────────────────────────────────────────────────────────

/// The record hash (WIRE-CONTRACT-V4 §8): the lowercase hex SHA-256 of the compact JWS's bytes,
/// exactly as received. `verifyReleaseRecord` refuses a non-ASCII body before hashing it, so the
/// UTF-8 encoding here only matters to a caller hashing something else.
public func recordHash(_ jws: String) -> String {
    SHA256.hash(data: Data(jws.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// What a target pins, for the cross-check (step 15).
public struct ReleaseRecordPin: Sendable, Equatable {
    public let deliverable: String
    public let version: String
    public let seq: Int

    public init(deliverable: String = "app", version: String, seq: Int) {
        self.deliverable = deliverable
        self.version = version
        self.seq = seq
    }
}

public struct VerifyReleaseRecordOptions: Sendable {
    /// The PINNED release keys: the only keys a record verifies against, never merged with, and
    /// never added to from, the product trust set (step 13).
    public var releaseKeys: TrustSet
    /// The EFFECTIVE product trust set. A selected release key whose raw bytes are also in it is
    /// refused at step `jws` (a release key is never a product key).
    public var productTrust: TrustSet
    public var expectedAud: String
    /// The feed's pin, `targets[].release.sha256`: the lowercase hex SHA-256 the body must have.
    public var expectedHash: String
    /// The pin to cross-check against (step 15). Nil verifies only (a reserved kind).
    public var pin: ReleaseRecordPin?

    public init(
        releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String, expectedHash: String,
        pin: ReleaseRecordPin? = nil
    ) {
        self.releaseKeys = releaseKeys
        self.productTrust = productTrust
        self.expectedAud = expectedAud
        self.expectedHash = expectedHash
        self.pin = pin
    }
}

/// Why `verifyReleaseRecord` refused, by client step (`releaseRecordCases` `expect.step`).
public enum ReleaseRecordStep: String, Sendable, Equatable, CaseIterable {
    case hash, jws, claims
    case crossCheck = "cross-check"
}

public enum VerifyReleaseRecordResult: Sendable, Equatable {
    case ok(ReleaseRecordDoc)
    case refused(ReleaseRecordStep)

    public var record: ReleaseRecordDoc? {
        if case .ok(let record) = self { return record }
        return nil
    }

    public var step: ReleaseRecordStep? {
        if case .refused(let step) = self { return step }
        return nil
    }
}

/// The protected header's `kid`, read without trusting anything else in it (`verify` re-reads
/// the header strictly). Nil when there is none to read.
private func headerKid(_ jws: String) -> String? {
    guard let first = jws.split(separator: ".", omittingEmptySubsequences: false).first,
        let data = Base64URL.decodeStrict(String(first)),
        let header = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return nil }
    return header.objectValue?["kid"]?.stringValue
}

/// Client steps 12–15 (plans/P3-01.md §2.5), in the contract's order:
///
///  12. a body over `MAX_RECORD_JWS_BYTES` (88 844) or with a byte outside ASCII is refused
///      without hashing; otherwise its SHA-256 must equal `expectedHash`, before any Ed25519 work;
///  13. the key is selected by `kid` from `releaseKeys` only, refused if its raw bytes are also
///      in `productTrust`, then `verify` with that one key and `typ` `pkey-release+jws`;
///  14. the claims (`releaseRecordClaims`);
///  15. with a `pin`: `kind` is `app`, and `deliverable`, `version` and `seq` equal the pin's.
///
/// Never throws.
public func verifyReleaseRecord(
    _ jws: String, options opts: VerifyReleaseRecordOptions
) -> VerifyReleaseRecordResult {
    // 12. Hash before signature.
    let bytes = jws.utf8
    guard bytes.count <= MAX_RECORD_JWS_BYTES, bytes.allSatisfy({ $0 < 0x80 }) else {
        return .refused(.hash)
    }
    guard recordHash(jws) == opts.expectedHash else { return .refused(.hash) }

    // 13. The pinned release keys only, and never a product key.
    guard let kid = headerKid(jws), let key = opts.releaseKeys[kid],
        let raw = Base64URL.decode(key), raw.count == 32
    else { return .refused(.jws) }
    for productKey in opts.productTrust.values {
        if let other = Base64URL.decode(productKey), other == raw { return .refused(.jws) }
    }
    guard let v = JWSVerifier.verify(jws, trust: [kid: key], typ: .release, requireTyp: true)
    else { return .refused(.jws) }

    // 14. The claims. A payload that does not decode fails here.
    guard let payload = try? JSONDecoder().decode(JSONValue.self, from: v.payload),
        releaseRecordClaims(payload, expectedAud: opts.expectedAud, nonWire: v.nonWireIntegers),
        let record = ReleaseRecordDoc(json: payload)
    else { return .refused(.claims) }

    // 15. The cross-check against the pin.
    if let pin = opts.pin {
        guard record.kind == "app", record.deliverable == pin.deliverable,
            record.version == pin.version, record.seq == pin.seq
        else { return .refused(.crossCheck) }
    }
    return .ok(record)
}

/// One record that survived the reload path.
public struct CommittedRecord: Sendable, Equatable {
    public let jws: String
    public let record: ReleaseRecordDoc
}

/// The reload path for the `releaseRecords` slice (plans/P3-01.md §2.5): each `records[h]` goes
/// through steps 12–14 with `h` as the pin, and is kept only when `pinned` (the hashes a
/// surviving committed feed's target for this platform pins) holds `h`. Never throws.
public func reloadReleaseRecords(
    _ cached: [String: String], releaseKeys: TrustSet, productTrust: TrustSet,
    expectedAud: String, pinned: Set<String>
) -> [String: CommittedRecord] {
    var out: [String: CommittedRecord] = [:]
    for (h, jws) in cached where pinned.contains(h) {
        let r = verifyReleaseRecord(
            jws,
            options: VerifyReleaseRecordOptions(
                releaseKeys: releaseKeys, productTrust: productTrust, expectedAud: expectedAud,
                expectedHash: h))
        if let record = r.record { out[h] = CommittedRecord(jws: jws, record: record) }
    }
    return out
}
