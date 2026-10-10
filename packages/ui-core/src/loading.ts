// DL7's delayed loading state, as a model timer (docs/design/UI-KITS.md, design language v2):
// "Loading shows nothing for the first 250–300 ms, then the identity, a muted label and the 2 px
// shimmer." The delay is part of the model, not of a renderer, so every kit flips at the same
// moment and a fast answer never flashes a loading screen. Reduced motion holds the shimmer still
// but keeps the delay: the setting changes motion, not timing.
//
// ui-matrix.json pins the window (`vocabulary.loadingDelayMs`) with rows on both sides of it: a
// loading state is empty below `min` and shows its copy from `max`. This core waits `min`.

/** The window every kit's delay falls in (DL7). */
export const LOADING_DELAY_WINDOW = { min: 250, max: 300 } as const;

/** This core's delay: the window's start. */
export const LOADING_DELAY_MS = LOADING_DELAY_WINDOW.min;

/** The states the delay applies to (`Component.state`; ui-matrix.json `vocabulary.loadingDelay`):
 *  every must component's loading state, and the gate's license check, which never flashes. */
export const DELAYED_LOADING_STATES: readonly string[] = [
  "PolarisKeyGate.booting",
  "LicenseChoice.loading",
  "Devices.loading",
  "ReleaseNotes.loading",
  "AccountAndLicense.loading",
  "Settings.loading",
  "Paywall.loading",
  "EntitlementGate.loading",
];

/** True once a loading state shows its content; `elapsedMs` absent means the delay has passed. */
export function loadingVisible(
  elapsedMs: number | undefined,
  delayMs: number = LOADING_DELAY_MS,
): boolean {
  return elapsedMs === undefined || elapsedMs >= delayMs;
}

/** A host's timer: run `fn` after `ms`, and return how to cancel it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** `setTimeout` from whatever global the runtime has (a browser, Node, a worker, Electron). */
export const defaultSchedule: Schedule = (fn, ms) => {
  const g = globalThis as unknown as {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
  };
  const id = g.setTimeout(fn, ms);
  return () => g.clearTimeout(id);
};

/** The clock a loading timer reads: milliseconds, any origin. */
export type Now = () => number;

const defaultNow: Now = () => Date.now();

/**
 * One request's loading delay. `elapsed()` is the `elapsedMs` input of the loading view, and
 * `onVisible` fires once, when the view should start showing its content. `stop()` when the
 * answer arrives; it never fires after that.
 */
export interface LoadingTimer {
  elapsed(): number;
  readonly visible: boolean;
  stop(): void;
}

export function startLoadingTimer(
  onVisible: () => void,
  options: { schedule?: Schedule; now?: Now; delayMs?: number } = {},
): LoadingTimer {
  const now = options.now ?? defaultNow;
  const delay = options.delayMs ?? LOADING_DELAY_MS;
  if (delay < LOADING_DELAY_WINDOW.min || delay > LOADING_DELAY_WINDOW.max)
    throw new RangeError(
      `ui-core: the loading delay is ${LOADING_DELAY_WINDOW.min}-${LOADING_DELAY_WINDOW.max} ms (DL7), not ${delay}`,
    );
  const started = now();
  let visible = false;
  let stopped = false;
  const cancel = (options.schedule ?? defaultSchedule)(() => {
    if (stopped) return;
    visible = true;
    onVisible();
  }, delay);
  return {
    // Held on the timer's side of the threshold, so a view built from it never shows before the
    // timer fires (or hides after).
    elapsed: () =>
      visible
        ? Math.max(delay, now() - started)
        : Math.min(delay - 1, now() - started),
    get visible() {
      return visible;
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
