// The one pattern helper every claim and version check goes through (WIRE-CONTRACT-V4 §3).
//
// A pattern matches the WHOLE string, with nothing after the match — a line terminator
// included. `NSRegularExpression` with `^…$` accepts `1.2.3\n` and five other terminators
// (measured), so the pattern is wrapped in `\A(?:…)\z`, and every class is ASCII (`[0-9]`,
// never `\d`, which matches every Unicode decimal digit in ICU). Python (`_full_match`) and
// GDScript (`PKeyClaims.matches_whole`) apply the same rule.

import Foundation

/// The capture groups of `pattern` matched against the whole of `value` (group 0 first; nil for
/// a group that did not participate), or nil when it does not match whole.
public func wholeMatches(_ pattern: String, _ value: String) -> [String?]? {
    guard let re = try? NSRegularExpression(pattern: #"\A(?:"# + pattern + #")\z"#) else {
        return nil
    }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    guard let m = re.firstMatch(in: value, range: range), m.range == range else { return nil }
    return (0..<m.numberOfRanges).map { i in
        let r = m.range(at: i)
        guard r.location != NSNotFound, let rr = Range(r, in: value) else { return nil }
        return String(value[rr])
    }
}
