/**
 * The shared hash-router core (P0-34): a tiny external store over `location.hash`, used by the
 * console and the portal once they sit on it (P0-34.3, P0-34.4). No router dependency, no React:
 * `subscribe` and `snapshot` are shaped for `useSyncExternalStore`.
 *
 * - **Redirects** apply on read with `history.replaceState`, so Back never loops through one.
 * - **Blockers** (`blockNavigation`) may refuse a `navigate`; a `hashchange` they could not
 *   prevent (typed URL, Back) is rolled back to the last hash every blocker allowed.
 * - **One publish per navigation**: a push fires both `popstate` and `hashchange`, and the same
 *   hash again is a no-op.
 * - **Motion**: a change of path runs the injected `transition` runner (`lib/` cannot import
 *   `ui/motion`); the page keeps the old hash until the runner calls the update. The query alone
 *   never starts one, and neither does a navigation made while {@link overlayOnScreen}.
 * - **Params** are codec-agnostic strings; the console's typed codecs stay console code.
 * - **One router per document**: `createHashRouter` registers itself as the active router, and
 *   the module-level {@link navigate} and {@link blockNavigation} reach it.
 *
 * This module imports nothing local (docs/design/ADMIN.md layering: `lib/` imports only `lib/`).
 */

export type Blocker = (nextHash: string) => boolean;

/** One shared element of a transition: the old end, and the name it takes for that snapshot. */
export type SharedElement = readonly [Element | null | undefined, string];

export interface TransitionRun {
  type: string;
  shared: ReadonlyArray<SharedElement>;
}

export interface TransitionHandle {
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
}

/** What the injected runner is: `viewTransition` of `ui/motion` fits. */
export type TransitionRunner = (
  update: () => void,
  run: TransitionRun,
) => TransitionHandle | void;

export interface HashRouterConfig {
  /** The canonical hash for one that redirects (a section root), or `null` for none. */
  redirect(hash: string): string | null;
  /** The transition type from one hash to another, or `null` for none (same path, no motion). */
  classify(from: string, to: string): string | null;
  /** Runs `update` inside a transition. It may call `update` at once (no API, reduced motion). */
  transition: TransitionRunner;
  /**
   * Wraps the update a transition calls LATER, so the DOM is final when the new state is
   * captured (React's `flushSync`). Default: call it directly.
   */
  flush?(fn: () => void): void;
  /**
   * Call the runner even while an overlay is on screen (default: the page then swaps at once,
   * with no runner). For a runner that also places the page (scroll, focus) and decides about
   * motion itself.
   */
  runUnderOverlay?: boolean;
  /** Called once per published change, before the page updates; `kind` is the transition type. */
  onNavigate?(from: string, to: string, kind: string | null): void;
}

export type ParamPatch = Record<string, string | readonly string[] | null>;

export interface NavigateOptions {
  /** Swap the history entry instead of pushing one. */
  replace?: boolean;
  /** Skip the blockers: a change that stays on the page and cannot lose work. */
  force?: boolean;
}

export interface Intent {
  hash: string;
  type?: string;
  shared?: Element | null;
}

export interface HashRouter {
  /** `useSyncExternalStore`'s subscribe; the first listener attaches the window listeners. */
  subscribe(listener: () => void): () => void;
  /** The hash the page renders: the held old hash during a capture, else the current one. */
  snapshot(): string;
  /** Returns `false` when a blocker refused. The same hash again is a no-op (`true`). */
  navigate(hash: string, opts?: NavigateOptions): boolean;
  /** Merge `patch` into the current hash's query; replaces the history entry by default. */
  setParams(patch: ParamPatch, opts?: { replace?: boolean }): void;
  /** Register a guard; returns the unregister function. */
  blockNavigation(fn: Blocker): () => void;
  /** Ask the blockers about a hash without navigating (a link click). */
  allows(hash: string): boolean;
  /**
   * A link click the blockers already answered for: the `hashchange` it causes must not ask
   * again, and the navigation that follows carries its transition type and shared element.
   */
  commit(intent: Intent): void;
  /** Stop being the active router (a no-op for an inactive one). */
  dispose(): void;
  /** Forget all state between tests. */
  resetForTests(): void;
}

// ── The overlay detector ──────────────────────────────────────────────────────────────────────

const OVERLAY_ROLES = ["dialog", "alertdialog", "menu"] as const;
/** Radix keeps an overlay mounted through its exit (`data-state="closed"`). */
export const ANY_OVERLAY_ROLE = OVERLAY_ROLES.map((r) => `[role="${r}"]`).join(
  ", ",
);
export const CLOSING_OVERLAYS = OVERLAY_ROLES.map(
  (r) => `[role="${r}"][data-state="closed"]`,
).join(", ");
export const OPEN_OVERLAYS = OVERLAY_ROLES.map(
  (r) => `[role="${r}"]:not([data-state="closed"])`,
).join(", ");
/** The console's modal scrim and drawer classes, and a toast sonner shows. */
const OVERLAY_CLASSES =
  '.animate-pk-overlay-in, .pk-overlay, .pk-drawer, [data-sonner-toast]:not([data-visible="false"])';

/**
 * An overlay on screen, open or still running its exit: a dialog, alertdialog or menu, the
 * console's scrim and drawer, a visible toast (sonner's toaster sits over the main column, and
 * the main region's snapshot would cover it), or popper content that is not a tooltip (one
 * closes on the click that navigates). A View Transition's snapshots would paint over any of
 * these (S-23 §3.4), so the page swaps under its exit instead.
 */
export function overlayOnScreen(): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector(`${ANY_OVERLAY_ROLE}, ${OVERLAY_CLASSES}`))
    return true;
  return [
    ...document.querySelectorAll("[data-radix-popper-content-wrapper] > *"),
  ].some((el) => !el.querySelector("[role='tooltip']"));
}

// ── Hash helpers ──────────────────────────────────────────────────────────────────────────────

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function replaceHash(hash: string): void {
  const { pathname, search } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${search}${hash}`,
  );
}

function withParams(hash: string, patch: ParamPatch): string {
  const raw = hash || "#/";
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  for (const [k, v] of Object.entries(patch)) {
    params.delete(k);
    if (typeof v === "string") {
      if (v !== "") params.set(k, v);
    } else if (v) for (const one of v) if (one !== "") params.append(k, one);
  }
  const s = params.toString();
  return `${path}${s ? `?${s}` : ""}`;
}

// ── The router ────────────────────────────────────────────────────────────────────────────────

let active: HashRouter | null = null;

export function createHashRouter(config: HashRouterConfig): HashRouter {
  const listeners = new Set<() => void>();
  const blockers = new Set<Blocker>();
  /** The last hash every blocker allowed: what a refused `hashchange` is rolled back to. */
  let committedHash: string | null = null;
  /** The last hash published to the page. `null` while nothing listens. */
  let shownHash: string | null = null;
  /** The old hash a transition keeps on screen until it has captured the page. */
  let heldHash: string | null = null;
  let intent: Intent | null = null;

  /** The location's hash, with a redirect applied in place (replace, never push). */
  function read(): string {
    const hash = currentHash();
    const target = config.redirect(hash);
    if (target !== null && target !== hash) {
      replaceHash(target);
      return target;
    }
    return hash;
  }

  const allows = (hash: string): boolean => {
    for (const b of blockers) if (!b(hash)) return false;
    return true;
  };

  const emit = (): void => {
    for (const l of Array.from(listeners)) l();
  };

  function publish(next: string): void {
    const from = shownHash;
    const clicked = intent?.hash === next ? intent : null;
    intent = null;
    if (from === null) {
      emit();
      return;
    }
    if (next === from) return;
    shownHash = next;
    const type = clicked?.type ?? config.classify(from, next);
    config.onNavigate?.(from, next, type);
    if (type === null || (!config.runUnderOverlay && overlayOnScreen())) {
      emit();
      return;
    }
    const source = type === "forward" ? (clicked?.shared ?? null) : null;
    const name = source?.getAttribute("data-vt-shared");
    heldHash ??= from;
    // A runner that starts no transition calls the update right here, and the state then updates
    // like any other store change. Only an update the browser calls later needs the flush.
    let inline = true;
    config.transition(
      () => {
        heldHash = null;
        if (inline || !config.flush) emit();
        else config.flush(emit);
      },
      { type, shared: source && name ? [[source, name]] : [] },
    );
    inline = false;
  }

  function onHashChange(): void {
    const next = read();
    if (committedHash !== null && next !== committedHash && !allows(next)) {
      // Too late to prevent: put the URL back and keep the page.
      replaceHash(committedHash);
      return;
    }
    committedHash = next;
    publish(next);
  }

  const router: HashRouter = {
    subscribe(listener) {
      if (listeners.size === 0) {
        const hash = read();
        committedHash = hash;
        shownHash = hash;
        window.addEventListener("hashchange", onHashChange);
        window.addEventListener("popstate", onHashChange);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          window.removeEventListener("hashchange", onHashChange);
          window.removeEventListener("popstate", onHashChange);
          committedHash = null;
          shownHash = null;
          heldHash = null;
          intent = null;
        }
      };
    },

    snapshot() {
      return heldHash ?? shownHash ?? read();
    },

    navigate(hash, opts = {}) {
      const target = config.redirect(hash) ?? hash;
      if (target === currentHash()) return true;
      if (!opts.force && !allows(target)) return false;
      committedHash = target;
      if (opts.replace) {
        replaceHash(target);
        publish(target);
      } else {
        window.location.hash = target;
      }
      return true;
    },

    setParams(patch, opts = {}) {
      router.navigate(withParams(router.snapshot(), patch), {
        replace: opts.replace ?? true,
        force: true,
      });
    },

    blockNavigation(fn) {
      blockers.add(fn);
      return () => {
        blockers.delete(fn);
      };
    },

    allows,

    commit(next) {
      committedHash = next.hash;
      intent = next;
    },

    dispose() {
      if (active === router) active = null;
    },

    resetForTests() {
      blockers.clear();
      committedHash = null;
      shownHash = null;
      heldHash = null;
      intent = null;
    },
  };

  active = router;
  return router;
}

// ── The active router ─────────────────────────────────────────────────────────────────────────

/** The router this document runs; throws before one exists (a wiring error, not a runtime case). */
export function activeRouter(): HashRouter {
  if (!active) throw new Error("No hash router: call createHashRouter first.");
  return active;
}

/** Navigate the active router. Returns `false` when a blocker refused. */
export function navigate(hash: string, opts?: NavigateOptions): boolean {
  return activeRouter().navigate(hash, opts);
}

/** Register a navigation guard on the active router; returns the unregister function. */
export function blockNavigation(fn: Blocker): () => void {
  return activeRouter().blockNavigation(fn);
}
