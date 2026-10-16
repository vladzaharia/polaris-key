// A gated Hono app. It runs on Workers, Bun, Deno and Node: one open route, one entitlement, one
// sign-in, and a /whoami probe.

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  POLARIS_REQUEST_HEADERS,
  polarisKey,
  requireEntitlement,
  requireLicense,
  requireSignIn,
  type PolarisEnv,
  type PolarisServerConfig,
} from "@polaris-key/server/hono";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

export function createApp(
  config: PolarisServerConfig = polarisConfig,
  options: { now?: () => number; trustRefresh?: boolean } = {},
) {
  const app = new Hono<PolarisEnv>();
  // CORS is your policy: let a browser client send the Polaris Key headers.
  app.use(
    "/api/*",
    cors({
      origin: "https://app.example.com",
      allowHeaders: [...POLARIS_REQUEST_HEADERS, "Content-Type"],
    }),
  );
  app.use("/*", polarisKey({ config, ...options }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/export", requireEntitlement("export.pdf"), (c) =>
    c.json({ tier: c.var.polaris.license!.tier }),
  );

  app.post("/api/saves", requireSignIn(), (c) =>
    c.json({ owner: c.var.polaris.user!.subject }),
  );

  app.get("/whoami", requireLicense(), (c) => {
    const { license, user } = c.var.polaris;
    return c.json({
      licenseId: license!.id,
      tier: license!.tier,
      ageSeconds: license!.ageSeconds,
      signedIn: user !== null,
    });
  });
  return app;
}
