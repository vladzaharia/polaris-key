// Save compatibility on the device (P4-20, CONTENT §6.7 item 8, PARITY `packs.provides`): which
// content ids a pack release provides, read from its signed record's record-level `provides`.
// A port of client-core `packs/provides.ts`.
//
// `provides` is a member WIRE-CONTRACT-V4 §2.5.1 reserves on the pack record ("ignored by v1"):
// it is never a claim, so a record that carries a malformed list still verifies. This reader is
// the one interpretation every SDK shares, beside the claims and never inside them:
//
//   - absent                        -> provides nothing;
//   - an array of 0-`maxProvides` unique strings, each a content id (`isContentId`)
//                                   -> those ids;
//   - anything else                 -> provides nothing (an unusable list answers no id).
//
// Content ids are opaque: printable ASCII without the space, 1-128 characters (the shape the
// publish rules enforce), re-checked here so no SDK trusts a list another would refuse.

import Foundation
import PolarisKeyCore

/// The most ids one `provides` (or `removes`) list may hold.
public let maxProvides = 4096

/// The longest content id.
public let maxContentIdLength = 128

/// Whether `s` is a content id: 1-128 bytes, each printable ASCII without the space
/// (0x21...0x7E). Checked per UTF-8 byte, never through a locale-aware API.
public func isContentId(_ s: String) -> Bool {
    let bytes = s.utf8
    guard !bytes.isEmpty, bytes.count <= maxContentIdLength else { return false }
    for b in bytes where b < 0x21 || b > 0x7E { return false }
    return true
}

/// A record payload's `provides`, as a set (empty when absent or unusable).
public func providesOf(_ record: JSONValue?) -> Set<String> {
    guard case .object(let o)? = record, case .array(let list)? = o["provides"],
        list.count <= maxProvides
    else { return [] }
    var out = Set<String>()
    for v in list {
        guard case .string(let id) = v, isContentId(id), !out.contains(id) else { return [] }
        out.insert(id)
    }
    return out
}

/// The payload of a compact JWS the engine has ALREADY verified (a stored install, an embedded
/// baseline, a record `ensure`'s step 2 verified), decoded and never re-verified here; nil when
/// it does not decode.
public func verifiedPayloadOf(_ jws: String) -> JSONValue? {
    let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, let data = Base64URL.decodeStrict(String(parts[1])) else { return nil }
    return try? JSONDecoder().decode(JSONValue.self, from: data)
}

/// What save compatibility reads from one verified pack record.
public struct ProvidesFacts: Sendable, Equatable {
    public var provides: Set<String>
    /// The record's `entitlement`, or nil: a licence without it hides the pack (CONTENT §6.7
    /// item 9), so it never answers.
    public var entitlement: String?

    public init(provides: Set<String>, entitlement: String?) {
        self.provides = provides
        self.entitlement = entitlement
    }

    /// `providesOf` and the entitlement of a verified record payload.
    public init(record: JSONValue?) {
        provides = providesOf(record)
        if case .object(let o)? = record, case .string(let e)? = o["entitlement"] {
            entitlement = e
        } else {
            entitlement = nil
        }
    }

    /// Whether the licence lets this pack answer: ungated, no License service (`granted` nil), or
    /// the flag granted.
    func entitled(_ granted: Set<String>?) -> Bool {
        guard let entitlement, let granted else { return true }
        return granted.contains(entitlement)
    }

    /// Whether this release provides `contentId` and the licence lets it answer.
    func answers(_ contentId: String, _ granted: Set<String>?) -> Bool {
        provides.contains(contentId) && entitled(granted)
    }
}

/// What `packFor` answers: the pack whose target release provides the id.
public struct PackProvider: Sendable, Equatable {
    public var packId: String
    public var release: ReleasePin

    public init(packId: String, release: ReleasePin) {
        self.packId = packId
        self.release = release
    }
}

/// The most record facts the engine's memo keeps before it starts over.
let MAX_PROVIDES_MEMO = 1024

/// `ProvidesFacts` of verified records, by record hash (bounded: cleared when full).
struct ProvidesMemo {
    private var table: [String: ProvidesFacts] = [:]

    /// The memo key of a pack's release: its pack id and record hash (a hash alone would let a
    /// target that names another pack's record answer for it).
    static func key(_ packId: String, _ recordSha256: String) -> String { packId + "\u{0}" + recordSha256 }

    func get(_ key: String) -> ProvidesFacts? { table[key] }

    /// The facts of a verified record's compact JWS, memoised under `key` (`ProvidesMemo.key`).
    mutating func facts(_ key: String, _ jws: String) -> ProvidesFacts {
        if let hit = table[key] { return hit }
        let f = ProvidesFacts(record: verifiedPayloadOf(jws))
        if table.count >= MAX_PROVIDES_MEMO { table.removeAll() }
        table[key] = f
        return f
    }
}
