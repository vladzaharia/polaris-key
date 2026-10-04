import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { portalKeys } from "./data.js";

/**
 * "Open it on this device and this page signs you in by itself" (PORTAL.md §4.4) is true by
 * construction: while the sent screen shows, the session is re-checked on focus and
 * visibilitychange, every 5 s for 10 minutes while the tab is visible, and whenever another tab
 * of this site announces a sign-in on the `pk-portal-session` channel.
 */
export const SESSION_CHANNEL = "pk-portal-session";
const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;

export function useSessionRecheck(enabled: boolean): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!enabled) return;
    const recheck = (): void => {
      void qc.invalidateQueries({ queryKey: portalKeys.me });
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisible);
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState === "visible") recheck();
    }, POLL_MS);
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.onmessage = (e: MessageEvent) => {
        if ((e.data as { type?: string } | null)?.type === "signed-in")
          recheck();
      };
    }
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      channel?.close();
    };
  }, [enabled, qc]);
}

/** A signed-in tab tells the others (the one waiting on the sent screen). */
export function announceSignedIn(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type: "signed-in" });
  channel.close();
}
