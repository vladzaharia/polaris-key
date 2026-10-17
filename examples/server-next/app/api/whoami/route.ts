import { polaris } from "../../../lib/polaris";

export const GET = polaris.requireLicense(async (_req, { license, user }) =>
  Response.json({
    licenseId: license.id,
    tier: license.tier,
    ageSeconds: license.ageSeconds,
    signedIn: user !== null,
  }),
);
