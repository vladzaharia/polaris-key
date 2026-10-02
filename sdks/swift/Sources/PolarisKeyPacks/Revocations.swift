// The device's revocations (plans/P4-13.md §2.5 "Persistence"; client-core
// `packs/revocations.ts`): a sibling document, `revocations.json`, beside P4-06's pack state and
// never inside it, so an unparseable `state.json` cannot lose revocations and a lost revocation
// file cannot touch the install state.
//
//   {v: 1, revoked: {[targetSha256]: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}
//
// Each entry holds the winning revocation's compact JWS verbatim, the pin it was verified with
// (the feed entry's `pack`, `version`, `seq`), its record hash and its `issuedAt`. The document is
// NEVER trusted from storage: `reloadRevocations` re-verifies every entry against the currently
// pinned release keys and the stored pin, and a failing entry is dropped alone. A key that is no
// longer pinned forgets its target (the key-rotation recovery lever for a stolen release key); any
// other failure adds the entry's pack to `relearn`, cleared only by a fresh, network-verified
// feed whose `revocations` member is present and usable, or by `recoverState()`.
//
// Pure functions over the document: each returns a new document. The engine owns the I/O, the
// `revocationsStored` flag in `state.json` and the mount refusals.

import Foundation
import PolarisKeyCore

/// The document's version.
public let REVOCATIONS_VERSION = 1
/// A device keeps at most this many revoked targets; beyond it the oldest by `issuedAt` is dropped
/// first (and its pack is NOT added to `relearn`: dropping at the cap is deliberate).
public let MAX_STORED_REVOCATIONS = 256

/// One stored revocation: the winner for its target.
public struct StoredRevocation: Sendable, Equatable, RankedRevocation {
    /// The revocation record's compact JWS, verbatim.
    public var jws: String
    /// The pin it was verified with: the feed entry's pack, version and `seq`.
    public var pack: String
    public var version: String
    public var seq: Int
    /// The revocation record's hash.
    public var record: String
    public var issuedAt: Int

    public init(jws: String, pack: String, version: String, seq: Int, record: String, issuedAt: Int) {
        self.jws = jws
        self.pack = pack
        self.version = version
        self.seq = seq
        self.record = record
        self.issuedAt = issuedAt
    }

    public var json: JSONValue {
        .object([
            "jws": .string(jws), "pack": .string(pack), "version": .string(version), "seq": .int(seq),
            "record": .string(record), "issuedAt": .int(issuedAt),
        ])
    }
}

public struct RevocationsDoc: Sendable, Equatable {
    public var v = REVOCATIONS_VERSION
    /// Revoked target hash → the winning revocation.
    public var revoked: [String: StoredRevocation] = [:]
    /// Packs whose revocations must be re-learned from a fresh feed (sorted).
    public var relearn: [String] = []

    public init(revoked: [String: StoredRevocation] = [:], relearn: [String] = []) {
        self.revoked = revoked
        self.relearn = relearn
    }

    public var json: JSONValue {
        .object([
            "v": .int(v), "revoked": .object(revoked.mapValues(\.json)),
            "relearn": .array(relearn.map(JSONValue.string)),
        ])
    }
}

public func emptyRevocations() -> RevocationsDoc { RevocationsDoc() }

/// True when the document holds nothing (the state a product with no revocations is in).
public func isEmptyRevocations(_ doc: RevocationsDoc) -> Bool {
    doc.revoked.isEmpty && doc.relearn.isEmpty
}

private func nat(_ v: JSONValue?) -> Int? {
    guard case .int(let i)? = v, i >= 0, i <= MAX_WIRE_INTEGER else { return nil }
    return i
}

private func sortedPacks(_ s: Set<String>) -> [String] { s.sorted { compareUTF8Bytes($0, $1) < 0 } }

/// Parse the stored text's shape. Nil when it does not parse as the document at all (a torn
/// file, which the engine quarantines). Entries of the wrong shape are dropped with their pack (if
/// it can be read) added to `relearn`: shape only, `reloadRevocations` decides what is trusted.
public func parseRevocations(_ text: String) -> RevocationsDoc? {
    guard let doc = parseJSON(text)?.objectValue, doc["v"] == .int(REVOCATIONS_VERSION),
        let revoked = doc["revoked"]?.objectValue, let relearnList = doc["relearn"]?.arrayValue
    else { return nil }
    var out = emptyRevocations()
    var relearn = Set<String>()
    for p in relearnList { if let s = p.stringValue, isPackId(s) { relearn.insert(s) } }
    for (target, e) in revoked {
        let o = e.objectValue
        if isSha256Hex(target), let o, let jws = o["jws"]?.stringValue, let pack = o["pack"]?.stringValue,
            isPackId(pack), let version = o["version"]?.stringValue, let seq = nat(o["seq"]), seq >= 1,
            let record = o["record"]?.stringValue, isSha256Hex(record), let issuedAt = nat(o["issuedAt"])
        {
            out.revoked[target] = StoredRevocation(
                jws: jws, pack: pack, version: version, seq: seq, record: record, issuedAt: issuedAt)
        } else if let pack = o?["pack"]?.stringValue, isPackId(pack) {
            relearn.insert(pack)
        }
    }
    out.relearn = sortedPacks(relearn)
    return out
}

public func serializeRevocations(_ doc: RevocationsDoc) -> String { canonicalJSON(doc.json) }

/// The protected header's `kid`, read without trusting anything else.
private func kidOf(_ jws: String) -> String? {
    guard let first = jws.split(separator: ".", omittingEmptySubsequences: false).first,
        let data = Base64URL.decode(String(first)),
        let h = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return nil }
    return h.objectValue?["kid"]?.stringValue
}

public struct ReloadRevocationsResult: Sendable, Equatable {
    public var doc: RevocationsDoc
    /// The verified revocation of every surviving target.
    public var verified: [String: VerifiedRevocation]
    /// Whether re-verification changed the document (a drop or a `relearn` addition).
    public var changed: Bool
}

/// Re-verify every entry against the currently pinned release keys and its stored pin (`target`
/// = the map key, `record` = the stored hash). A failing entry is dropped alone: a key that is no
/// longer pinned forgets the target; any other failure adds the entry's pack to `relearn`.
public func reloadRevocations(
    _ doc: RevocationsDoc, releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String
) -> ReloadRevocationsResult {
    var out = RevocationsDoc(revoked: [:], relearn: doc.relearn)
    var verified: [String: VerifiedRevocation] = [:]
    var changed = false
    var relearn = Set(doc.relearn)
    for (target, e) in doc.revoked {
        let r = verifyRevocation(
            e.jws,
            options: VerifyRevocationOptions(
                releaseKeys: releaseKeys, productTrust: productTrust, expectedAud: expectedAud,
                entry: FeedRevocation(record: e.record, pack: e.pack, target: target, version: e.version, seq: e.seq)))
        if let v = r.revocation {
            out.revoked[target] = e
            verified[target] = v
            continue
        }
        changed = true
        let kid = kidOf(e.jws)
        let rotated = r.step == .jws && kid != nil && releaseKeys[kid!] == nil
        if !rotated { relearn.insert(e.pack) }
    }
    out.relearn = sortedPacks(relearn)
    return ReloadRevocationsResult(doc: out, verified: verified, changed: changed)
}

/// Store a verified revocation (plans/P4-13.md §2.5 step 11): kept when its target is new, or
/// when `newerRevocation` ranks it above the stored one (a superseding revocation). Then the cap.
/// Returns the new document and whether anything changed.
public func storeRevocation(
    _ doc: RevocationsDoc, _ revocation: VerifiedRevocation, jws: String
) -> (doc: RevocationsDoc, changed: Bool) {
    let target = revocation.target
    let next = StoredRevocation(
        jws: jws, pack: revocation.pack, version: revocation.version, seq: revocation.seq,
        record: revocation.record, issuedAt: revocation.issuedAt)
    if let prev = doc.revoked[target] {
        if prev.record == revocation.record { return (doc, false) }
        if newerRevocation(next, prev) != next { return (doc, false) }
    }
    var out = doc
    out.revoked[target] = next
    return (capRevocations(out), true)
}

/// Keep at most `MAX_STORED_REVOCATIONS` targets: the oldest by `issuedAt` (then the lower record
/// hash) is dropped first, without adding its pack to `relearn`.
public func capRevocations(_ doc: RevocationsDoc) -> RevocationsDoc {
    guard doc.revoked.count > MAX_STORED_REVOCATIONS else { return doc }
    let keep = doc.revoked.keys.sorted { a, b in
        let x = doc.revoked[a]!
        let y = doc.revoked[b]!
        if x.issuedAt != y.issuedAt { return x.issuedAt > y.issuedAt }
        return compareUTF8Bytes(x.record, y.record) > 0
    }.prefix(MAX_STORED_REVOCATIONS)
    var out = doc
    out.revoked = [:]
    for t in keep { out.revoked[t] = doc.revoked[t] }
    return out
}

/// Clear `relearn` for the given packs.
public func clearRelearn(_ doc: RevocationsDoc, _ packs: [String]) -> (doc: RevocationsDoc, changed: Bool) {
    if packs.isEmpty { return (doc, false) }
    let drop = Set(packs)
    let relearn = doc.relearn.filter { !drop.contains($0) }
    if relearn.count == doc.relearn.count { return (doc, false) }
    var out = doc
    out.relearn = relearn
    return (out, true)
}
