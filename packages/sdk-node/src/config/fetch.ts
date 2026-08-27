// The Config service's HTTP surface — `GET /<p>/config/document` (wire contract v3 §2.2, §5).
//
// One route, and the interesting thing about it is what is NOT here. There is no build gate:
// version/channel enforcement is a licence grant (D-20) and answers on `/license/document`, so
// this fetch can never come back `blocked`. A product with License DISABLED still gets config
// documents on a plain device token, which is the wire-level guarantee of service independence
// (D-08) — and the reason this module has no licence import at all.
//
// There is also no `/config/report`: device telemetry relocated to `POST /<p>/devices/report`,
// a Core surface, because it was licence anti-fraud data that had merely been living under a
// config path.

import type { CoreContext, DocumentResult } from "../core/context.js";

/** `GET /<p>/config/document` — the signed config + secrets document, with its OWN ETag (§5).
 *  Independent of the licence's, so a settings edit no longer forces a licence re-download and
 *  a tier change no longer forces a settings refetch. */
export function fetchConfigDocument(
  ctx: CoreContext,
  token: string,
  etag?: string,
): Promise<DocumentResult> {
  return ctx.getDocument("config/document", token, etag);
}
