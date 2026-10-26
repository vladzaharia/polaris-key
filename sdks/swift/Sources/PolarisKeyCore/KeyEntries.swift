// The licence's key-entry count (I-09, WIRE-CONTRACT-V4 §12.2): `{used, limit}` on a successful
// activation with Identity on, and on a `key_entry_limit` refusal. Absent with Identity off.
//
// Pure and lenient, like `ManageLink.read`: a malformed member is dropped, never repaired, and
// never costs the caller the token or the other fields of the answer. Every SDK reads it by the
// same rule (client-core `readKeyEntries`).

import Foundation

public struct KeyEntries: Sendable, Equatable {
    public let used: Int
    public let limit: Int

    public init(used: Int, limit: Int) {
        self.used = used
        self.limit = limit
    }

    /// The count as the Worker sends it, before validation.
    public struct Wire: Decodable, Sendable {
        let used: Int
        let limit: Int
    }

    /// The count when `used` is not negative and `limit` is at least 1, else nil.
    public static func read(_ wire: Wire?) -> KeyEntries? {
        guard let wire, wire.used >= 0, wire.limit >= 1 else { return nil }
        return KeyEntries(used: wire.used, limit: wire.limit)
    }
}
