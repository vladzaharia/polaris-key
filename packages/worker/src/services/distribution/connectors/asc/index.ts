/**
 * The App Store Connect connector (P5-02) as a `DistributionConnector`: the poller, the webhook
 * route and the controls. See `client.ts` (the API), `webhook.ts`, `map.ts` (the vocabulary),
 * `apply.ts` (read one object, write its state), `poll.ts` and `controls.ts`.
 */

import type { DistributionConnector } from "../index.js";
import { eventView, listEvents, listObjects, objectView } from "../state.js";
import { ASC_CONTROLS } from "./controls.js";
import { ASC_SETUP_CONTROLS, provisioningView } from "./provision.js";
import { pollAsc } from "./poll.js";
import { readRate } from "../../../../core/asc/budget.js";
import { platformPin } from "../../../../core/platformCredentials.js";
import {
  ASC_CONNECTOR,
  ASC_PLATFORM_CREDENTIAL,
  ASC_LABEL,
  ASC_OUTLET_KINDS,
  resolveAscSetup,
} from "./setup.js";
import { handleAscWebhook } from "./webhook.js";

/** P5-02's controls and A-17c's setup controls, one table. */
const CONTROLS = { ...ASC_CONTROLS, ...ASC_SETUP_CONTROLS };

export const ascConnector: DistributionConnector = {
  kind: ASC_CONNECTOR,
  label: ASC_LABEL,
  outletKinds: ASC_OUTLET_KINDS,
  poll: pollAsc,
  webhook: handleAscWebhook,
  controls: CONTROLS,
  async status({ env, db, product, now }) {
    const { setup, inert } = await resolveAscSetup(env, db, product);
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
            // The product's own key id, or null when it falls back to the platform team key
            // (A-16: `credentialSource` says which; `platformSource` whether console or secret).
            apiKeyCredential:
              setup.credential.source === "product"
                ? setup.credential.credentialId
                : null,
            credentialSource: setup.credential.source,
            platformSource:
              setup.credential.source === "platform"
                ? setup.credential.origin
                : null,
            webhookSecretCredential: setup.webhookSecretId,
          }
        : null,
      rate: setup ? await readRate(env, product, setup.credential, now) : null,
      objects: objects.map(objectView),
      unresolved: objects.filter((o) => o.release_id === null).length,
      events: (await listEvents(db, product, ASC_CONNECTOR)).map(eventView),
      controls: Object.keys(CONTROLS),
      // A-17c: the app-setup progress (the ledger's rows) and the portal checklist.
      // Before an Apple outlet is declared, the platform pin names the app (the New-app wizard).
      provisioning: await provisioningView(
        db,
        product,
        setup?.appleId ??
          (await platformPin(db, ASC_PLATFORM_CREDENTIAL, product)),
      ),
    };
  },
};
