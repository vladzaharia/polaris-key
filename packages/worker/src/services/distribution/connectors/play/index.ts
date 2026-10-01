/**
 * The Google Play connector (P5-03) as a `DistributionConnector`: the poller and the controls; no
 * webhook (Play sends none for releases or reviews — notes/E2 §A1 "RTDN" — and its purchase
 * notifications are P6-01's). See `client.ts` (the APIs), `map.ts` (the vocabulary), `poll.ts`,
 * `controls.ts`, `vitals.ts` and `policy.ts` (the operator's settings).
 */

import type { DistributionConnector } from "../index.js";
import { listObjects, objectView } from "../state.js";
import { PLAY_CONTROLS } from "./controls.js";
import { readPlaySettings } from "./policy.js";
import { pollPlay, TRACK_OBJECT } from "./poll.js";
import {
  PLAY_CONNECTOR,
  PLAY_LABEL,
  PLAY_OUTLET_KINDS,
  resolvePlaySetup,
} from "./setup.js";
import { VITALS_READING_OBJECT, VITALS_TRIP_OBJECT } from "./vitals.js";

export const playConnector: DistributionConnector = {
  kind: PLAY_CONNECTOR,
  label: PLAY_LABEL,
  outletKinds: PLAY_OUTLET_KINDS,
  poll: pollPlay,
  controls: PLAY_CONTROLS,
  async status({ db, product }) {
    const { setup, inert } = await resolvePlaySetup(db, product);
    const settings = await readPlaySettings(db, product);
    const tracks = await listObjects(db, product, PLAY_CONNECTOR, {
      types: [TRACK_OBJECT],
    });
    const listed = new Set(
      tracks.filter((t) => t.terminal === 0).map((t) => t.object_id),
    );
    const vitals = await listObjects(db, product, PLAY_CONNECTOR, {
      types: [VITALS_READING_OBJECT, VITALS_TRIP_OBJECT],
    });
    return {
      configured: setup !== null,
      // Why it does not run (the pin reasons are the operator's to fix): the manifest's package,
      // the chosen credential's id and the package it is pinned to — never a credential value.
      inert,
      // Ids and outlet bindings only — never a credential value or its metadata.
      setup: setup
        ? {
            packageName: setup.packageName,
            outlets: setup.outlets,
            credential: setup.credentialId,
            // Tracks the manifest maps that Play's last read did not list (a typo, or a track
            // the app does not have yet).
            missingTracks: [...setup.routes.keys()].filter(
              (t) => !listed.has(t),
            ),
          }
        : null,
      settings,
      tracks: tracks.map(objectView),
      // A track Play lists that no outlet maps is shown, never written.
      unmapped: tracks
        .filter((t) => t.terminal === 0 && t.outlet_id === null)
        .map((t) => t.object_id),
      unresolved: tracks.filter(
        (t) =>
          t.terminal === 0 && t.outlet_id !== null && t.release_id === null,
      ).length,
      vitals: vitals.map(objectView),
      controls: Object.keys(PLAY_CONTROLS),
      notes: [
        "inAppUpdatePriority cannot change after a release starts rolling out: set it on a draft, or let rollout/fraction apply the policy when it starts the rollout.",
        "Halting a completed release rolls the track back to the previously completed release; rollout/halt asks for confirmRollback.",
      ],
    };
  },
};
