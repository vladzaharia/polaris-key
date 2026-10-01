/**
 * The App Store Connect connector (P5-02) as a `DistributionConnector`: the poller, the webhook
 * route and the controls. See `client.ts` (the API), `webhook.ts`, `map.ts` (the vocabulary),
 * `apply.ts` (read one object, write its state), `poll.ts` and `controls.ts`.
 */

import type { DistributionConnector } from "../index.js";
import { eventView, listEvents, listObjects, objectView } from "../state.js";
import { ASC_CONTROLS } from "./controls.js";
import { pollAsc } from "./poll.js";
import { readRate } from "./run.js";
import {
  ASC_CONNECTOR,
  ASC_LABEL,
  ASC_OUTLET_KINDS,
  resolveAscSetup,
} from "./setup.js";
import { handleAscWebhook } from "./webhook.js";

export const ascConnector: DistributionConnector = {
  kind: ASC_CONNECTOR,
  label: ASC_LABEL,
  outletKinds: ASC_OUTLET_KINDS,
  poll: pollAsc,
  webhook: handleAscWebhook,
  controls: ASC_CONTROLS,
  async status({ env, db, product, now }) {
    const { setup, inert } = await resolveAscSetup(db, product);
    const objects = await listObjects(db, product, ASC_CONNECTOR);
    return {
      configured: setup !== null,
      // Why it does not run (the pin reasons are the operator's to fix): the manifest's app, the
      // chosen key's id and the app it is pinned to — app ids, never a credential value.
      inert,
      // Ids and outlet bindings only — never a credential value or its metadata.
      setup: setup
        ? {
            appleId: setup.appleId,
            bundleId: setup.bundleId,
            appStoreOutlet: setup.appStoreOutlet,
            testflightOutlet: setup.testflightOutlet,
            apiKeyCredential: setup.apiKeyId,
            webhookSecretCredential: setup.webhookSecretId,
          }
        : null,
      rate: setup ? await readRate(env, product, setup.apiKeyId, now) : null,
      objects: objects.map(objectView),
      unresolved: objects.filter((o) => o.release_id === null).length,
      events: (await listEvents(db, product, ASC_CONNECTOR)).map(eventView),
      controls: Object.keys(ASC_CONTROLS),
    };
  },
};
