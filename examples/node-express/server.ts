// A product backend that trusts only licences it can verify itself. The desktop or CLI client
// sends its cached licence document with each call:
//
//   X-PKey-License: <the client's licence JWS>
//   X-PKey-Device:  <client.core.deviceId>        (optional)
//
// polarisKey() verifies the signature against the product's pinned keys and the signed trust
// manifest, the audience and the freshness window, with no device state. A revoked device stops
// receiving fresh documents, so the window (an hour by default; maxAgeSeconds tightens it) bounds
// how long a revocation takes to reach this backend.

import express from "express";
import {
  getPolarisAuth,
  polarisKey,
  requireEntitlement,
} from "@polaris-key/server/express";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

const app = express();
app.use(polarisKey({ config: polarisConfig }));
app.get("/api/export", requireEntitlement("export.pdf"), (req, res) => {
  res.json({ ok: true, tier: getPolarisAuth(req).license!.tier });
});
app.listen(3000, () => console.log("listening on http://localhost:3000"));
