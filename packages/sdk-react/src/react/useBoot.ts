// `useBoot` — the headless one-call boot (ui.boot, SDK-PARITY-PASS §3.4): `adapter.boot()` run
// from an effect (never during render, so a server render performs no network call), with the
// stage machine's live state for a boot screen. The UI shell renders `waiting` (its activation
// screen), `blocked`, `offline` and `error`; `ready` mounts the app.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootEmit,
  BootResult,
  BootRunOptions,
  BootState,
} from "../core/index.js";
import { useCtx } from "./hooks.js";

export interface UseBootOptions extends Omit<BootRunOptions, "onStage"> {
  /** Boot once on mount (default true). False: call `boot()` yourself. */
  auto?: boolean;
}

export interface UseBoot {
  /** The machine's state as the last transition left it, or null before the first. */
  state: BootState | null;
  /** Every emit so far, in order. */
  emits: readonly BootEmit[];
  /** The finished boot, once it stopped. */
  result: BootResult | null;
  /** True while a boot runs. */
  running: boolean;
  /** A boot that threw (a typed `UnsupportedError` on a host that predates bridge v4). */
  error: Error | null;
  /** Run a boot now (again after a `retry`-worthy stop). */
  boot: () => Promise<BootResult | null>;
}

export function useBoot(opts: UseBootOptions = {}): UseBoot {
  const { adapter } = useCtx();
  const { auto = true, ...run } = opts;
  const runRef = useRef(run);
  runRef.current = run;
  const [state, setState] = useState<BootState | null>(null);
  const [emits, setEmits] = useState<readonly BootEmit[]>([]);
  const [result, setResult] = useState<BootResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const boot = useCallback(async (): Promise<BootResult | null> => {
    setRunning(true);
    setError(null);
    setEmits([]);
    try {
      const r = await adapter.boot({
        ...runRef.current,
        onStage: (step) => {
          if (!alive.current) return;
          setState(step.state);
          setEmits((prev) => [...prev, ...step.emits]);
        },
      });
      if (alive.current) {
        setState(r.state);
        setResult(r);
      }
      return r;
    } catch (e) {
      if (alive.current) setError(e as Error);
      return null;
    } finally {
      if (alive.current) setRunning(false);
    }
  }, [adapter]);

  useEffect(() => {
    if (auto) void boot();
  }, [auto, boot]);

  return { state, emits, result, running, error, boot };
}
