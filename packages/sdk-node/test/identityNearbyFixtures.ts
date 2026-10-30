// Shared fixtures for the nearby identity tests (I-47.6, I-47.7): a client wired to a fake Worker
// that serves the nearby routes' discovery, with the fixture device keys of a label.

import {
  identityDiscovery,
  json,
  seededClient,
  signedLicense,
} from "./parityFixtures.js";
import type { Handler } from "./parityFixtures.js";
import { fixtureKeys } from "../../../conformance/runners/node/nearbyActions.js";

export const REQ = "nr_pA71hdu4pwET01lPlZ_Pow";
export const BASE = "https://k.test/djdl/identity";
export const FRAGMENT = {
  nearby: true,
  endpoints: {
    nearbyStart: `${BASE}/nearby/start`,
    nearbyApprove: `${BASE}/nearby/approve`,
    nearbyPoll: `${BASE}/nearby/poll`,
    signout: `${BASE}/signout`,
  },
};

/** A client with the nearby Worker routes and a fixture key store; `routes` adds or overrides. */
export async function nearbyClient(
  routes: Record<string, Handler> = {},
  o: { token?: string | null; keys?: string } = {},
) {
  const r = await seededClient({
    token: o.token ?? null,
    // The licence half of autoSignIn()'s rung 1 (the acquisition sync after a sign-in is stubbed).
    license: await signedLicense({}),
    extra: {
      expectedServices: ["license", "config", "identity"] as never,
      deviceName: "",
      keyring: { deviceKeys: fixtureKeys(o.keys ?? "session-d") as never },
    },
    routes: {
      "GET /djdl/.well-known/polaris.json": identityDiscovery(FRAGMENT),
      "POST /djdl/identity/nearby/start": () =>
        json({ request: REQ, expiresIn: 300, interval: 3 }, 201),
      ...routes,
    },
  });
  // The acquisition sync after a sign-in is pinned by the sync transcripts, not here.
  (
    r.client.identity as unknown as { onAcquired: () => Promise<void> }
  ).onAcquired = async () => undefined;
  return r;
}
