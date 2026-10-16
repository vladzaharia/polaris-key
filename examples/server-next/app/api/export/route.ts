import { polaris } from "../../../lib/polaris";

export const GET = polaris.requireEntitlement(
  "export.pdf",
  async (_req, { license }) => Response.json({ tier: license.tier }),
);
