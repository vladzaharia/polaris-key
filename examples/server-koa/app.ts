// A gated Koa app: one open route, one entitlement, one tier gate, one sign-in, and a /whoami
// probe. Works on Koa 2 and 3.

import Koa from "koa";
import Router from "@koa/router";
import {
  getPolarisAuth,
  getPolarisLicense,
  polarisKey,
  requireEntitlement,
  requireLicense,
  requireSignIn,
  requireTier,
  type PolarisKeyKoaOptions,
} from "@polaris-key/server/koa";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

export function createApp(
  options: PolarisKeyKoaOptions = { config: polarisConfig },
) {
  const app = new Koa();
  const router = new Router();

  router.get("/health", (ctx) => {
    ctx.body = { ok: true };
  });

  router.get("/api/export", requireEntitlement("export.pdf"), (ctx) => {
    ctx.body = { tier: getPolarisLicense(ctx).tier };
  });

  router.get("/api/team", requireTier("pro", "team"), (ctx) => {
    ctx.body = "team";
  });

  router.post("/api/saves", requireSignIn(), (ctx) => {
    ctx.body = { owner: getPolarisAuth(ctx).user!.subject }; // "ps_…", stable per product
  });

  router.get("/whoami", requireLicense(), (ctx) => {
    const license = getPolarisLicense(ctx);
    ctx.body = {
      licenseId: license.id,
      tier: license.tier,
      ageSeconds: license.ageSeconds,
      signedIn: getPolarisAuth(ctx).user !== null,
    };
  });

  app.use(polarisKey(options)); // before the router
  app.use(router.routes());
  return app;
}
