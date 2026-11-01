// `PKEY_E2E_NEARBY`: the real client against a Worker stand-in on loopback, for the nearby sign-in
// e2e (packages/sdk-node/test/electron-e2e/nearby.e2e.ts). The value is JSON:
// {baseUrl, productSlug, kid, pub}. Never set in a shipped app.
import { app } from "electron";
import { join } from "node:path";
import { InMemoryStore, PolarisKeyClient } from "@polaris-key/node";

export interface NearbyE2e {
  baseUrl: string;
  productSlug: string;
  kid: string;
  pub: string;
}

export async function createNearbyE2eClient(
  c: NearbyE2e,
): Promise<PolarisKeyClient> {
  const client = await PolarisKeyClient.create({
    productSlug: c.productSlug,
    baseUrl: c.baseUrl,
    version: "1.0.0",
    trust: { pinnedKeys: { [c.kid]: c.pub } },
    trustRefresh: false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    store: new InMemoryStore(),
    stateDir: join(app.getPath("userData"), "state"),
  });
  // The window draws what the product offers: read the capabilities before it opens.
  await client.discover();
  return client;
}
