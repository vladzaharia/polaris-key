// A gated Express app: one open route, one entitlement, one sign-in, and a /whoami probe.
//
// The client sends its licence in X-PKey-License; polarisKey() decides it offline against the
// pinned keys and the signed trust manifest. Authorization stays yours.

import express from "express";
import {
  getPolarisAuth,
  polarisKey,
  requireEntitlement,
  requireLicense,
  requireSignIn,
  type PolarisServerConfig,
} from "@polaris-key/server/express";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

export function createApp(
  config: PolarisServerConfig = polarisConfig,
  options: { now?: () => number; trustRefresh?: boolean } = {},
) {
  const app = express();
  app.use(polarisKey({ config, ...options }));

  app.get("/health", (_req, res) => void res.json({ ok: true }));

  app.get("/api/export", requireEntitlement("export.pdf"), (req, res) => {
    res.json({ tier: getPolarisAuth(req).license!.tier });
  });

  app.post("/api/saves", requireSignIn(), (req, res) => {
    res.json({ owner: getPolarisAuth(req).user!.subject }); // "ps_…", stable per product
  });

  app.get("/whoami", requireLicense(), (req, res) => {
    const { license, user } = getPolarisAuth(req);
    res.json({
      licenseId: license!.id,
      tier: license!.tier,
      ageSeconds: license!.ageSeconds,
      signedIn: user !== null,
    });
  });
  return app;
}
