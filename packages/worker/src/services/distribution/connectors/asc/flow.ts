/**
 * The plumbing shared by A-17's product-scope App Store Connect flows: A-17d's Distribute
 * (`distribute.ts`) and A-17e's IAP catalog (`../../commerce/appleCatalog.ts`). Moved out of
 * `distribute.ts` by A-17e so both import it without importing each other.
 *
 *   - `distributeControl` / `distributeRead`: the `Idempotency-Key` (writes), then P5-02's pinned
 *     run (`withRun`: a missing or mismatched pin refuses before any token is minted), then the
 *     flow; a `Refused` raised anywhere inside answers its result.
 *   - `step`: one ledger step (`core/asc/ledger.ts`) keyed by the product, the op, the natural key
 *     and the console's key; a reused key with another body is 409 `idempotency_conflict`.
 *   - `proveOwned`: one resource re-read with `include=app`, refused unless it is the pinned app's.
 */

import {
  ascPath,
  relId,
  single,
  type AscDocument,
  type AscResource,
} from "../../../../core/asc/client.js";
import {
  isIdempotencyKey,
  performAscWrite,
} from "../../../../core/asc/ledger.js";
import type { AscWriteStep } from "../../../../core/asc/ledger.js";
import type { AscRun } from "./apply.js";
import {
  refuse,
  withRun,
  type ConnectorControl,
  type ConnectorRead,
  type ControlContext,
  type ControlResult,
} from "./controls.js";
import type { AscSetup } from "./setup.js";

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────

/** A refusal raised from inside a flow; `distributeControl` answers its result. */
export class Refused extends Error {
  constructor(readonly result: ControlResult) {
    super("refused");
  }
}

export function stop(
  status: 404 | 409 | 422 | 502,
  reason: string,
  message: string,
  fields?: string[],
): never {
  throw new Refused(refuse(status, reason, message, fields));
}

export interface Flow {
  c: ControlContext;
  run: AscRun;
  setup: AscSetup;
  /** The validated `Idempotency-Key` (writes only). */
  key: string;
}

/** A Distribute write: the Idempotency-Key, then the pinned run, then `fn`. */
export function distributeControl(
  fn: (f: Flow, body: Record<string, unknown>) => Promise<ControlResult>,
): ConnectorControl {
  return (c, body) => {
    const key = c.idempotencyKey;
    if (!isIdempotencyKey(key))
      return Promise.resolve(
        refuse(
          422,
          "idempotency_key_required",
          "send an Idempotency-Key header (a UUID per operator intent)",
        ),
      );
    return withRun(c, async (run, setup) => {
      try {
        return await fn({ c, run, setup, key }, body);
      } catch (e) {
        if (e instanceof Refused) return e.result;
        throw e;
      }
    });
  };
}

/** A Distribute read: the pinned run, then `fn`. */
export function distributeRead(
  fn: (f: Omit<Flow, "key">, q: URLSearchParams) => Promise<ControlResult>,
): ConnectorRead {
  return (c, q) =>
    withRun(c, async (run, setup) => {
      try {
        return await fn({ c, run, setup }, q);
      } catch (e) {
        if (e instanceof Refused) return e.result;
        throw e;
      }
    });
}

export type StepOutcome = "written" | "existing" | "replayed";

export interface StepResult {
  outcome: StepOutcome;
  opId: string;
  ids: Record<string, string>;
}

/** One ledger step of a product-scope Distribute write. */
export async function step<T extends AscResource>(
  f: Flow,
  op: string,
  naturalKey: string,
  s: Omit<AscWriteStep<T>, "key" | "session" | "now">,
): Promise<StepResult> {
  const r = await performAscWrite(f.c.db, {
    ...s,
    key: {
      scope: "product",
      product: f.c.product,
      op,
      naturalKey,
      idempotencyKey: f.key,
    },
    session: f.c.session,
    now: f.c.now,
  });
  if (r.outcome === "conflict")
    stop(
      409,
      "idempotency_conflict",
      "this Idempotency-Key was already used for a different request",
    );
  if (r.outcome === "replayed") {
    let ids: Record<string, string> = {};
    try {
      ids = JSON.parse(r.row.result_ids_json ?? "{}") as Record<string, string>;
    } catch {
      /* an unreadable row answers no ids */
    }
    return { outcome: "replayed", opId: r.row.op_id, ids };
  }
  return { outcome: r.outcome, opId: r.opId, ids: r.resultIds };
}

export const stepView = (r: StepResult) => ({
  outcome: r.outcome,
  opId: r.opId,
});

// ── Validation ───────────────────────────────────────────────────────────────────────────────

/** An Apple resource id as a request may name it (ascPath re-checks every segment). */
export const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
export const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

export function idField(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string" || !ID.test(v))
    stop(422, "invalid_body", `${name} is required`, [name]);
  return v;
}

export function textField(
  body: Record<string, unknown>,
  name: string,
  max: number,
): string | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > max)
    stop(
      422,
      "invalid_body",
      `${name} must be text of at most ${max} characters`,
      [name],
    );
  return v;
}

export function localeField(body: Record<string, unknown>): string {
  const v = body.locale;
  if (typeof v !== "string" || !LOCALE.test(v))
    stop(422, "invalid_body", "locale must be a locale code such as en-US", [
      "locale",
    ]);
  return v;
}

// ── Ownership ────────────────────────────────────────────────────────────────────────────────

/** One resource re-read with `include=app` (plus `include`), proven to be the pinned app's. */
export async function proveOwned(
  f: Pick<Flow, "run" | "setup">,
  type: string,
  id: string,
  include: string[],
  reason: string,
  noun: string,
): Promise<{ resource: AscResource; doc: AscDocument }> {
  const doc = await f.run.client.getOrNull(ascPath(type, id), {
    include: ["app", ...include].join(","),
  });
  const resource = single(doc);
  if (!doc || !resource || relId(resource, "app") !== f.setup.appleId)
    stop(404, reason, `no ${noun} ${id} on this app`);
  return { resource, doc };
}
