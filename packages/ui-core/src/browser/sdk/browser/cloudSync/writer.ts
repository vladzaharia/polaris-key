// One writer tab (U-20.2; plan section 3, R-6w). Tabs of one app share one IndexedDB record and one
// journal. The tab that holds the Web Lock `pkey-sync-writer:<name>` is the writer: it alone sends
// requests, applies edits and writes the record. Every other tab is a follower that reads the
// record, and takes over from the lock's queue when the writer's tab goes. A follower's edits are
// handed to the writer over the channel.
//
// The channel (`BroadcastChannel`, same origin only) carries facts and requests, never a value the
// record does not already hold in the clear, and never the root. Every message is checked against
// a strict shape before use; one that does not match is dropped.

import type { ChangeOrigin, Json } from "@polaris-key/client-core/cloud-sync";

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    fn: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  request(
    name: string,
    fn: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

export const webLocks = (): LockManagerLike | null => {
  try {
    const l = (globalThis as { navigator?: { locks?: LockManagerLike } })
      .navigator?.locks;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
};

/** A message between tabs. */
export type TabMessage =
  /** The writer stored record `rev`. */
  | { t: "state"; rev: number }
  /** Keys changed in the writer (its listeners were told). */
  | { t: "change"; keys: string[]; origin: ChangeOrigin }
  /** The record was deleted (sign-out, deactivation, `account_required`). */
  | { t: "purge" }
  /** A follower's edit, for the writer to apply to its machine. `id` lets the writer confirm it. */
  | { t: "edit"; id: number; op: "set"; key: string; value: Json }
  | { t: "edit"; id: number; op: "clear"; key: string }
  /** The writer took edit `id` (applied to its machine, so its own journal carries it). */
  | { t: "ack"; id: number };

/** A channel the host can post to and listen on. */
export interface TabChannel {
  post(m: TabMessage): void;
  onMessage(fn: (m: TabMessage) => void): void;
  close(): void;
}

const ORIGINS = new Set<string>(["local", "remote", "merge", "migration"]);
const MAX_KEYS = 1024;
const KEY = /^[A-Za-z0-9._-]{1,128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The message, or null when `v` is not one. */
export function parseTabMessage(v: unknown): TabMessage | null {
  if (!isRecord(v)) return null;
  switch (v.t) {
    case "state":
      return Number.isSafeInteger(v.rev) && (v.rev as number) >= 0
        ? { t: "state", rev: v.rev as number }
        : null;
    case "change":
      return Array.isArray(v.keys) &&
        v.keys.length <= MAX_KEYS &&
        v.keys.every((k) => typeof k === "string" && k.length <= 256) &&
        typeof v.origin === "string" &&
        ORIGINS.has(v.origin)
        ? {
            t: "change",
            keys: v.keys as string[],
            origin: v.origin as ChangeOrigin,
          }
        : null;
    case "purge":
      return { t: "purge" };
    case "ack":
      return Number.isSafeInteger(v.id)
        ? { t: "ack", id: v.id as number }
        : null;
    case "edit":
      if (typeof v.key !== "string" || !KEY.test(v.key)) return null;
      if (!Number.isSafeInteger(v.id)) return null;
      if (v.op === "clear")
        return { t: "edit", id: v.id as number, op: "clear", key: v.key };
      return v.op === "set" && "value" in v
        ? {
            t: "edit",
            id: v.id as number,
            op: "set",
            key: v.key,
            value: v.value as Json,
          }
        : null;
    default:
      return null;
  }
}

/** `BroadcastChannel` `name`, or a channel that goes nowhere where there is none. */
export function broadcastChannel(
  name: string,
  make: ((name: string) => BroadcastChannel) | undefined = (
    globalThis as { BroadcastChannel?: typeof BroadcastChannel }
  ).BroadcastChannel
    ? (n) => new BroadcastChannel(n)
    : undefined,
): TabChannel {
  if (make === undefined)
    return { post: () => undefined, onMessage: () => undefined, close() {} };
  const bc = make(name);
  return {
    post: (m) => {
      try {
        bc.postMessage(m);
      } catch {
        // A closed channel: the other tabs read the record on their next change.
      }
    },
    onMessage: (fn) => {
      bc.onmessage = (e: MessageEvent) => {
        const m = parseTabMessage(e.data);
        if (m !== null) fn(m);
      };
    },
    close: () => bc.close(),
  };
}

/** Which tab writes. */
export interface WriterRole {
  /** Settles once this tab knows whether it is the writer. */
  readonly decided: Promise<boolean>;
  readonly isWriter: boolean;
  /** Give the lock up (the next tab in the queue becomes the writer). */
  release(): void;
}

/**
 * Join the election: the lock is asked for without waiting; a tab that does not get it is a
 * follower and queues for it. `onPromoted` runs when a queued tab is granted the lock (the writer's
 * tab went): the caller re-reads the record before it writes anything.
 */
export function joinWriterElection(
  locks: LockManagerLike,
  name: string,
  onPromoted: () => void,
): WriterRole {
  let writer = false;
  let free: () => void = () => undefined;
  const held = new Promise<void>((r) => (free = r));
  let released = false;
  let decide: (w: boolean) => void = () => undefined;
  const decided = new Promise<boolean>((r) => (decide = r));
  const hold = (): Promise<void> => {
    writer = true;
    return held;
  };
  locks
    .request(name, { ifAvailable: true }, (lock) => {
      if (lock === null || lock === undefined) {
        decide(false);
        if (released) return;
        // Queue behind the writer. The grant is a promotion, never a first write.
        void locks
          .request(name, () => {
            if (released) return;
            const p = hold();
            onPromoted();
            return p;
          })
          .catch(() => undefined);
        return;
      }
      const p = hold();
      decide(true);
      return p;
    })
    .catch(() => decide(false));
  return {
    decided,
    get isWriter() {
      return writer && !released;
    },
    release() {
      released = true;
      writer = false;
      free();
    },
  };
}
