"use client";
// CloudSyncStatus's signed-out row for the drop-in. A Cloud Sync call that the Worker refused with
// `account_required` (or `unauthorized`) leaves the machine `blocked`, across a relaunch, and emits
// `signedOut` and `signInOffered`. With no `input.cloudSync` from the host, inside the provider,
// the strip follows that: it reads "Sync stopped." and offers Sign in to sync, in a neutral tone.
// The host's own `input.cloudSync` stands, as for the transfer states. Nothing but the state
// passes through here.

import { useContext, useEffect, useState } from "react";
import type { UiInput } from "@polaris-key/ui-core";

import { PolarisContext } from "../react/context.js";

/** Whether the machine reads blocked for want of a signed-in account. */
function stopped(status: { state: string; reason?: string }): boolean {
  return (
    status.state === "blocked" &&
    (status.reason === "account_required" || status.reason === "unauthorized")
  );
}

/** The host's input, or with none for the Cloud Sync row, the SDK's signed-out state. */
export function useSyncStoppedInput(
  input: UiInput | undefined,
): UiInput | undefined {
  const found = useContext(PolarisContext)?.adapter.cloudSync;
  // An adapter without the machine's status (a transport with no Cloud Sync) has no row to draw.
  const client = typeof found?.status === "function" ? found : undefined;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!client || client.unsupported) return;
    const redraw = (): void => bump((n) => n + 1);
    const offStatus = client.onStatus(redraw);
    const offEvents = client.onEvents((events) => {
      if (
        events.some((e) => e.type === "signedOut" || e.type === "signInOffered")
      )
        redraw();
    });
    // The machine may have restored its block before this strip mounted.
    redraw();
    return () => {
      offStatus();
      offEvents();
    };
  }, [client]);
  if (!client || client.unsupported || input?.cloudSync) return input;
  return stopped(client.status())
    ? { ...input, cloudSync: { state: "error", signedIn: false } }
    : input;
}
