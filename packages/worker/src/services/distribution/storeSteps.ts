/**
 * The report-back of CI- and PR-plane store steps (A-18h, A-18i; notes/S-15 §6.3):
 * `POST /<p>/distribution/report` with `type: "store-step"`, P2-06's ingest, writes the step's row
 * in `store_operations` with `plane = 'ci'` (a vendor CLI command) or `plane = 'pr'` (a pull request
 * to a winget, Homebrew tap, Scoop bucket or Flathub repository, or its verifier), so the ledger
 * and the console show CI and PR steps beside Worker steps.
 *
 * The publish action reports each step twice: `pending` BEFORE the vendor CLI starts (or before
 * anything is written to GitHub), which opens the row (and is where a guard can refuse it), and
 * `done` or `failed` after, with the exit code. The Worker re-checks the command against the
 * store's allow-list (`core/storefront/ciPlane.ts`, `core/storefront/prPlane.ts`) and, for
 * identity-bound parameters, the outlet's identity, so a row never records a command the
 * allow-list refuses, whatever CI sent. A PR step also names the files it wrote (path and
 * SHA-256), each of which must be a path the store's PR plane allows, and the pull request
 * (number, URL on the argv's repository, state, labels), from which the Worker derives the
 * verifier's verdict itself. A refused report writes nothing.
 *
 *   op_id        sha256(JSON [store, 'product', product, op, natural key, runId]) (`storeOpId`)
 *   op           `ci.<command>` (`ci.push`, `ci.upload_metadata`); `pr.pull_request`, `pr.status`
 *   natural key  CI: `<command>:<first 32 hex of sha256(argv)>`; PR: `pr:<package>:<version>`
 *                (S-15 §6.3: an open or merged PR for the package version). The argv itself is
 *                on the row's `after_json` (allow-listed values only: paths, versions, identity
 *                values, the repository)
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
import type { CiAllowList } from "../../core/storefront/ci.js";
import {
  prNaturalKey,
  prPathAllowed,
  prPlaneStore,
  prRepo,
  prVerdict,
  PR_STORE_IDS,
  PR_TOOL,
  type PrPlaneStore,
  type PrVerdict,
} from "../../core/storefront/prPlane.js";
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
/** The most files one PR step may name (winget: version, installer, and up to 50 locales). */
const MAX_PR_FILES = 64;
const MAX_LABELS = 50;
const SHA256_HEX = /^[0-9a-f]{64}$/;
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
  plane: "ci" | "pr";
  /** True when the step was already done under this run: CI skips the tool. */
  replayed: boolean;
  /** A PR step's verdict, derived from the reported pull request (A-18i). */
  verdict?: PrVerdict;
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

/** The ledger op of a PR command: `pr.<command>` with `-` as `_` (`pr.pull_request`). */
export function prStepOp(command: string): string {
  return `pr.${command.replace(/-/g, "_")}`;
}

/** One file a PR step wrote, as reported. */
export interface PrStepFile {
  path: string;
  sha256: string;
}

/** The pull request a PR step opened, found or read, as reported. */
export interface PrStepPull {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  labels: string[];
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

/** The row's projection of a PR step (`stores/prShared.ts`). */
function prProjection(
  command: string,
  argv: readonly string[],
  repo: string,
  files: readonly PrStepFile[] | null,
  pr: PrStepPull | null,
  verdict: PrVerdict | null,
  existing: boolean | null,
  exitCode: number | null,
  runUrl: string | null,
): StoreProjection {
  return {
    type: "pr-step",
    id: command,
    attributes: {
      tool: PR_TOOL,
      command,
      argv: argv.map((a) => a.slice(0, MAX_PROJECTED)),
      repo,
      ...(files !== null ? { files } : {}),
      ...(pr !== null ? { pr } : {}),
      ...(verdict !== null ? { verdict } : {}),
      ...(existing !== null ? { existing } : {}),
      ...(exitCode !== null ? { exitCode } : {}),
      ...(runUrl !== null ? { runUrl } : {}),
    },
  };
}

/** A reported `files` list, or a refusal message. */
function readPrFiles(
  store: PrPlaneStore,
  argv: readonly string[],
  v: unknown,
): PrStepFile[] | string {
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    v.length > MAX_PR_FILES ||
    !v.every(
      (f) =>
        f !== null &&
        typeof f === "object" &&
        typeof (f as PrStepFile).path === "string" &&
        typeof (f as PrStepFile).sha256 === "string" &&
        SHA256_HEX.test((f as PrStepFile).sha256),
    )
  )
    return `files must be 1-${MAX_PR_FILES} { path, sha256 } entries (the SHA-256 of each file's content, lower-case hex)`;
  const files = (v as PrStepFile[]).map((f) => ({
    path: f.path,
    sha256: f.sha256,
  }));
  const bad = files.find((f) => !prPathAllowed(store, argv, f.path));
  if (bad)
    return `${bad.path} is not a path ${store.label}'s PR plane lets this pull request write`;
  if (new Set(files.map((f) => f.path)).size !== files.length)
    return "files names a path twice";
  return files;
}

/** A reported pull request, or a refusal message. Its URL must be on the argv's repository. */
function readPrPull(repo: string, v: unknown): PrStepPull | string {
  const shape =
    "pr must be { number, url (https://github.com/<repo>/pull/<number>), state (open or closed), merged, labels }";
  if (!v || typeof v !== "object" || Array.isArray(v)) return shape;
  const p = v as Record<string, unknown>;
  if (
    !Number.isSafeInteger(p.number) ||
    (p.number as number) < 1 ||
    typeof p.url !== "string" ||
    (p.state !== "open" && p.state !== "closed") ||
    typeof p.merged !== "boolean" ||
    !Array.isArray(p.labels) ||
    p.labels.length > MAX_LABELS ||
    !p.labels.every(
      (l) => typeof l === "string" && l.length > 0 && l.length <= 100,
    )
  )
    return shape;
  if (
    p.url.toLowerCase() !==
    `https://github.com/${repo}/pull/${p.number}`.toLowerCase()
  )
    return `pr.url must be the pull request on ${repo} (https://github.com/${repo}/pull/${p.number})`;
  if (p.merged && p.state !== "closed")
    return "a merged pull request is closed";
  return {
    number: p.number as number,
    url: p.url,
    state: p.state,
    merged: p.merged,
    labels: [...(p.labels as string[])].sort(),
  };
}

/**
 * Whether the ledger shows a Worker-plane draft of `store` for `product`: the newest row of
 * `opens` or `closes` is an open that has not failed.
 */
export async function workerDraftStaged(
  ctx: ReportContext,
  store: string,
  guard: { opens: readonly string[]; closes: readonly string[] },
): Promise<boolean> {
  const ops = [...guard.opens, ...guard.closes];
  if (ops.length === 0) return false;
  const rows = await ctx.db.all<{ op: string; state: StoreOpState }>(
    `SELECT op, state FROM store_operations
      WHERE store = ? AND scope = 'product' AND product = ? AND plane = 'worker'
        AND op IN (${ops.map(() => "?").join(", ")})
      ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    store,
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
  const ciStore =
    typeof body.store === "string" ? ciPlaneStore(body.store) : null;
  const prStore =
    typeof body.store === "string" && !ciStore
      ? prPlaneStore(body.store)
      : null;
  const plane: {
    store: string;
    label: string;
    list: CiAllowList;
    outletKinds: readonly string[];
  } | null = ciStore ?? prStore;
  if (!plane)
    return invalid(
      "store",
      `store must be one of ${[...CI_STORE_IDS, ...PR_STORE_IDS].join(", ")} (a CI- or PR-plane store)`,
    );
  const { list } = plane;
  const planeId: "ci" | "pr" = prStore ? "pr" : "ci";
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
    const declared = prStore
      ? s.mode === "pr" &&
        (
          prStore.commandOps[command as keyof PrPlaneStore["commandOps"]] ?? []
        ).includes(op)
      : s.mode === "ci" && s.commands.includes(command);
    if (!declared)
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

  // A-18i: a PR step's files, pull request and natural-key hit.
  let files: PrStepFile[] | null = null;
  let pr: PrStepPull | null = null;
  let existing: boolean | null = null;
  let repo = "";
  let naturalKey = ciStepNaturalKey(command, args);
  if (prStore) {
    repo = prRepo(prStore, command, args) ?? "";
    naturalKey = prNaturalKey(prStore, command, args) ?? naturalKey;
    if (body.files !== undefined) {
      if (command !== "pull-request")
        return invalid("files", `${command} writes no files`);
      const read = readPrFiles(prStore, args, body.files);
      if (typeof read === "string") return invalid("files", read);
      files = read;
    }
    if (body.pr !== undefined) {
      const read = readPrPull(repo, body.pr);
      if (typeof read === "string") return invalid("pr", read);
      pr = read;
    }
    if (body.existing !== undefined) {
      if (typeof body.existing !== "boolean")
        return invalid("existing", "existing must be a boolean");
      existing = body.existing;
    }
    if (state === "done" && pr === null)
      return invalid(
        "pr",
        `a done ${command} step names its pull request (pr)`,
      );
    if (
      state === "done" &&
      command === "pull-request" &&
      files === null &&
      existing !== true
    )
      return invalid(
        "files",
        "a done pull-request step names the files it wrote, or existing: true when it found the PR already open or merged",
      );
  } else
    for (const field of ["files", "pr", "existing"])
      if (body[field] !== undefined)
        return invalid(field, `a CI-plane step takes no ${field}`);

  const key: StoreOpKey<StoreLedgerId> = {
    store: plane.store as StoreLedgerId,
    scope: "product",
    product: ctx.product,
    op: prStore ? prStepOp(command) : ciStepOp(command),
    naturalKey,
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
    planeId,
  );
  const verdict = prStore && pr ? prVerdict(prStore, pr) : null;
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
      plane: planeId,
      replayed,
      ...(verdict !== null ? { verdict } : {}),
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
  const projection = prStore
    ? prProjection(
        command,
        args,
        repo,
        files,
        pr,
        verdict,
        existing,
        exitCode,
        runUrl,
      )
    : stepProjection(list.tool, command, args, exitCode, runUrl);
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
    prStore && state === "done"
      ? `${list.tool} ${command} on ${repo}: pull request #${pr!.number} ${verdict}${existing ? " (already open or merged)" : ""}`
      : `${list.tool} ${command} ${state === "done" ? "succeeded" : `failed (exit ${exitCode ?? "unknown"})`}`,
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
