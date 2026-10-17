import { polaris } from "../../../lib/polaris";

export const POST = polaris.requireSignIn(async (_req, { user }) =>
  Response.json({ owner: user!.subject }),
);
