/**
 * The Microsoft Store connector (P5-04) as a `DistributionConnector`: the poller only. It READS
 * — no webhook (the Store sends none), no controls: publishing, metadata edits and rollout changes
 * (increase, halt, finalise) are CI's, through `msstore` or the GitHub Action. See `token.ts` (the
 * Entra token), `client.ts` (the GET-only API client), `map.ts` (the vocabulary) and `poll.ts`.
 */

import type { DistributionConnector } from "../index.js";
import { listObjects, objectView } from "../state.js";
import {
  APPLICATION_OBJECT,
  FLIGHT_OBJECT,
  pollMsStore,
  SUBMISSION_OBJECT,
} from "./poll.js";
import {
  MSSTORE_CONNECTOR,
  MSSTORE_LABEL,
  MSSTORE_OUTLET_KINDS,
  resolveMsStoreSetup,
} from "./setup.js";

export const msStoreConnector: DistributionConnector = {
  kind: MSSTORE_CONNECTOR,
  label: MSSTORE_LABEL,
  outletKinds: MSSTORE_OUTLET_KINDS,
  poll: pollMsStore,
  controls: {},
  async status({ env, db, product }) {
    const { setup, inert } = await resolveMsStoreSetup(env, db, product);
    const objects = await listObjects(db, product, MSSTORE_CONNECTOR, {
      types: [APPLICATION_OBJECT, FLIGHT_OBJECT, SUBMISSION_OBJECT],
    });
    const live = objects.filter((o) => o.terminal === 0);
    const flights = live.filter((o) => o.object_type === FLIGHT_OBJECT);
    const app = live.find((o) => o.object_type === APPLICATION_OBJECT);
    const listedRefs = new Set(
      flights.flatMap((f) => {
        const v = objectView(f);
        return [
          f.object_id.toLowerCase(),
          typeof v.detail.friendlyName === "string"
            ? v.detail.friendlyName
            : "",
        ];
      }),
    );
    return {
      configured: setup !== null,
      inert,
      // Ids and outlet bindings only — never a credential value or its metadata.
      setup: setup
        ? {
            productId: setup.productId,
            outlets: setup.outlets,
            credential: setup.credentialId,
            // Flights the manifest maps that Partner Center's last list did not name.
            missingFlights: [...setup.flightRefs.keys()].filter(
              (ref) =>
                !listedRefs.has(ref) && !listedRefs.has(ref.toLowerCase()),
            ),
          }
        : null,
      readable: app ? app.store_state !== "not-readable" : null,
      application: app ? objectView(app) : null,
      flights: flights.map(objectView),
      // A flight Partner Center lists that no outlet maps is shown, never written.
      unmapped: flights
        .filter((f) => f.outlet_id === null)
        .map((f) => f.object_id),
      submissions: live
        .filter((o) => o.object_type === SUBMISSION_OBJECT)
        .map(objectView),
      unresolved: live.filter(
        (o) => o.object_type === SUBMISSION_OBJECT && o.release_id === null,
      ).length,
      controls: [],
      notes: [
        "Read-only: publishing, metadata edits and rollout changes go through CI (msstore or the GitHub Action).",
        "A gradual rollout applies to MSIX packages only and never rolls installed users back when halted; the mirrored rollout is information, not an access control.",
        "The submission API answers 409 for an app that uses mandatory app updates or Store-managed consumable add-ons; such an app shows as not readable.",
      ],
    };
  },
};
