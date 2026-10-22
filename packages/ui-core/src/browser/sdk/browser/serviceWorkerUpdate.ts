// The update driver of a page (SDK parity pass §3.16, feature `update.driver` on `web`): a web
// build updates through its service worker, so "install" is the hand-off to a WAITING worker.
//
//   1. a `platform` decision (a web outlet has no binary to install: client-core's rule 9) names
//      the release the new worker carries;
//   2. the page finds its registration's waiting worker (an installing one is waited for);
//   3. it asks that worker to `skipWaiting()` by posting `{ type: "SKIP_WAITING" }`, the message
//      every Workbox-style worker already answers (a page cannot call `skipWaiting` on another
//      worker's behalf), and waits for it to take control, for at most `HAND_OFF_TIMEOUT_MS`
//      (a worker that never answers is `unsupported{dependency}`, not a pending install);
//   4. it reloads, so the page runs the new build, and answers `handedOff`. With `reload:
//      false` it stops after step 2 and answers `restartRequired`, whose `restart()` is steps
//      3 and 4: the host decides when the player loses their place. Before the reload the
//      journal is sent (`flush`), because a reload takes an in-memory journal with it.
//
// Every refusal is an ANSWER, never a throw: a page with no service worker, no registration or no
// waiting worker answers `unsupported` with the typed reason (PARITY §2.2). `binary` and `store`
// decisions are not a page's to install. Download and hand-off are journaled
// (`update_downloaded`, `update_applied`, §3.13) where the page holds a journal.
//
// The container, the reload and the journal are injected so the driver is testable with a fake
// registration, and so a host can reload through its own router.

/** What the page posts to the waiting worker to make it `skipWaiting()`. */
export const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" } as const;

/** The part of a `ServiceWorker` the driver uses. */
export interface SwWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The part of a `ServiceWorkerRegistration` the driver uses. */
export interface SwRegistration {
  readonly waiting: SwWorker | null;
  readonly installing: SwWorker | null;
}

/** The part of a `ServiceWorkerContainer` the driver uses (`navigator.serviceWorker`). */
export interface SwContainer {
  getRegistration(): Promise<SwRegistration | undefined>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** `navigator.serviceWorker`, or null where there is none (a server render, an insecure
 *  origin, jsdom). Reading it can throw where site data is blocked. */
export function pageServiceWorker(): SwContainer | null {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return null;
    return navigator.serviceWorker;
  } catch {
    return null;
  }
}

/** Whether the page's registration holds a waiting worker: what the boot guard calls a staged
 *  update. Never throws. */
export async function hasWaitingWorker(
  container: SwContainer | null,
): Promise<boolean> {
  if (!container) return false;
  try {
    return (await container.getRegistration())?.waiting != null;
  } catch {
    return false;
  }
}
