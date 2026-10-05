/**
 * The report-back of CI-plane store steps (A-18h; notes/S-15 §6.3): `POST /<p>/distribution/report`
 * with `type: "store-step"`, P2-06's ingest, writes the step's row in `store_operations` with
 * `plane = 'ci'`, so the ledger and the console show CI steps beside Worker steps.
 *
 * The publish action reports each step twice: `pending` BEFORE the vendor CLI starts, which opens
 * the row (and is where a guard can refuse it), and `done` or `failed` after, with the exit code.
 * The Worker re-checks the command against the store's allow-list (`core/storefront/ciPlane.ts`)
 * and, for identity-bound parameters, the outlet's identity, so a row never records a command the
 * allow-list refuses, whatever CI sent. A refused report writes nothing.
 *
 *   op_id        sha256(JSON [store, 'product', product, op, natural key, runId]) (`storeOpId`)
 *   op           `ci.<command>` (`ci.push`, `ci.upload_metadata`)
 *   natural key  `<command>:<first 32 hex of sha256(argv)>`; the argv itself is on the row's
 *                `after_json` (allow-listed values only: paths, versions, identity values)
 *   runId        the job's attempt (`gh-<run id>-<attempt>`) or a fresh id: the idempotency key
 *
 * A `pending` report of a step already `done` under the same run answers it (`replayed: true`) and
 * the CLI skips the tool, so a re-run attempt of the same job does not push twice. A store whose
 * command carries `unlessWorkerStaged` (msstore `publish`) is refused 409 `worker_draft_staged`
 * while the ledger shows that store's Worker-plane draft for the product (S-15 §6.2).
 */

import { createHash } from "node:crypto";
import { appendAudit } from "../../core/data.js";
import { randomId } from "../../core/platform.js";
import { ciActor, type CiPrincipal } from "../../core/ciScope.js";
import {
  STOREFRONT_OPS,
  storefrontAdapter,
  type StorefrontOp,
} from "../../core/storefront/adapter.js";
import { checkCiCommand, type CiIdentity } from "../../core/storefront/ci.js";
import { ciPlaneStore, CI_STORE_IDS } from "../../core/storefront/ciPlane.js";
import {
  beginStoreOperation,
  finishStoreOperation,
  getStoreOperation,
  isIdempotencyKey,
  storeOpId,
  type StoreLedgerId,
  type StoreOpKey,
  type StoreOpState,
} from "../../core/storefront/ledger.js";
import type { StoreProjection } from "../../core/storefront/audit.js";
import type { ReportContext, ReportRefusal } from "./availability.js";
import { getOutlet } from "./outlets.js";

export const STORE_STEP_STATES = ["pending", "done", "failed"] as const;
export type StoreStepState = (typeof STORE_STEP_STATES)[number];

const MAX_ARGV = 32;
const MAX_ARG_LENGTH = 1024;
const MAX_RUN_URL = 512;
/** The most characters of one projected argv value on the row. */
const MAX_PROJECTED = 300;

export interface StoreStepRecord {
  opId: string;
  store: string;
  op: string;
  command: string;
  state: StoreOpState;
  plane: "ci";
  /** True when the step was already done under this run: CI skips the tool. */
  replayed: boolean;
}

export type StoreStepResult =
  | { ok: true; type: "store-step"; step: StoreStepRecord }
  | ReportRefusal;

function refuse(
  status: ReportRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): ReportRefusal {
  return {
    ok: false,
    status,
    code: status === 404 ? "not_found" : "bad_request",
    reason,
    message,
    ...(fields ? { fields } : {}),
  };
}
const invalid = (field: string, message: string) =>
  refuse(422, "invalid_body", message, [field]);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The ledger op of a CI command: `ci.<command>` with `-` as `_`. */
export function ciStepOp(command: string): string {
  return `ci.${command.replace(/-/g, "_")}`;
}

/** The natural key of a step: its command and a digest of its argv. */
export function ciStepNaturalKey(
  command: string,
  argv: readonly string[],
): string {
  return `${command}:${sha256(JSON.stringify(argv)).slice(0, 32)}`;
}

/** The row's before-and-after projection of a CI step (`stores/ciShared.ts`). */
function stepProjection(
  tool: string,
  command: string,
  argv: readonly string[],
  exitCode: number | null,
  runUrl: string | null,
): StoreProjection {
  return {
    type: "ci-step",
    id: command,
    attributes: {
      tool,
      command,
      argv: argv.map((a) => a.slice(0, MAX_PROJECTED)),
      ...(exitCode !== null ? { exitCode } : {}),
      ...(runUrl !== null ? { runUrl } : {}),
    },
  };
}

/**
 * Whether the ledger shows a Worker-plane draft of `store` for `product`: the newest row of
 * `opens` or `closes` is an open that has not failed.
 */
export async function workerDraftStaged(
  ctx: ReportContext,
  store: string,
  guard: {
    workerStore?: string;
    opens: readonly string[];
    closes: readonly string[];
  },
): Promise<boolean> {
  const ops = [...guard.opens, ...guard.closes];
  if (ops.length === 0) return false;
  const rows = await ctx.db.all<{ op: string; state: StoreOpState }>(
    `SELECT op, state FROM store_operations
      WHERE store = ? AND scope = 'product' AND product = ? AND plane = 'worker'
        AND op IN (${ops.map(() => "?").join(", ")})
      ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    guard.workerStore ?? store,
    ctx.product,
    ...ops,
  );
  for (const r of rows) {
    if (guard.closes.includes(r.op)) {
      if (r.state === "done") return false;
      continue;
    }
    if (r.state !== "failed") return true;
  }
  return false;
}

/** Apply one `store-step` report. Validates everything before writing anything. */
export async function reportStoreStep(
  ctx: ReportContext,
  body: Record<string, unknown>,
  principal: CiPrincipal,
): Promise<StoreStepResult> {
  for (const field of ["releaseId", "version", "buildId", "platformRef"])
    if (body[field] !== undefined)
      return invalid(field, `a store-step report takes no ${field}`);
  const plane =
    typeof body.store === "string" ? ciPlaneStore(body.store) : null;
  if (!plane)
    return invalid(
      "store",
      `store must be one of ${CI_STORE_IDS.join(", ")} (a CI-plane store)`,
    );
  const { list } = plane;
  const command = body.command;
  if (typeof command !== "string" || !Object.hasOwn(list.commands, command))
    return refuse(
      422,
      "command_not_allowed",
      `${plane.label}'s allow-list has no command ${JSON.stringify(command)} (${Object.keys(list.commands).join(", ")})`,
      ["command"],
    );
  const op = body.op;
  if (
    typeof op !== "string" ||
    !(STOREFRONT_OPS as readonly string[]).includes(op)
  )
    return invalid("op", "op must be a storefront operation");
  // A registered adapter declares which operation runs which command.
  const adapter = storefrontAdapter(plane.store);
  if (adapter) {
    const s = adapter.capabilities.ops[op as StorefrontOp];
    if (s.mode !== "ci" || !s.commands.includes(command))
      return refuse(
        422,
        "command_not_allowed",
        `${adapter.label} does not run ${command} for ${op}`,
        ["op", "command"],
      );
  }
  const argv = body.argv;
  if (
    !Array.isArray(argv) ||
    argv.length > MAX_ARGV ||
    !argv.every(
      (a) =>
        typeof a === "string" && a.length > 0 && a.length <= MAX_ARG_LENGTH,
    )
  )
    return invalid(
      "argv",
      `argv must be at most ${MAX_ARGV} non-empty strings (the tool's arguments, the tool excluded)`,
    );
  const args = argv as string[];
  const rule = list.commands[command]!;
  const bound = rule.argv.some((a) => typeof a !== "string" && a.identity);
  let identity: CiIdentity | undefined;
  let outlet: string | null = null;
  if (body.outlet !== undefined || bound) {
    if (typeof body.outlet !== "string" || body.outlet === "")
      return invalid(
        "outlet",
        `outlet is required: ${command} is bound to the outlet's identity`,
      );
    const row = await getOutlet(ctx.db, ctx.product, body.outlet);
    if (!row || row.removed_at !== null)
      return refuse(
        404,
        "unknown_outlet",
        `no outlet ${body.outlet} on ${ctx.product}`,
      );
    if (!plane.outletKinds.includes(row.kind))
      return refuse(
        422,
        "invalid_body",
        `outlet ${body.outlet} is ${row.kind}, not a ${plane.label} outlet`,
        ["outlet"],
      );
    outlet = body.outlet;
    try {
      identity = JSON.parse(row.identity_json) as CiIdentity;
    } catch {
      identity = {};
    }
  }
  const refusal = checkCiCommand(list, command, args, identity);
  if (refusal)
    return refuse(
      422,
      "command_not_allowed",
      `${list.tool} ${args.join(" ")} is not ${command} as ${plane.label}'s allow-list declares it (${refusal})`,
      ["argv"],
    );
  const runId = body.runId;
  if (!isIdempotencyKey(runId))
    return invalid(
      "runId",
      "runId must be 8-128 letters, digits and hyphens (the job attempt)",
    );
  const state = body.state;
  if (
    typeof state !== "string" ||
    !(STORE_STEP_STATES as readonly string[]).includes(state)
  )
    return refuse(
      422,
      "invalid_state",
      `state must be one of ${STORE_STEP_STATES.join(", ")}`,
      ["state"],
    );
  let exitCode: number | null = null;
  if (body.exitCode !== undefined) {
    if (
      !Number.isSafeInteger(body.exitCode) ||
      (body.exitCode as number) < -1 ||
      (body.exitCode as number) > 1_000_000
    )
      return invalid("exitCode", "exitCode must be an integer");
    exitCode = body.exitCode as number;
  }
  if (state === "failed" && exitCode === 0)
    return invalid("exitCode", "a failed step has a non-zero exit code");
  if (state === "done" && exitCode !== null && exitCode !== 0)
    return invalid("exitCode", "a done step exited 0");
  let runUrl: string | null = null;
  if (body.runUrl !== undefined) {
    if (
      typeof body.runUrl !== "string" ||
      body.runUrl.length > MAX_RUN_URL ||
      !/^https:\/\/[^\s@]+$/.test(body.runUrl)
    )
      return invalid("runUrl", "runUrl must be an https URL of the run");
    runUrl = body.runUrl;
  }

  const key: StoreOpKey<StoreLedgerId> = {
    store: plane.store,
    scope: "product",
    product: ctx.product,
    op: ciStepOp(command),
    naturalKey: ciStepNaturalKey(command, args),
    idempotencyKey: runId,
  };
  // The guard reads the ledger before the step opens its row: on the pending report, and on a
  // done or failed report that opens a row of its own (no pending report came first), so a
  // client cannot skip it by reporting the outcome straight away.
  if (rule.unlessWorkerStaged) {
    const opens =
      state === "pending" ||
      (await getStoreOperation(ctx.db, await storeOpId(key))) === null;
    if (
      opens &&
      (await workerDraftStaged(ctx, plane.store, rule.unlessWorkerStaged))
    )
      return refuse(
        409,
        "worker_draft_staged",
        `${plane.label} has a draft the console staged for ${ctx.product}; commit or discard it in the console before ${list.tool} ${command} runs`,
      );
  }

  const request = { store: plane.store, op, command, argv: args, outlet };
  const actor = ciActor(principal);
  const begun = await beginStoreOperation(
    ctx.db,
    key,
    request,
    actor,
    ctx.now,
    "ci",
  );
  const record = (
    opId: string,
    rowState: StoreOpState,
    replayed: boolean,
  ): StoreStepResult => ({
    ok: true,
    type: "store-step",
    step: {
      opId,
      store: plane.store,
      op,
      command,
      state: rowState,
      plane: "ci",
      replayed,
    },
  });
  if (begun.kind === "conflict")
    return refuse(
      409,
      "step_conflict",
      "this run already reported a different request under the same step",
    );
  if (begun.kind === "replay") return record(begun.row.op_id, "done", true);
  const { opId } = begun;
  if (state === "pending") {
    if (!begun.resumed)
      await auditStep(
        ctx,
        principal,
        plane.store,
        key.op,
        opId,
        `${list.tool} ${command} started`,
      );
    return record(opId, "pending", false);
  }
  const projection = stepProjection(list.tool, command, args, exitCode, runUrl);
  if (state === "done")
    await finishStoreOperation(
      ctx.db,
      opId,
      { state: "done", resultIds: {}, before: null, after: projection },
      ctx.now,
    );
  else
    await finishStoreOperation(
      ctx.db,
      opId,
      {
        state: "failed",
        vendorStatus: exitCode,
        vendorCode: "exit_code",
      },
      ctx.now,
    );
  if (state === "failed")
    await ctx.db.run(
      "UPDATE store_operations SET after_json = ? WHERE op_id = ?",
      JSON.stringify(projection),
      opId,
    );
  await auditStep(
    ctx,
    principal,
    plane.store,
    key.op,
    opId,
    `${list.tool} ${command} ${state === "done" ? "succeeded" : `failed (exit ${exitCode ?? "unknown"})`}`,
  );
  const row = await getStoreOperation(ctx.db, opId);
  return record(opId, row?.state ?? (state as StoreOpState), false);
}

async function auditStep(
  ctx: ReportContext,
  principal: CiPrincipal,
  store: string,
  op: string,
  opId: string,
  summary: string,
): Promise<void> {
  await appendAudit(ctx.db, {
    product: ctx.product,
    id: randomId("aud"),
    at: ctx.now,
    actor_sub: ciActor(principal),
    actor_name: "CI",
    actor_email: null,
    action: `distribution.${store}.${op}`,
    target_kind: "store_operation",
    target_id: opId,
    parent_id: null,
    summary: `${summary} [op ${opId.slice(0, 12)}]`,
  });
}
