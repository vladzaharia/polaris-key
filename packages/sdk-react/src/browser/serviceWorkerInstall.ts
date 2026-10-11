// The install half of the page's update driver (see serviceWorkerUpdate.ts for the design).
// It is its own module so the browser adapter loads it with a dynamic `import()` the first time
// a page installs an update: most page loads never do, and the initial bundle stays small.

import { PolarisError } from "../core/types.js";
import { UpdateEvent } from "../constants.generated.js";
import {
  notInstallable,
  unsupportedOutcome,
  type InstallOptions,
  type InstallOutcome,
} from "../core/install.js";
import type { UpdateEventInput } from "../core/updateEvents.js";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import {
  SKIP_WAITING_MESSAGE,
  pageServiceWorker,
} from "./serviceWorkerUpdate.js";
import type {
  SwContainer,
  SwRegistration,
  SwWorker,
} from "./serviceWorkerUpdate.js";

export interface ServiceWorkerInstallDeps {
  /** `undefined` uses this page's `navigator.serviceWorker`; `null` disables it. */
  container?: SwContainer | null;
  /** Reload the page so it runs the new build. Default `window.location.reload()`. */
  reload?: () => void;
  /** Journal an update-health event; a failure is the journal's, never the install's. */
  record?: (event: UpdateEvent, input: UpdateEventInput) => Promise<unknown>;
  /** The running build's version, for `fromRelease`. */
  currentVersion?: string | null;
  /**
   * Send the page's update-health journal (best effort: `adapter.report()` where the page holds
   * one), awaited right before the reload so the events recorded for this install are not lost
   * with the page. A failure is the journal's, never the install's.
   */
  flush?: () => Promise<unknown>;
}

const defaultReload = (): void => {
  if (typeof window !== "undefined") window.location.reload();
};

// `Promise.withResolvers` is ES2024: this package's lib is ES2023 and it runs in browsers that
// predate it, so the two waits below use the executor form.

/** Resolve once `worker` reaches a state `settled` accepts, or when `signal` aborts (rejecting
 *  with its reason). Resolves at once when it already has. */
function untilState(
  worker: SwWorker,
  settled: (state: string) => boolean,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      worker.removeEventListener("statechange", check);
      signal?.removeEventListener("abort", abort);
    };
    const check = (): void => {
      if (!settled(worker.state)) return;
      done();
      resolve(worker.state);
    };
    const abort = (): void => {
      done();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort);
    worker.addEventListener("statechange", check);
    check();
  });
}

/** The registration's waiting worker, waiting for an installing one to finish; null when
 *  there is none (or the installing one failed). */
async function findWaiting(
  reg: SwRegistration,
  signal: AbortSignal | undefined,
): Promise<SwWorker | null> {
  if (reg.waiting) return reg.waiting;
  const installing = reg.installing;
  if (!installing) return null;
  const state = await untilState(
    installing,
    (s) => s === "installed" || s === "activated" || s === "redundant",
    signal,
  );
  return state === "installed" ? (reg.waiting ?? installing) : null;
}

/** What became of the hand-off: the new worker took control, was discarded, or did neither in
 *  time. */
type HandOff = "took" | "redundant" | "timeout";

/**
 * How long the page waits for the worker it asked to skip waiting to take control: the 15 s every
 * bearer request gets (`REQUEST_TIMEOUT_MS`). A worker that never answers `SKIP_WAITING` would
 * otherwise leave the install pending until the caller aborts it.
 */
export const HAND_OFF_TIMEOUT_MS = 15_000;

/** Why an install that was not handed off says so. */
const NOT_TAKEN: Record<Exclude<HandOff, "took">, string> = {
  redundant: "the waiting service worker became redundant before it took over.",
  timeout: `the waiting service worker did not take control within ${HAND_OFF_TIMEOUT_MS / 1000} seconds: it must answer { type: "SKIP_WAITING" } with self.skipWaiting().`,
};

/** Ask `waiting` to skip waiting and say what came of it: `took` once it controls the page (its
 *  own `activated`, or the container's `controllerchange`), `redundant` when it was discarded,
 *  `timeout` when it did neither within `HAND_OFF_TIMEOUT_MS`. */
function activate(
  waiting: SwWorker,
  container: SwContainer,
  signal: AbortSignal | undefined,
): Promise<HandOff> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(deadline);
      waiting.removeEventListener("statechange", check);
      container.removeEventListener("controllerchange", took);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (result: HandOff): void => {
      cleanup();
      resolve(result);
    };
    const check = (): void => {
      if (waiting.state === "activated") finish("took");
      else if (waiting.state === "redundant") finish("redundant");
    };
    const took = (): void => finish("took");
    const abort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    const deadline = setTimeout(() => finish("timeout"), HAND_OFF_TIMEOUT_MS);
    signal?.addEventListener("abort", abort);
    waiting.addEventListener("statechange", check);
    container.addEventListener("controllerchange", took);
    check();
    if (waiting.state !== "activated" && waiting.state !== "redundant")
      waiting.postMessage(SKIP_WAITING_MESSAGE);
  });
}

/**
 * Install a decision the way a page can (see the file header). Rejects only with the signal's
 * reason.
 */
export async function installViaServiceWorker(
  deps: ServiceWorkerInstallDeps,
  decision: UpdateDecision,
  opts: InstallOptions = {},
): Promise<InstallOutcome> {
  if (decision.action === "binary" || decision.action === "store")
    return unsupportedOutcome(
      "runtime",
      decision.action === "binary"
        ? "a page cannot install a binary build: it updates through its service worker."
        : "a page has no store listing to open: it updates through its service worker.",
    );
  if (decision.action !== "platform") return notInstallable(decision);
  const { signal } = opts;
  signal?.throwIfAborted();
  const container =
    deps.container === undefined ? pageServiceWorker() : deps.container;
  if (!container)
    return unsupportedOutcome(
      "runtime",
      "this page has no service worker support (an insecure origin or a server render).",
    );
  let reg: SwRegistration | undefined;
  try {
    reg = await container.getRegistration();
  } catch {
    reg = undefined;
  }
  if (!reg)
    return unsupportedOutcome(
      "dependency",
      "this page has no service worker registered: it updates when it is reloaded.",
    );
  const waiting = await findWaiting(reg, signal);
  if (!waiting)
    return unsupportedOutcome(
      "dependency",
      "no service worker is waiting: the new build has not finished installing.",
    );
  const version = decision.release.version;
  const input: UpdateEventInput = {
    release: version,
    ...(deps.currentVersion ? { fromRelease: deps.currentVersion } : {}),
  };
  const emit = async (event: UpdateEvent): Promise<void> => {
    try {
      await deps.record?.(event, input);
    } catch {
      // A page holds no journal in every mode; an install never fails for it.
    }
  };
  const flush = async (): Promise<void> => {
    try {
      await deps.flush?.();
    } catch {
      // Best effort: a journal that cannot be sent never fails the install either.
    }
  };
  await emit(UpdateEvent.updateDownloaded);
  // Anything but `took` means nothing was handed off.
  const handOff = async (): Promise<HandOff> => {
    const result = await activate(waiting, container, signal);
    if (result !== "took") return result;
    await emit(UpdateEvent.updateApplied);
    // The reload takes the page, and the journal that only lives in it, away.
    await flush();
    (deps.reload ?? defaultReload)();
    return result;
  };
  if (opts.reload === false)
    return {
      kind: "restartRequired",
      version,
      restart: async () => {
        const result = await handOff();
        if (result !== "took")
          throw new PolarisError("unknown", NOT_TAKEN[result]);
      },
    };
  const result = await handOff();
  if (result !== "took")
    return unsupportedOutcome("dependency", NOT_TAKEN[result]);
  return {
    kind: "handedOff",
    version,
    detail: "the new service worker took control and the page is reloading.",
  };
}
