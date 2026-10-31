/**
 * Silent restore's device-lifecycle listener (I-49.4; `core/devices/lifecycle.ts`). It runs for
 * every product whatever the launch gate, the `identity.restore` setting or the Identity toggle
 * say, because a revocation must reach a row written while the feature was on.
 *
 *   unbound  the device signed out or was cleared: its own row and origin mark go.
 *   removed  the device is gone: its own row goes, and when it had signed in by restore, so does
 *            every restore row of its subject.
 *   bound    a row the device enrolled under another subject goes.
 *   keys     nothing: the proof binds the key at redeem, not at rest.
 *
 * A listener is bookkeeping: it cannot refuse the write, and one that throws is ignored.
 */

import type { DeviceChangeListener } from "../../../core/devices/lifecycle.js";
import {
  dropRowsOfOtherSubject,
  revokeDeviceRestore,
  revokeRemovedDevice,
} from "./store.js";

export const IDENTITY_RESTORE_LISTENER = "identity.restore";

export const restoreDeviceListener: DeviceChangeListener = async (
  { db },
  event,
) => {
  switch (event.kind) {
    case "unbound":
      await revokeDeviceRestore(db, event.product, event.deviceId);
      return;
    case "removed":
      await revokeRemovedDevice(db, event.product, event.deviceId);
      return;
    case "bound":
      if (event.subject)
        await dropRowsOfOtherSubject(
          db,
          event.product,
          event.deviceId,
          event.subject,
        );
      return;
    case "keys":
      return;
  }
};
