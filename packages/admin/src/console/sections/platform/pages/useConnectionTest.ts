/**
 * The test sign-in's browser side (I-31). The provider opens in a pop-up and the result reaches
 * only this tab: the pop-up comes back to the wizard, finds this tab on a BroadcastChannel keyed by
 * the draft id and closes; this tab then fetches the result once. A closed pop-up (nothing came
 * back) or a long silence ends the attempt, so the step is never left spinning.
 */

import * as React from "react";
import {
  api,
  type ClaimMapDto,
  type ConnectionTestResult,
} from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { CHANNEL } from "./platformConnectionParts.js";
import { PopupBlockedError, PopupClosedError } from "./connectionErrors.js";

const GIVE_UP_MS = 5 * 60 * 1000;

interface Input {
  draftId: string;
  issuer: string;
  clientId: string;
  secret: string;
  claimMap: ClaimMapDto;
  /** Test a saved connection with its stored secret. */
  connectionId?: string;
  /** The return trip: this page was opened with `?state=` on the test step. */
  returned: string;
  onTestStep: boolean;
}

export function useConnectionTest(i: Input): {
  test: ConnectionTestResult | null;
  testing: boolean;
  error: unknown;
  run: (mode: "popup" | "tab") => Promise<void>;
  reset: () => void;
} {
  const [test, setTest] = React.useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const pending = React.useRef<string | null>(null);
  const watch = React.useRef<number | null>(null);
  const { draftId } = i;

  const stopWatching = (): void => {
    if (watch.current !== null) window.clearInterval(watch.current);
    watch.current = null;
  };
  React.useEffect(() => stopWatching, []);

  const fetchResult = React.useCallback(
    async (state: string): Promise<void> => {
      stopWatching();
      try {
        const res = await api.connectionTestResult(state, draftId);
        setTest(res.result);
        setError(null);
      } catch (e) {
        setError(e);
      } finally {
        setTesting(false);
      }
    },
    [draftId],
  );

  React.useEffect(() => {
    if (!draftId || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string; draftId?: string; state?: string };
      if (
        m?.type === "back" &&
        m.draftId === draftId &&
        m.state &&
        m.state === pending.current
      ) {
        ch.postMessage({ type: "ack", draftId, state: m.state });
        pending.current = null;
        void fetchResult(m.state);
      }
    };
    return () => ch.close();
  }, [draftId, fetchResult]);

  // This page is the pop-up (an opener answers) or the same-tab return (none does).
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (!draftId || !i.returned || !i.onTestStep || handled.current) return;
    handled.current = true;
    const state = i.returned;
    const finish = (): void => void fetchResult(state);
    if (typeof BroadcastChannel === "undefined") return finish();
    const ch = new BroadcastChannel(CHANNEL);
    let acked = false;
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string; draftId?: string; state?: string };
      if (m?.type === "ack" && m.draftId === draftId && m.state === state) {
        acked = true;
        window.close();
      }
    };
    ch.postMessage({ type: "back", draftId, state });
    const t = window.setTimeout(() => {
      ch.close();
      if (!acked) finish();
    }, 700);
    return () => window.clearTimeout(t);
  }, [draftId, i.returned, i.onTestStep, fetchResult]);

  const run = async (mode: "popup" | "tab"): Promise<void> => {
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      const res = await mutate(
        "startConnectionTest",
        i.connectionId
          ? { draftId, connectionId: i.connectionId }
          : {
              draftId,
              issuer: i.issuer.trim(),
              clientId: i.clientId.trim(),
              ...(i.secret ? { clientSecret: i.secret } : {}),
              claimMap: i.claimMap,
            },
      );
      if (mode === "tab") {
        window.location.assign(res.url);
        return;
      }
      pending.current = res.state;
      const win = window.open(res.url, CHANNEL, "popup,width=520,height=720");
      if (!win) {
        pending.current = null;
        setTesting(false);
        setError(new PopupBlockedError());
        return;
      }
      const started = Date.now();
      stopWatching();
      watch.current = window.setInterval(() => {
        // Nothing came back and the window is gone, or the attempt is long over.
        if (
          pending.current === res.state &&
          (win.closed || Date.now() - started > GIVE_UP_MS)
        ) {
          pending.current = null;
          stopWatching();
          setTesting(false);
          setError(new PopupClosedError());
        }
      }, 500);
    } catch (e) {
      setTesting(false);
      setError(e);
    }
  };

  return {
    test,
    testing,
    error,
    run,
    reset: () => {
      setTest(null);
      setError(null);
    },
  };
}
