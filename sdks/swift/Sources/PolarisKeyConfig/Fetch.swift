// The Config service's HTTP surface — `GET /<p>/config/document` (wire contract v3 §2.2, §5).
//
// One route, and the interesting thing about it is what is NOT here.
//
//   * There is no BUILD GATE. Version/channel enforcement is a licence grant (D-20) and answers
//     on `/license/document`, so this fetch can never come back `blocked`. A product with
//     License DISABLED still gets config documents on a plain device token — the wire-level
//     guarantee of service independence (D-08), and the reason this file has no licence import.
//   * There is no `/config/report`. Device telemetry relocated to `POST /<p>/devices/report`, a
//     Core surface, because it was licence anti-fraud data that had merely been living under a
//     config path.
//   * There is no status ladder. Both signed documents are fetched by Core's `getDocument`, so
//     the two can never drift on what a 403, a 429 or a dropped connection means, and adding a
//     third signed document later is a route string rather than another ladder.

import Foundation
import PolarisKeyCore

public enum ConfigEndpoints {
    /// `GET /<p>/config/document` — the signed config + secrets document, with its OWN ETag (§5).
    /// Independent of the licence's, so a settings edit no longer forces a licence re-download
    /// and a tier change no longer forces a settings refetch.
    public static func fetchDocument(
        _ core: CoreContext, token: String, etag: String? = nil
    ) async -> DocumentResult {
        await core.getDocument(.config, token: token, etag: etag)
    }

    /// `GET /<p>/config/schema` — the product's active catalog, unsigned and unauthenticated.
    /// Diagnostic only: nothing security-relevant is ever read from it, because it carries no
    /// signature to check. So every failure — a refusal, a transport error, a body that is not
    /// a catalog, local-only mode, a product that does not run Config (D-21: not even probed) —
    /// is `nil`, never a throw. The bytes are returned as served; the SDKs agree on the outer
    /// shape (`schemaVersion` + `entries`) they accept.
    public static func fetchSchema(_ core: CoreContext) async -> Data? {
        guard await core.enabled(.config),
            let response = try? await core.request(
                core.endpoints.configSchema, headers: ["accept": "application/json"]),
            response.isOK,
            isCatalog(response.body)
        else { return nil }
        return response.body
    }

    /// The catalog's outer shape. The entries are the product's own data; the client does not
    /// validate them, because nothing it decides depends on them.
    static func isCatalog(_ body: Data) -> Bool {
        guard case .object(let root)? = try? JSONDecoder().decode(JSONValue.self, from: body)
        else { return false }
        switch root["schemaVersion"] {
        case .int?: break
        case .double(let d)? where d == d.rounded(): break
        default: return false
        }
        if case .array? = root["entries"] { return true }
        return false
    }
}
