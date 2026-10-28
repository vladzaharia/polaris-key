// Cloud Connect over the relay as a hook (connect.app, CC-09.2): `useCloudConnect()` follows the
// relay's state and the devices online, and hands back the verbs. A browser has no LAN; the relay
// is its only path. Nothing here starts on its own: the app calls `start()`, and `stop()` when it
// is done (a sign-out stops it too). The relay code loads on the first `start()`.

import { useEffect, useMemo, useReducer } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type {
  CloudConnectClient,
  CloudConnectStatus,
  CloudPeer,
} from "../browser/connect/index.js";
import { useCtx } from "./hooks.js";

export interface UseCloudConnect {
  /** Why Connect is unavailable here (a cookie page, the desktop renderer), or null. */
  unsupported: Unsupported | null;
  status: CloudConnectStatus;
  /** The person's other devices online in the relay room now. */
  peers: CloudPeer[];
  start: CloudConnectClient["start"];
  stop: CloudConnectClient["stop"];
  devices: CloudConnectClient["devices"];
  open: CloudConnectClient["open"];
  refreshPeers: CloudConnectClient["refreshPeers"];
  onChannel: CloudConnectClient["onChannel"];
  onNotice: CloudConnectClient["onNotice"];
}

/** The adapter's Cloud Connect, re-rendering when the relay state or the online devices change. */
export function useCloudConnect(): UseCloudConnect {
  const { adapter } = useCtx();
  const cc = adapter.cloudConnect;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => cc.onChange(bump), [cc]);
  const verbs = useMemo(
    () => ({
      start: cc.start,
      stop: cc.stop,
      devices: cc.devices,
      open: cc.open,
      refreshPeers: cc.refreshPeers,
      onChannel: cc.onChannel,
      onNotice: cc.onNotice,
    }),
    [cc],
  );
  return {
    unsupported: cc.unsupported,
    status: cc.status(),
    peers: cc.peers(),
    ...verbs,
  };
}
