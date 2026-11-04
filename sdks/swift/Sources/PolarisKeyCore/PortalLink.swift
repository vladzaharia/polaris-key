// The product page link (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md), pinned by
// conformance/corpus/v2/portal-matrix.json. A port of client-core's `portal`.
//
// Discovery's `core.portal` is UNSIGNED display data: whether the product's customer portal is on
// and, while it is, the product page `<customer origin>/activate?product=<slug>`. Pure functions,
// no I/O:
//
//   PortalLink.parse(core:)   the member as a whole: nil for unknown, or a PortalMember
//   PortalLink.link(...)      the one link a kit draws: the response's own link, then discovery's
//                             member, then the legacy guess against a Worker that sent none. Nil
//                             means no link: the kit draws "Contact {developer}"
//
// A link that fails §5.3 rule 4 is no link, never repaired and never replaced by a guess once the
// Worker has answered. A client never adds `#key=` to it.

import Foundation

/// Discovery's `core.portal`, normalised. `activate` is nil while the portal is off or its link
/// failed the rule.
public struct PortalMember: Sendable, Equatable {
    public let enabled: Bool
    public let activate: String?

    public init(enabled: Bool, activate: String? = nil) {
        self.enabled = enabled
        self.activate = activate
    }
}

public enum PortalLink {
    /// `core.portal` of a discovery document's `core` block, or nil when it says nothing usable
    /// (an older Worker, or a malformed member): "unknown", which is not "off".
    public static func parse(core: JSONValue?) -> PortalMember? {
        guard case .object(let members)? = core, case .object(let portal)? = members["portal"],
            case .bool(let enabled)? = portal["enabled"]
        else { return nil }
        guard enabled else { return PortalMember(enabled: false) }
        let activate = portal["activate"]?.stringValue
        return PortalMember(enabled: true, activate: ManageLink.isValid(activate) ? activate : nil)
    }

    /// The product page link, or nil (no link: the kit draws "Contact {developer}"). First match:
    /// a valid `served` link; the discovered `portal` (off, or no usable link, is nil, never the
    /// guess); the legacy `<origin>/activate?product=<slug>` where the Worker said nothing.
    public static func link(served: String?, portal: PortalMember?, baseUrl: String, product: String)
        -> String?
    {
        if let served, ManageLink.isValid(served) { return served }
        if let portal { return portal.enabled ? portal.activate : nil }
        if product.isEmpty { return nil }
        return legacy(baseUrl: baseUrl, product: product)
    }

    private static func legacy(baseUrl: String, product: String) -> String? {
        var base = Substring(baseUrl)
        while base.hasSuffix("/") { base = base.dropLast() }
        let origin = base == "https://key.plrs.im" ? CUSTOMER_ORIGIN_DEFAULT : String(base)
        let link = "\(origin)/activate?product=\(encodeSlug(product))"
        return ManageLink.isValid(link) ? link : nil
    }

    /// RFC 3986 unreserved characters stay; every other UTF-8 byte is `%XX`.
    private static func encodeSlug(_ value: String) -> String {
        var out = ""
        let unreserved = Set("0123456789-._~".unicodeScalars)
        for byte in value.utf8 {
            let scalar = Unicode.Scalar(byte)
            let plain = byte < 0x80 && (scalar.properties.isAlphabetic || unreserved.contains(scalar))
            if plain {
                out.unicodeScalars.append(scalar)
            } else {
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }
}
