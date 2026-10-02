// The marker, `pkey-marker/1` (plans/P4-01.md §2.6, §2.8; WIRE-CONTRACT-V4 §3.7): the compact
// pack record beside an embedded single-file payload (`X.pkey.json`) or inside an embedded tree
// (`D/.pkey/pack.json`). `cases.json#markerCases` pins `verifyMarker`; the byte match against
// the embedded payload and the content stamp's pin is the host's (`matchEmbedded`).
// client-core `packs/marker.ts` is the reference.

import Foundation
import PolarisKeyCore

/// What `verifyMarker` reports.
public enum VerifyMarkerResult: Sendable, Equatable {
    case ok(packId: String, version: String, release: String, record: PackRecordDoc, recordSha256: String)
    /// `marker-rejected` at `step`: `format`, `hash`, `jws`, `claims` or `cross-check` (and the
    /// host's own `payload` and `pin`, from `matchEmbedded`).
    case rejected(step: String)
}

/// `verifyMarker(marker, …)` (§2.6 "Markers", V4 §3.7), in order: the marker file's bytes pass
/// V4 §1.2's strict JSON (`format`); `format == "pkey-marker/1"`, `packId` a pack id, `version`
/// matching `VERSION_RE`, `release` a string (`format`); steps 12–14 with `release` as the body
/// and its own SHA-256 as the pin hash (`hash`, `jws`, `claims`); `kind == "pack"`, `deliverable
/// == packId`, `version == version` (`cross-check`). Never throws.
public func verifyMarker(
    _ marker: [UInt8], releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String
) -> VerifyMarkerResult {
    guard let (doc, _) = strictParse(marker), let m = doc.objectValue else {
        return .rejected(step: "format")
    }
    guard m["format"]?.stringValue == MARKER_FORMAT, isPackId(m["packId"]),
        let packId = m["packId"]?.stringValue,
        let version = m["version"]?.stringValue, wholeMatches(PackPatterns.version, version) != nil,
        let release = m["release"]?.stringValue
    else { return .rejected(step: "format") }
    if !release.utf8.allSatisfy({ $0 < 0x80 }) || release.utf8.count > MAX_RECORD_JWS_BYTES {
        return .rejected(step: "hash")
    }
    let recordSha256 = recordHash(release)
    let v = verifyReleaseRecord(
        release,
        options: VerifyReleaseRecordOptions(
            releaseKeys: releaseKeys, productTrust: productTrust, expectedAud: expectedAud,
            expectedHash: recordSha256))
    switch v {
    case .refused(let step): return .rejected(step: step.rawValue)
    case .ok(let record):
        guard record.kind == "pack", record.deliverable == packId, record.version == version,
            let pack = PackRecordDoc(json: record.json)
        else { return .rejected(step: "cross-check") }
        return .ok(
            packId: packId, version: version, release: release, record: pack,
            recordSha256: recordSha256)
    }
}

public func verifyMarker(
    _ marker: String, releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String
) -> VerifyMarkerResult {
    verifyMarker(
        Array(marker.utf8), releaseKeys: releaseKeys, productTrust: productTrust,
        expectedAud: expectedAud)
}

/// What the host measured of the embedded payload: a single file's SHA-256 and size, or a
/// tree's `treeDigest` (computed from the files under its directory minus `.pkey/`).
public enum EmbeddedPayload: Sendable, Equatable {
    case file(sha256: String, size: Int)
    case tree(treeDigest: String)
}

/// The host's match of an embedded payload against its verified marker (§2.6): the variant whose
/// `payload` the bytes match, and, when the content stamp pins the pack, `recordSha256` equal to
/// the pin's `sha256`. The variant's index, or the refused step: `payload` (no variant matches)
/// or `pin` (the embedded copy is not the pinned release and is not used).
public func matchEmbedded(
    packId: String, record: PackRecordDoc, recordSha256: String, payload: EmbeddedPayload,
    stamp: AppContent?
) -> Result<Int, MarkerRefusal> {
    let index = record.variants.firstIndex { v in
        switch payload {
        case .file(let sha, let size): return v.payload.sha256 == sha && v.payload.size == size
        case .tree(let digest): return v.files.layout == "tree" && v.payload.sha256 == digest
        }
    }
    guard let index else { return .failure(MarkerRefusal(step: "payload")) }
    if let pin = stamp?.pins.first(where: { $0.pack == packId }), pin.sha256 != recordSha256 {
        return .failure(MarkerRefusal(step: "pin"))
    }
    return .success(index)
}

/// A `marker-rejected` refusal at the host's own steps.
public struct MarkerRefusal: Error, Sendable, Equatable {
    public let step: String
}
