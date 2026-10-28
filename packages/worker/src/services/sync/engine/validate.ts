/**
 * Request and mutation shape (§13.3). A malformed push is a request-level `400 bad_request`: the
 * client never sends one (its journal is typed), so there is nothing per-mutation to answer, and
 * rule 1 leaves the journal alone. Value *validity* (a catalog schema, the 8 KiB open limit) is the
 * Worker's classification, not shape.
 */

import {
  SYNC_KEY_PATTERN,
  SYNC_MAX_MUTATIONS,
  type PushRequest,
  type SyncMutation,
  type SyncOp,
} from "@polaris-key/protocol/sync";
import { isClientId, isHlc } from "./hlc.js";

const KEY_RE = new RegExp(SYNC_KEY_PATTERN);

const OPS: ReadonlySet<string> = new Set<SyncOp>([
  "set",
  "clear",
  "setMember",
  "removeMember",
  "setField",
  "removeField",
  "delete",
  "add",
  "remove",
]);

export type ShapeResult =
  | { ok: true; request: PushRequest }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (reason: string): ShapeResult => ({ ok: false, reason });

/** `mutationId`: an integer from 1 to 2^53 - 1. */
export const isMutationId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

function mutationProblem(m: unknown): string | null {
  if (!isObject(m)) return "mutation_not_object";
  if (!isMutationId(m.mutationId)) return "mutation_id";
  if (typeof m.op !== "string" || !OPS.has(m.op)) return "op";
  const t = m.target;
  if (!isObject(t)) return "target";
  if ("setting" in t) {
    if (typeof t.setting !== "string" || !KEY_RE.test(t.setting))
      return "setting_key";
    if (t.scope !== "user" && t.scope !== "platform") return "scope";
  } else if ("record" in t) {
    const r = t.record;
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      !r.every((x) => typeof x === "string" && KEY_RE.test(x))
    )
      return "record_target";
  } else return "target";
  if (m.editedHlc !== undefined && !isHlc(m.editedHlc)) return "edited_hlc";
  if (
    m.member !== undefined &&
    (typeof m.member !== "string" || m.member === "")
  )
    return "member";
  // The per-operation members a setting mutation cannot do without.
  if ("setting" in t) {
    if (m.editedHlc === undefined) return "edited_hlc_required";
    // §13.3: `ct` replaces `value` in end-to-end mode; which one is legal is the product's mode,
    // decided by the classification (`encryption_mismatch`), not by shape.
    if (m.ct !== undefined && typeof m.ct !== "string") return "ct";
    if (
      (m.op === "set" || m.op === "setMember") &&
      !("value" in m) &&
      !("ct" in m)
    )
      return "value_required";
    if (
      (m.op === "setMember" || m.op === "removeMember") &&
      m.member === undefined
    )
      return "member_required";
  }
  return null;
}

/**
 * Checks a decoded push body. Mutation ids must strictly increase inside the batch (rule 4), and
 * there are at most `SYNC_MAX_MUTATIONS` of them.
 */
export function validatePush(body: unknown): ShapeResult {
  if (!isObject(body)) return fail("body");
  if (!isClientId(body.clientId)) return fail("client_id");
  if (
    typeof body.cursor !== "number" ||
    !Number.isSafeInteger(body.cursor) ||
    body.cursor < 0
  )
    return fail("cursor");
  if (body.atomic !== undefined && typeof body.atomic !== "boolean")
    return fail("atomic");
  if (!Array.isArray(body.mutations)) return fail("mutations");
  if (body.mutations.length > SYNC_MAX_MUTATIONS)
    return fail("too_many_mutations");
  let previous = 0;
  for (const m of body.mutations) {
    const problem = mutationProblem(m);
    if (problem) return fail(problem);
    const id = (m as SyncMutation).mutationId;
    if (id <= previous) return fail("mutation_id_order");
    previous = id;
  }
  return { ok: true, request: body as unknown as PushRequest };
}
