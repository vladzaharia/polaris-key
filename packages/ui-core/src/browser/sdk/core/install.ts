// The install hand-off (SDK parity pass §3.16, feature `update.driver`): what
// `adapter.installUpdate(decision)` answers. `@polaris-key/node`'s `InstallOutcome`
// (packages/sdk-node/src/update/drivers/types.ts), kind for kind: a page's driver is its service
// worker (browser/serviceWorkerUpdate.ts) and a desktop renderer's is the host's, over the
// bridge (`invoke("update", "install", {decision})`).
//
// An install never throws for something that cannot be installed: it ANSWERS `unsupported` with
// the typed reason (PARITY §2.2), so a prompt can render the refusal instead of catching it.

import type { UnsupportedReason } from "@polaris-key/client-core";
import type { UpdateDecision } from "@polaris-key/protocol/update";

/** How an install ended. */
export type InstallOutcome =
  /** The new build is in place and runs after a restart; `restart()` does it now. */
  | { kind: "restartRequired"; version: string; restart: () => Promise<void> }
  /** An external installer or updater took over (a page: the new service worker took control
   *  and the page is reloading). */
  | { kind: "handedOff"; version: string; detail?: string }
  /** The store's listing (or the product's download page) was opened for the user. */
  | { kind: "storeOpened"; url: string }
  /** Nothing was installed, and why: the typed N/A vocabulary (PARITY §2.2). */
  | { kind: "unsupported"; reason: UnsupportedReason; detail: string };

/** What `installUpdate(decision, opts)` takes besides the decision. */
export interface InstallOptions {
  /** Stop waiting: the install rejects with the signal's reason. Checked before anything
   *  starts; on a page it also ends the wait for a worker. */
  signal?: AbortSignal;
  /** Page only: reload once the new service worker controls the page, and answer `handedOff`
   *  (the default). `false` answers `restartRequired` instead and leaves the reload to the
   *  caller's `restart()`. A desktop host decides on its own. */
  reload?: boolean;
  /** Desktop only: bytes as the host's install driver reports them. `total` is `null` when the
   *  driver does not know it: draw an indeterminate bar, never a percentage. A host that does
   *  not push progress (older bridge, a driver that reports none) never calls it. */
  onProgress?: (done: number, total: number | null) => void;
}

export type UnsupportedOutcome = Extract<
  InstallOutcome,
  { kind: "unsupported" }
>;

export function unsupportedOutcome(
  reason: UnsupportedReason,
  detail: string,
): UnsupportedOutcome {
  return { kind: "unsupported", reason, detail };
}

/**
 * The answer for a decision no driver installs (Node's text, so the two JavaScript SDKs read the
 * same): a `packs` decision is the pack engine's, a `code-ready` one has no code to run on a
 * page, a `platform` one is the platform's own updater (`outlet`), and `none` and `blocked`
 * offer nothing.
 */
export function notInstallable(decision: UpdateDecision): UnsupportedOutcome {
  const detail =
    decision.action === "packs"
      ? "a packs decision is installed by update.packs.ensure()."
      : decision.action === "code-ready"
        ? "a page runs no code packs."
        : decision.action === "platform"
          ? "the platform's own updater installs this build."
          : `there is nothing to install (${decision.action}).`;
  return unsupportedOutcome(
    decision.action === "platform" ? "outlet" : "product",
    detail,
  );
}

const KINDS: Record<string, true> = {
  restartRequired: true,
  handedOff: true,
  storeOpened: true,
  unsupported: true,
};
const REASONS: Record<string, true> = {
  runtime: true,
  outlet: true,
  product: true,
  dependency: true,
  version: true,
};

/** An outcome as a bridge host answers it: a `restartRequired` carries no function across IPC. */
export type WireInstallOutcome =
  | { kind: "restartRequired"; version: string }
  | Exclude<InstallOutcome, { kind: "restartRequired" }>;

/** True when `v` is a well-formed bridge answer (the renderer trusts the host's process, not the
 *  shape of its answer). */
export function isWireInstallOutcome(v: unknown): v is WireInstallOutcome {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(KINDS, o.kind)
  )
    return false;
  switch (o.kind) {
    case "restartRequired":
    case "handedOff":
      return typeof o.version === "string";
    case "storeOpened":
      return typeof o.url === "string";
    default:
      return (
        typeof o.reason === "string" &&
        Object.prototype.hasOwnProperty.call(REASONS, o.reason) &&
        typeof o.detail === "string"
      );
  }
}
