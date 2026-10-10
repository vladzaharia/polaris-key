/// <reference types="@cloudflare/workers-types" />

/**
 * The storefront flow's admin surface (A-18j; notes/S-15 §8) —
 * `/manage/api/products/<slug>/distribution/storefronts…`:
 *
 *     GET  …/distribution/storefronts                       every storefront: connection, app,
 *                                                           capabilities, prerequisites and plan
 *                                                           (`plan.ts`), and the listing's name
 *                                                           and default locale for copy cards
 *     POST …/distribution/storefronts/<store>/steps/<op>    run an `api` step through the store's
 *                                                           runtime (`runStep`): `{input?,
 *                                                           confirm?}` + `Idempotency-Key`; a
 *                                                           submit, release or price step is
 *                                                           typed (the store-reported app name in
 *                                                           `confirm`, compared before anything
 *                                                           is sent)
 *     POST …/distribution/storefronts/<store>/steps/<op>/check
 *                                                           a deep-linked step: `{}` runs its
 *                                                           verifier read (`poll: true` while the
 *                                                           page polls is advisory: the server
 *                                                           treats it as `{}`), `{assert: true}` records
 *                                                           an operator-asserted step done
 *     POST …/distribution/storefronts/<store>/push-listing  "Push listing" (`{stageOnly?}` +
 *                                                           `Idempotency-Key`), through the
 *                                                           store's runtime; always staged
 *                                                           where the store stages
 *
 * Most `api` steps do not come here: a binding names the reviewed route that performs them (A-17b
 * bundle ids, A-17c setup controls), and the console calls that route. These routes exist for what
 * no other route serves: the plan itself, a deep-linked step's state, and the runtimes whose
 * writes run in this module.
 *
 * A deep-linked step's state is ONE ledger row per (store, product, step) in `store_operations`
 * (`plane = 'deep-link'`, op `flow.<op>`): `pending` from the first check (it survives a closed
 * tab), `done` once the vendor read shows the result (its ids kept) or the operator asserts it.
 * Each flip to done is audited (`distribution.storefronts.verify` / `.assert`); a runtime's writes
 * are audited by its own ledger steps (`performStoreWrite`).
 *
 * Narrative-only (rule 10, `routeCoverage`'s `adminApi` kind); session, CSRF, rate limit and the
 * platform-admin gate run in `admin/api.ts` first.
 */

import { ErrorCode } from "../../../core/errors.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../admin/session.js";
import { adminJson, err, readBody } from "../../../admin/lib/respond.js";
import { audit } from "../../../admin/audit.js";
import { typedConfirmationRefusal } from "../../../core/storefront/confirm.js";
import {
  beginStoreOperation,
  finishStoreOperation,
  isIdempotencyKey,
} from "../../../core/storefront/ledger.js";
import {
  TYPED_OPS,
  type StorefrontId,
} from "../../../core/storefront/adapter.js";
import { readListing } from "../listing/store.js";
import { flowStores } from "./index.js";
import { handleSlotsAdmin } from "./slots.js";
import {
  baseFacts,
  factLink,
  flowOp,
  isPlanOp,
  ledgerOf,
  OP_LABELS,
  storeView,
} from "./plan.js";
import type {
  FlowContext,
  FlowRefusal,
  FlowStore,
  FollowUpView,
  RunOutcome,
  StoreFacts,
} from "./runtime.js";

type AdminCtx = ServiceContext & { session: AdminSession };

/** A deep-linked step's row is keyed by store, product and step alone: one per step. */
const FLOW_STATE_KEY = "flow-step-state";

function flowCtx(ctx: AdminCtx): FlowContext {
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    productName: ctx.product.name,
    hooks: ctx.hooks,
    session: ctx.session,
    now: ctx.now,
  };
}

/**
 * A run's outcome as the console receives it: a follow-up's deep-link row is rendered from the
 * product's facts (the same rendering as a deep-linked step), so the console shows the link and
 * the count, or which parameters the link still lacks.
 */
function withFollowUp(
  r: Extract<RunOutcome, { ok: true }>,
  facts: StoreFacts,
): Omit<Extract<RunOutcome, { ok: true }>, "followUp"> & {
  followUp?: FollowUpView;
} {
  const { followUp, ...rest } = r;
  if (!followUp) return rest;
  return {
    ...rest,
    followUp: {
      count: followUp.count,
      text: followUp.text,
      ...factLink(followUp.link, facts),
    },
  };
}

function refusal(r: FlowRefusal): Response {
  return err(r.status, r.reason, r.message, {
    reason: r.reason,
    ...(r.fields ? { fields: r.fields } : {}),
  });
}

const notAllowed = () => err(405, ErrorCode.BadRequest, "method not allowed");
const unknownStore = () =>
  err(404, "not_found", "no such storefront", { reason: "unknown_store" });
const unknownStep = () =>
  err(404, "not_found", "no such step for this storefront", {
    reason: "unknown_step",
  });

/** Distribution's `storefronts` admin routes; `null` when the path is not one. */
export async function handleStorefrontsAdmin(
  ctx: AdminCtx,
  stores: readonly FlowStore[] = flowStores(),
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest[0] !== "storefronts") return null;
  // The slot board is the flow's, not a store's (no adapter is called `slots`).
  if (rest[1] === "slots") return handleSlotsAdmin(ctx);
  if (rest.length === 1) {
    if (req.method !== "GET") return notAllowed();
    return view(ctx, stores);
  }
  const store = stores.find((s) => s.adapter.id === rest[1]);
  if (!store) return unknownStore();
  if (rest.length === 3 && rest[2] === "push-listing")
    return req.method === "POST" ? pushListing(ctx, store) : notAllowed();
  if (rest[2] !== "steps" || (rest.length !== 4 && rest.length !== 5))
    return null;
  const op = rest[3]!;
  if (!isPlanOp(op)) return unknownStep();
  if (rest.length === 5 && rest[4] !== "check") return null;
  if (req.method !== "POST") return notAllowed();
  return rest.length === 5 ? check(ctx, store, op) : run(ctx, store, op);
}

async function view(
  ctx: AdminCtx,
  stores: readonly FlowStore[],
): Promise<Response> {
  const c = flowCtx(ctx);
  const stored = await readListing(ctx.db, ctx.product.slug);
  const out = [];
  for (const s of stores) out.push(await storeView(c, s));
  return adminJson({
    stores: out,
    listing: stored
      ? {
          name: stored.model.app.name ?? null,
          defaultLocale: stored.model.app.defaultLocale,
          locales: stored.locales.map((l) => l.locale),
        }
      : null,
  });
}

function idempotencyKey(req: Request): string | Response {
  const k = req.headers.get("idempotency-key");
  return isIdempotencyKey(k)
    ? k
    : err(
        428,
        "idempotency_key_required",
        "send an Idempotency-Key header (a UUID per intent): a retry with the same key replays instead of writing twice",
        { reason: "idempotency_key_required" },
      );
}

async function run(
  ctx: AdminCtx,
  { adapter, runtime }: FlowStore,
  op: Parameters<typeof isPlanOp>[0] & keyof typeof OP_LABELS,
): Promise<Response> {
  const support = adapter.capabilities.ops[op];
  if (!runtime?.runStep || support.mode !== "api") return unknownStep();
  const key = idempotencyKey(ctx.req);
  if (typeof key !== "string") return key;
  const body = await readBody(ctx.req);
  const input =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
  const c = flowCtx(ctx);
  let facts = await baseFacts(c, adapter);
  if (runtime.facts) facts = await runtime.facts(c, facts);
  if (facts.connection.state === "not-configured")
    return err(
      409,
      "not_configured",
      `${adapter.label} has no team connection`,
      {
        reason: "not_configured",
      },
    );
  const binding = runtime.bind
    ? await runtime.bind(c, op, facts, await ledgerOf(c, adapter.id))
    : null;
  if (!binding?.run) return unknownStep();
  if (binding.blockedBy)
    return err(409, "step_blocked", binding.blockedBy, {
      reason: "step_blocked",
    });
  // Submit, release and a price change are typed on every store (owner rule; S-15 §6.4).
  const typed = binding.run.confirm === "typed" || TYPED_OPS.includes(op);
  if (typed) {
    const phrase = runtime.appName ? await runtime.appName(c, facts) : null;
    const refused = typedConfirmationRefusal(
      body.confirm,
      phrase,
      OP_LABELS[op].toLowerCase(),
      adapter.confirmation,
    );
    if (refused)
      return err(refused.status, refused.reason, refused.message, {
        reason: refused.reason,
        fields: [...refused.fields],
      });
  }
  const r = await runtime.runStep(c, op, input, {
    idempotencyKey: key,
    typedConfirmation: typed,
    ...(typed && typeof body.confirm === "string"
      ? { confirm: body.confirm.trim() }
      : {}),
  });
  if (!r.ok) return refusal(r);
  return adminJson(withFollowUp(r, facts));
}

async function check(
  ctx: AdminCtx,
  { adapter, runtime }: FlowStore,
  op: Parameters<typeof isPlanOp>[0] & keyof typeof OP_LABELS,
): Promise<Response> {
  const support = adapter.capabilities.ops[op];
  if (support.mode !== "deep-link") return unknownStep();
  const body = await readBody(ctx.req);
  const assert = body.assert === true;
  const c = flowCtx(ctx);
  let facts = await baseFacts(c, adapter);
  if (runtime?.facts) facts = await runtime.facts(c, facts);
  const ledger = await ledgerOf(c, adapter.id);
  const binding = runtime?.bind
    ? await runtime.bind(c, op, facts, ledger)
    : null;
  if (binding?.hidden) return unknownStep();
  const operatorAsserted =
    support.verify === "operator-assertion" || !runtime?.verify;
  if (assert) {
    // A store that records its own assertion (Apple's checklist) is asked through that route.
    if (binding?.assert)
      return err(
        409,
        "use_step_request",
        "this step is recorded through its own request",
        {
          reason: "use_step_request",
        },
      );
    if (!operatorAsserted)
      return err(
        422,
        "verified_by_read",
        `${adapter.label} is read to confirm this step: check it instead`,
        { reason: "verified_by_read" },
      );
  } else if (operatorAsserted)
    return err(
      422,
      "not_verifiable",
      "this step is confirmed by you, not by a read",
      {
        reason: "not_verifiable",
      },
    );
  if (facts.connection.state === "not-configured")
    return err(
      409,
      "not_configured",
      `${adapter.label} has no team connection`,
      {
        reason: "not_configured",
      },
    );

  const key = {
    store: adapter.id as StorefrontId,
    scope: "product" as const,
    product: ctx.product.slug,
    op: flowOp(op),
    naturalKey: op,
    idempotencyKey: FLOW_STATE_KEY,
  };
  const begin = await beginStoreOperation(
    ctx.db,
    key,
    { op },
    ctx.session.sub,
    ctx.now,
    "deep-link",
  );
  if (begin.kind === "replay")
    return adminJson({ ok: true, state: "done", satisfied: true });
  if (begin.kind === "conflict")
    return err(
      409,
      "idempotency_conflict",
      "the step's state row is inconsistent",
      {
        reason: "idempotency_conflict",
      },
    );

  const label = OP_LABELS[op].toLowerCase();
  if (assert) {
    await finishStoreOperation(
      ctx.db,
      begin.opId,
      { state: "done", resultIds: {}, before: null, after: null },
      ctx.now,
    );
    await audit(
      ctx.db,
      ctx.product.slug,
      ctx.session,
      ctx.now,
      "distribution.storefronts.assert",
      { kind: "storefront", id: `${adapter.id}:${op}` },
      `Marked ${label} done in ${adapter.label} (operator assertion)`,
    );
    return adminJson({ ok: true, state: "done", satisfied: true });
  }

  const outcome = await runtime!.verify!(c, op, facts, ledger);
  if ("ok" in outcome) return refusal(outcome);
  if (!outcome.satisfied)
    return adminJson({
      ok: true,
      state: "pending",
      satisfied: false,
      detail: outcome.detail ?? null,
    });
  await finishStoreOperation(
    ctx.db,
    begin.opId,
    {
      state: "done",
      resultIds: outcome.resultIds ?? {},
      before: null,
      after: null,
    },
    ctx.now,
  );
  await audit(
    ctx.db,
    ctx.product.slug,
    ctx.session,
    ctx.now,
    "distribution.storefronts.verify",
    { kind: "storefront", id: `${adapter.id}:${op}` },
    `${adapter.label} shows the ${label} done`,
  );
  return adminJson({
    ok: true,
    state: "done",
    satisfied: true,
    resultIds: outcome.resultIds ?? {},
    detail: outcome.detail ?? null,
  });
}

async function pushListing(
  ctx: AdminCtx,
  { adapter, runtime }: FlowStore,
): Promise<Response> {
  if (!runtime?.pushListing)
    return err(404, "not_found", `${adapter.label} has no listing push`, {
      reason: "unsupported",
    });
  const key = idempotencyKey(ctx.req);
  if (typeof key !== "string") return key;
  const body = await readBody(ctx.req);
  if (body.stageOnly !== undefined && typeof body.stageOnly !== "boolean")
    return err(422, ErrorCode.BadRequest, "stageOnly must be a boolean", {
      fields: ["stageOnly"],
    });
  // A push is never a review submission (S-15 §8.2): where the store stages, it always stages,
  // and sending for review stays the typed `submit` step.
  if (body.stageOnly === false && runtime.pushListing.stageOnly)
    return err(
      422,
      ErrorCode.BadRequest,
      `a listing push to ${adapter.label} is always staged: send it for review with the typed submit step`,
      { fields: ["stageOnly"] },
    );
  if (body.stageOnly === true && !runtime.pushListing.stageOnly)
    return err(
      422,
      ErrorCode.BadRequest,
      `${adapter.label} has no staged push`,
      { fields: ["stageOnly"] },
    );
  const c = flowCtx(ctx);
  let facts = await baseFacts(c, adapter);
  if (runtime.facts) facts = await runtime.facts(c, facts);
  if (facts.connection.state === "not-configured")
    return err(
      409,
      "not_configured",
      `${adapter.label} has no team connection`,
      {
        reason: "not_configured",
      },
    );
  const r = await runtime.pushListing.run(c, {
    idempotencyKey: key,
    stageOnly: runtime.pushListing.stageOnly,
  });
  if (!r.ok) return refusal(r);
  return adminJson(withFollowUp(r, facts));
}
