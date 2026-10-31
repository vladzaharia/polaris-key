/**
 * Shared helpers of the U-09.5/.7 engine suites (`cloudSyncRecordsMerge`, `cloudSyncPullRecords`,
 * `cloudSyncSettingsKid`): mutations, routes and sealed values for the in-memory store, which the
 * `cloudSyncSqlParity*` twins swap for the SQLite one.
 */
import type { MutationResult, SyncMutation } from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { applyPull } from "../../../src/services/sync/engine/pull.js";
import { applyPush } from "../../../src/services/sync/engine/push.js";
import type {
  Classification,
  PushLimits,
  RecordPolicy,
  SettingPolicy,
} from "../../../src/services/sync/engine/types.js";

export const NOW = 1_760_000_000_000;

/** An HLC `n` milliseconds before the server's clock. */
export const ago = (n: number): string => formatHlc(NOW - n, 0);

/** A blinded name (`x:` and 43 base64url characters). */
export const blinded = (n: number): string =>
  `x:${String(n).padStart(43, "A")}`;

/** A well-shaped sealed value of `blocks` padded blocks whose key id bytes are all `fill`. */
export function sealedBox(fill = 7, blocks = 1): string {
  const bytes = new Uint8Array(49 + 64 * blocks).fill(fill);
  bytes[0] = 1;
  return Buffer.from(bytes).toString("base64url");
}

/** The key id (`kid`) of `sealedBox(fill)`: bytes 1 to 16 as hex. */
export const kidOf = (fill: number): string =>
  fill.toString(16).padStart(2, "0").repeat(16);

export function recordRoute(
  policy: RecordPolicy,
  opts: { sealed?: boolean; maxRecords?: number } = {},
): Extract<Classification, { verdict: "record" }> {
  return {
    verdict: "record",
    policy,
    maxRecords: opts.maxRecords ?? 100,
    ...(opts.sealed ? { sealed: true } : {}),
  };
}

export function settingRoute(
  policy: SettingPolicy,
  sealed = false,
): Classification {
  return {
    verdict: "accept",
    scope: "user",
    policy,
    ...(sealed ? { sealed: true } : {}),
  };
}

let ids = 1;
export const restartIds = (): void => {
  ids = 1;
};

export function recordOp(
  collection: string,
  id: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation {
  return {
    mutationId: ids++,
    target: { record: [collection, id] },
    op,
    editedHlc: ago(1000),
    ...extra,
  };
}

export function settingOp(
  key: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation {
  return {
    mutationId: ids++,
    target: { setting: key, scope: "user" },
    op,
    editedHlc: ago(1000 - ids),
    ...extra,
  };
}

/** Pushes the `[mutation, route]` pairs as one batch from one client, and returns the results. */
export function applyAll(
  store: MemoryStore,
  items: readonly (readonly [SyncMutation, Classification])[],
  limits?: PushLimits,
): MutationResult[] {
  const out = applyPush(store, {
    deviceId: "dev1",
    family: "desktop",
    serverNow: NOW,
    classified: items.map(([, route]) => route),
    request: {
      clientId: "c_000000000000000client1",
      cursor: 0,
      mutations: items.map(([mutation]) => mutation),
    },
    ...(limits ? { limits } : {}),
  });
  if (!out.ok) throw new Error(`push failed: ${JSON.stringify(out)}`);
  return out.results;
}

/** Like `applyAll`, but every mutation must be accepted. */
export function applyOk(
  store: MemoryStore,
  ...items: (readonly [SyncMutation, Classification])[]
): void {
  for (const r of applyAll(store, items))
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
}

/** A pull of the store as one device, which must be served. */
export function pullAs(
  store: MemoryStore,
  over: Partial<Parameters<typeof applyPull>[1]> = {},
) {
  const out = applyPull(store, {
    deviceId: "dev1",
    family: "desktop",
    ...over,
  });
  if (!out.ok) throw new Error(out.error);
  return out;
}

/** What an absorb is given of the absorbed store `src` (an export document, read back). */
export function absorbInputOf(src: MemoryStore, fromSubject: string) {
  const since = src.getEncryptionSince();
  return {
    settings: src.rows(),
    clients: [],
    records: src.recordRows(),
    parked: src.parkedRecords(),
    fromSubject,
    now: 1_760_000_100,
    ...(since !== undefined ? { encryptionSince: since } : {}),
  };
}
