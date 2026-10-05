// A product backend that trusts only licences it can verify itself (SDK parity pass SP-N18).
// The desktop or CLI client sends its cached licence document and its device id with each call:
//
//   X-PKey-License: <the client's licence JWS>   (client.getSyncState().doc's source, see README)
//   X-PKey-Device:  <client.core.deviceId>
//
// The middleware verifies the signature against the product's pinned keys, the audience and the
// device binding, with no device state and no call to Polaris Key. A revoked device stops
// receiving fresh documents, so the middleware also bounds the document's age.

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { verifyLicenseDocument } from "@polaris-key/node/server";
import pkey from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

/** Refuse a document older than this (the product's sync interval plus slack). */
const MAX_AGE_SECONDS = 3 * 86400;

export function requireLicense(entitlement?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const jws = req.header("x-pkey-license");
    const deviceId = req.header("x-pkey-device");
    if (!jws || !deviceId)
      return res.status(401).json({ error: { code: "unauthorized" } });
    const v = await verifyLicenseDocument(jws, {
      trust: pkey.trust.pinnedKeys,
      product: pkey.productSlug,
      deviceId,
    });
    if (!v.ok || !v.usable || v.ageSeconds > MAX_AGE_SECONDS)
      return res.status(403).json({ error: { code: "license_required" } });
    if (entitlement && !v.isEntitled(entitlement))
      return res.status(403).json({ error: { code: "not_entitled" } });
    res.locals.license = v.doc;
    next();
  };
}

const app = express();
app.get("/api/export", requireLicense("export.pdf"), (_req, res) => {
  res.json({ ok: true, licensedTo: res.locals.license.profile?.email ?? null });
});
app.listen(3000, () => console.log("listening on http://localhost:3000"));
