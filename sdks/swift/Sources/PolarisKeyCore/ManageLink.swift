// Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3): the `manageUrl` the Worker puts on the
// `device_limit` (and, with Identity, `key_entry_limit`) refusal, and the two things a client may
// add to it.
//
// Pure functions: no I/O, no signing, no change to any error type. The link is never an auth
// failure, so nothing here wipes state or asks for a retry; a host opens it only behind a user
// action ("Replace a device"). Every SDK pins the same table of cases (client-core
// `test/manage.test.ts`), so the links each one builds are byte-identical.

import Foundation

public enum ManageLink {
    /// The longest `manageUrl` a client keeps (characters); a longer one is ignored.
    public static let maxLength = 2048

    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

    private static func parse(_ raw: String) -> URLComponents? {
        if raw.isEmpty || raw.count > maxLength { return nil }
        if raw.unicodeScalars.contains(where: {
            $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F
        }) { return nil }
        // The shared rule (client-core `parseManage`): `<scheme>://` and no `@` or `\` in the
        // authority, checked before `URLComponents`, which is laxer on some inputs.
        guard let sep = raw.range(of: "://"), sep.lowerBound > raw.startIndex else { return nil }
        let authority = raw[sep.upperBound...].prefix(while: { $0 != "/" && $0 != "?" && $0 != "#" })
        if authority.contains("@") || authority.contains("\\") { return nil }
        guard let c = URLComponents(string: raw), let host = c.host, !host.isEmpty else {
            return nil
        }
        if c.user != nil || c.password != nil { return nil }
        switch c.scheme?.lowercased() {
        case "https": return c
        case "http": return loopback.contains(host) ? c : nil
        default: return nil
        }
    }

    /// Is `raw` a link a client may show: an absolute `https` URL (or `http` to a loopback
    /// host), with no userinfo, at most `maxLength` characters?
    public static func isValid(_ raw: String?) -> Bool {
        guard let raw else { return false }
        return parse(raw) != nil
    }

    /// The first valid candidate (top-level member, then the nested one), or nil.
    public static func read(_ candidates: String?...) -> String? {
        candidates.first(where: { isValid($0) }) ?? nil
    }

    /// The WHATWG `application/x-www-form-urlencoded` byte serializer: UTF-8, then
    /// `A-Z a-z 0-9 * - . _` as themselves, space as `+`, every other byte as `%XX`.
    public static func formEncode(_ value: String) -> String {
        var out = ""
        for byte in Array(value.utf8) {
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "*"), UInt8(ascii: "-"),
                UInt8(ascii: "."), UInt8(ascii: "_"):
                out.unicodeScalars.append(Unicode.Scalar(byte))
            case 0x20:
                out += "+"
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    private static func appendParam(_ target: String, name: String, encoded: String) -> String {
        let path: Substring
        var pairs: [Substring] = []
        if let q = target.firstIndex(of: "?") {
            path = target[..<q]
            pairs = target[target.index(after: q)...].split(
                separator: "&", omittingEmptySubsequences: true)
        } else {
            path = Substring(target)
        }
        var kept = pairs.filter { $0 != name && !$0.hasPrefix("\(name)=") }.map(String.init)
        kept.append("\(name)=\(encoded)")
        return "\(path)?\(kept.joined(separator: "&"))"
    }

    private static func splitFragment(_ url: String) -> (base: String, fragment: String?) {
        guard let h = url.firstIndex(of: "#") else { return (url, nil) }
        return (String(url[..<h]), String(url[url.index(after: h)...]))
    }

    /// Add the app's return URL as `return=`: inside the fragment's query when the fragment
    /// holds a portal route (`#/…`), else in the URL's query. An earlier `return` is replaced and
    /// every other byte is kept. `url` comes back unchanged when it is not a valid link or
    /// `returnURL` is empty.
    public static func withReturn(_ url: String, _ returnURL: String) -> String {
        guard parse(url) != nil, !returnURL.isEmpty else { return url }
        let encoded = formEncode(returnURL)
        let (base, fragment) = splitFragment(url)
        if let fragment, fragment.hasPrefix("/") {
            return "\(base)#\(appendParam(fragment, name: "return", encoded: encoded))"
        }
        let withQuery = appendParam(base, name: "return", encoded: encoded)
        return fragment.map { "\(withQuery)#\($0)" } ?? withQuery
    }

    /// Add the licence key as the fragment `#key=<key>` on an `/activate` link. Any other link
    /// (the free-device route) or an invalid one comes back unchanged: the key is never put
    /// anywhere else, and a fragment never reaches a server.
    public static func withKey(_ url: String, _ key: String) -> String {
        guard let c = parse(url), !key.isEmpty else { return url }
        var path = c.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        guard path == "/activate" else { return url }
        let (base, fragment) = splitFragment(url)
        if let fragment, fragment.hasPrefix("/") { return url }
        return "\(base)#key=\(formEncode(key))"
    }
}
