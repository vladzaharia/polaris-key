// The install driver interface (SDK parity pass §3.16, `update.driver`): what turns a signed
// `binary` or `store` decision into an installed build. `client.update.install(decision)` calls
// the configured driver; the adapters live beside this file, each under
// `@polaris-key/node/update/drivers/<name>`, and none of them imports its updater: the host
// passes the updater object it already depends on.

import type { UnsupportedReason } from "@polaris-key/client-core";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import type { FeedKind, FeedUrl } from "../client.js";
import type {
  FetchTarget,
  ReleaseFetchOptions,
  ReleaseFetchResult,
} from "../../release/fetch.js";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import type { UpdateEvent } from "../../constants.generated.js";
import type { UpdateEventInput } from "../journal.js";

/** How an install ended. */
export type InstallOutcome =
  /** The new build is in place and runs after a restart; `restart()` does it now. */
  | { kind: "restartRequired"; version: string; restart: () => Promise<void> }
  /** An external installer or updater took over (it may quit this process). */
  | { kind: "handedOff"; version: string; detail?: string }
  /** The store's listing (or the product's download page) was opened for the user. */
  | { kind: "storeOpened"; url: string }
  /** Nothing was installed, and why: the typed N/A vocabulary (PARITY §2.2). */
  | { kind: "unsupported"; reason: UnsupportedReason; detail: string };

/** What `install(decision, opts)` takes besides the decision. */
export interface InstallOptions {
  /** Bytes (or percent, when the updater reports only that) and the total. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** What the update client hands a driver: the SDK's verified download, feeds and journal. */
export interface InstallContext extends InstallOptions {
  /** The installed version (`CoreOptions.version`). */
  currentVersion: string;
  /** The SDK's state directory (drivers keep their own files under it). */
  stateDir: string;
  /** `client.release.fetch`: download and verify one build against its signed record. */
  fetch(
    target: FetchTarget,
    opts: ReleaseFetchOptions,
  ): Promise<ReleaseFetchResult>;
  /** The verified release record a decision names. */
  record(sha256: string): Promise<ReleaseRecordDoc>;
  /** `client.update.feedUrl(kind)`. */
  feedUrl(
    kind: FeedKind,
    opts?: { channel?: string; velopackChannel?: string; buildId?: string },
  ): Promise<FeedUrl>;
  /** Record an update-health event (§3.13) for the next device report. */
  journal(event: UpdateEvent, input: UpdateEventInput): Promise<void>;
  /** Open a URL with the OS's handler; false when it could not. */
  openUrl(url: string): Promise<boolean>;
}

/** The decisions a driver is asked to act on. */
export type InstallableDecision = Extract<
  UpdateDecision,
  { action: "binary" } | { action: "store" }
>;

/** One install adapter. */
export interface InstallDriver {
  /** A stable name for diagnostics (`electron-updater`, `velopack`, `sea`, `store-link`). */
  readonly name: string;
  install(
    decision: InstallableDecision,
    ctx: InstallContext,
  ): Promise<InstallOutcome>;
  /** Re-install `previousVersion` after failed boots (§3.15). True when it did. */
  rollback?(previousVersion: string): Promise<boolean>;
}

export function unsupported(
  reason: UnsupportedReason,
  detail: string,
): Extract<InstallOutcome, { kind: "unsupported" }> {
  return { kind: "unsupported", reason, detail };
}
