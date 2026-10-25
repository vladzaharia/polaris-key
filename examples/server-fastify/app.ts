// A gated Fastify app: one open route, one entitlement, one tier gate, one sign-in, and a /whoami
// probe. Works on Fastify 4 and 5.

import Fastify from "fastify";
import {
  getPolarisAuth,
  getPolarisLicense,
  polarisKey,
  requireEntitlement,
  requireLicense,
  requireSignIn,
  requireTier,
  type PolarisKeyFastifyOptions,
} from "@polaris-key/server/fastify";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

export function createApp(
  options: PolarisKeyFastifyOptions = { config: polarisConfig },
) {
  const app = Fastify();
  void app.register(polarisKey, options);

  app.get("/health", () => ({ ok: true }));

  app.get(
    "/api/export",
    { preHandler: requireEntitlement("export.pdf") },
    (req) => ({ tier: getPolarisLicense(req).tier }),
  );

  app.get(
    "/api/team",
    { preHandler: requireTier("pro", "team") },
    () => "team",
  );

  app.post("/api/saves", { preHandler: requireSignIn() }, (req) => ({
    owner: getPolarisAuth(req).user!.subject, // "ps_…", stable per product
  }));

  app.get("/whoami", { preHandler: requireLicense() }, (req) => {
    const license = getPolarisLicense(req);
    return {
      licenseId: license.id,
      tier: license.tier,
      ageSeconds: license.ageSeconds,
      signedIn: getPolarisAuth(req).user !== null,
    };
  });
  return app;
}
