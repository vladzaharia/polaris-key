/**
 * The push: one batch applied to a `SyncStore` under push and journal rules 1 to 8 (§13.3).
 *
 *   rule 1  the client's last processed mutation id advances past every processed mutation,
 *           whatever its result; only a request-level failure leaves it.
 *   rule 4  a clientId binds to the first device that pushes with it; another device is a
 *           request-level `client_mismatch`. Ids at or below the last processed are `duplicate`.
 *   clamp   an `editedHlc` later than `serverNow` plus the allowed skew becomes `serverNow`.
 *   rule 6  a renamed key is written under its new name and answers `renamedTo`; a dropped key
 *           answers `dropped: true` and writes nothing (`migrations`).
 *   quota   a write that grows the store past the budget, quota or ceiling is `rejected` with
 *           `quota_exceeded`; the rest of the batch is unaffected (settings.ts).
 *   atomic  all or nothing: the first mutation that is not `ok` keeps its result, every other
 *           processed mutation is `aborted`, nothing is written, and the ids still count as
 *           processed.
 *
 * Applying a batch twice equals applying it once: the second pass finds every id at or below the
 * last processed and answers `duplicate`.
 */

import type { MutationResult, SyncMutation } from "@polaris-key/protocol/sync";
import { clampHlc } from "./hlc.js";
import { resolveKey } from "./migrations.js";
import { applySettingMutation } from "./settings.js";
import type { PushInput, PushOutcome, Stamp, SyncStore } from "./types.js";
import { validatePush } from "./validate.js";

/** Client bindings one person's object keeps; a new one past it needs an idle one to replace. */
export const MAX_CLIENT_BINDINGS = 32;
/** A binding this idle (seconds) may be replaced by a new client once the cap is reached. */
export const CLIENT_BINDING_IDLE_SECONDS = 86_400;

/** Thrown inside an atomic batch's transaction to roll its writes back. */
class AtomicRollback extends Error {
  constructor(readonly results: MutationResult[]) {
    super("atomic batch failed");
  }
}

function applyOne(
  store: SyncStore,
  input: PushInput,
  m: SyncMutation,
  index: number,
): MutationResult {
  const route = input.classified[index];
  if (!route) throw new Error("push: classified is shorter than mutations");
  // A record target: the Worker's refusal stands; the record rules are U-09.4's.
  if (!("setting" in m.target))
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: route.verdict === "reject" ? route.code : "collection_unknown",
    };
  if (route.verdict === "record")
    throw new Error("push: a record classification for a setting target");
  // Rule 6: the catalog's migrations speak for a key before its classification does.
  const migration = resolveKey(m.target.setting, input.migrations);
  if (migration.kind === "dropped")
    // A dropped key has no version: nothing was written.
    return {
      mutationId: m.mutationId,
      status: "ok",
      dropped: true,
    } as MutationResult;
  if (route.verdict === "reject")
    return { mutationId: m.mutationId, status: "rejected", code: route.code };
  const stamp: Stamp = {
    hlc: clampHlc(m.editedHlc as string, input.serverNow),
    clientId: input.request.clientId,
  };
  const ctx = { family: input.family ?? "", limits: input.limits };
  if (migration.kind === "same")
    return applySettingMutation(store, m, route, stamp, ctx);
  const result = applySettingMutation(
    store,
    { ...m, target: { ...m.target, setting: migration.to } },
    route,
    stamp,
    ctx,
  );
  return result.status === "ok"
    ? { ...result, renamedTo: migration.to }
    : result;
}

/**
 * Applies a batch. `input.classified` is parallel to `input.request.mutations`. Never throws for
 * client input: a bad request or another device's clientId is a returned failure.
 */
export function applyPush(store: SyncStore, input: PushInput): PushOutcome {
  const shape = validatePush(input.request);
  if (!shape.ok)
    return { ok: false, error: "bad_request", reason: shape.reason };
  const { clientId, mutations } = shape.request;
  if (input.classified.length !== mutations.length)
    throw new Error("push: classified must be parallel to mutations");

  const bound = store.getClient(clientId);
  if (bound && bound.deviceId !== input.deviceId)
    return { ok: false, error: "client_mismatch" };
  const startLast = bound?.lastMutationId ?? 0;

  // A new binding costs a row. A request with nothing to process never makes one, and at the cap a
  // new client replaces a binding that has been idle for a day, or is refused.
  if (
    !bound &&
    mutations.length > 0 &&
    store.clientCount() >= MAX_CLIENT_BINDINGS &&
    !store.dropIdleClient(
      Math.floor(input.serverNow / 1000) - CLIENT_BINDING_IDLE_SECONDS,
    )
  )
    return { ok: false, error: "bad_request", reason: "too_many_clients" };

  // The users ceiling (U-05.14): an object that never held a live setting refuses growth once
  // the product is at its user limit. Decided once, before the batch, so a batch cannot admit itself.
  if (input.limits?.usersAtCeiling && !store.heldData())
    input = { ...input, limits: { ...input.limits, productOverCeiling: true } };

  const run = (): MutationResult[] => {
    // The first end-to-end write fixes `encryptionSince` (§13.10.7): every row at or above the
    // next sequence is sealed, every row below it is legacy plaintext. Set once, and only by a
    // sealed write that was accepted: a rejected one does not count.
    const sealedAt =
      store.getEncryptionSince() === undefined ? store.currentSeq() + 1 : null;
    const results: MutationResult[] = [];
    let last = startLast;
    mutations.forEach((m, i) => {
      if (m.mutationId <= last) {
        results.push({ mutationId: m.mutationId, status: "duplicate" });
        return;
      }
      const result = applyOne(store, input, m, i);
      last = m.mutationId;
      results.push(result);
      if (
        sealedAt !== null &&
        store.getEncryptionSince() === undefined &&
        result.status === "ok" &&
        input.classified[i]?.verdict === "accept" &&
        input.classified[i]?.sealed
      )
        store.setEncryptionSince(sealedAt);
      if (shape.request.atomic && result.status !== "ok")
        throw new AtomicRollback(results);
    });
    return results;
  };

  const advance = (results: readonly MutationResult[]): number => {
    const last = Math.max(startLast, ...results.map((r) => r.mutationId));
    if (!bound && results.length === 0) return last;
    store.putClient({
      clientId,
      deviceId: input.deviceId,
      lastMutationId: last,
    });
    return last;
  };

  let results: MutationResult[];
  let lastMutationId: number;
  try {
    ({ results, lastMutationId } = store.transaction(() => {
      const rs = run();
      return { results: rs, lastMutationId: advance(rs) };
    }));
  } catch (e) {
    if (!(e instanceof AtomicRollback)) throw e;
    // Nothing of the batch was written. Every processed mutation but the failing one is aborted,
    // and the ids are processed all the same (rule 1).
    const failed = e.results[e.results.length - 1] as MutationResult;
    const done = new Map(e.results.map((r) => [r.mutationId, r] as const));
    results = mutations.map((m) => {
      if (m.mutationId === failed.mutationId) return failed;
      const earlier = done.get(m.mutationId);
      if (earlier?.status === "duplicate") return earlier;
      return { mutationId: m.mutationId, status: "aborted" as const };
    });
    lastMutationId = store.transaction(() => advance(results));
  }

  let accepted = 0;
  let conflicts = 0;
  for (const r of results) {
    if (r.status === "ok") accepted++;
    else if (r.status === "conflict") conflicts++;
  }
  return {
    ok: true,
    results,
    lastMutationId,
    seq: store.currentSeq(),
    usage: store.getUsage(),
    counts: { accepted, conflicts },
  };
}
