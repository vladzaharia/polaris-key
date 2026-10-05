/**
 * THE CONSOLE FLOW'S RUNTIME SEAM (A-18j; notes/S-15 §8): what the "Add to storefronts" flow, the
 * Listing page's "Push listing" and Store connections' "Set up" need from a store beyond its
 * declaration (`core/storefront/stores/<store>.ts`).
 *
 * The flow is built from the adapter's DECLARATION: one step per operation it declares, each with
 * its `Support` (API, CI, PR, deep link; `unsupported` ones are left out of the plan and shown on
 * the capability strip). A store's `FlowRuntime` only adds what the declaration cannot know:
 *
 *   - `facts`: which app the product holds on the store (A-16's pin) and the identifiers worth
 *     prefilling, so a deep link renders and a copy card is filled;
 *   - `bind`: for an `api` operation, the console request that performs it (an existing, reviewed
 *     admin route: A-17b's bundle ids, A-17c's setup controls, or this module's generic step route
 *     for a runtime that runs steps itself), and the step's state from the ledger. **An `api`
 *     operation nobody binds is not shown** (the owner's rule: a step whose adapter has not landed
 *     is absent, never "coming soon");
 *   - `verify`: the vendor read that proves a deep-linked step done (Apple's app lookup by bundle
 *     id while the operator creates the record in the portal);
 *   - `runStep`, `appName`, `pushListing`: for a runtime whose writes run here (`admin.ts`'s
 *     generic routes), the write, the store-reported app name a typed confirmation is compared
 *     with, and the listing push.
 *
 * A store with no runtime still appears: its tile, its capability strip, its deep links, CI and PR
 * steps all come from the declaration. Adding a runtime is one file and one line in
 * `FLOW_RUNTIMES` (`index.ts`); the console has no store code.
 *
 * Every request a binding names is under `/manage/api/`, checked when the view is built
 * (`plan.ts`), and every write it reaches is behind its own route's gates: the session, CSRF,
 * the platform-admin check, the store's write gate and its ledger.
 */

import type { Db, Env } from "../../../core/platform.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import type { AdminSession } from "../../../core/adminApi.js";
import type {
  StorefrontAdapter,
  StorefrontOp,
} from "../../../core/storefront/adapter.js";
import type { StoreOperationRow } from "../../../core/storefront/ledger.js";

/** The state a step shows. `todo` has no ledger row; the rest are the row's (or the runtime's). */
export type StepState = "todo" | "pending" | "done" | "failed" | "ambiguous";

export interface FlowContext {
  env: Env;
  db: Db;
  /** The product slug. */
  product: string;
  productName: string;
  hooks: ServiceHooks;
  session: AdminSession;
  now: number;
  /** Test seams for the vendor clients a runtime builds. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The store connection (A-16), in the flow's words. */
export interface StoreConnection {
  /**
   * `connected`: a team credential is configured. `not-configured`: none is, so the store's flow is
   * read-only. `keyless`: the adapter has no team credential (a CI- or PR-plane store).
   */
  state: "connected" | "not-configured" | "keyless";
  /** The A-16 credential slot, when the adapter has one. */
  credential: string | null;
  credentialLabel: string | null;
  source: "console" | "secret" | null;
  /** The last error the store gave the credential, verbatim from A-16 (never a secret). */
  lastError: string | null;
}

/** What the flow knows about one store for one product. */
export interface StoreFacts {
  connection: StoreConnection;
  /** The product's app on the store (A-16's pin), when one is assigned. */
  app: { id: string; name: string | null } | null;
  /** Values a deep link's parameters read (`appId`…). */
  linkParams: Record<string, string>;
  /** Identifiers a step prefills (`bundleId`, `packageName`…), from the product's outlets. */
  identifiers: Record<string, string>;
  /** Outlets of the store's kinds the product declares (the store is live, or about to be). */
  outlets: string[];
}

/** One input a step's request asks for. */
export interface StepField {
  name: string;
  label: string;
  help?: string;
  value: string;
  required: boolean;
  /** A closed set of values (rendered as a select). */
  options?: readonly { value: string; label: string }[];
  maxLength?: number;
}

/**
 * A console request: the method and path of an admin route, its fixed body, the fields the
 * operator fills (merged over the body), and how it is confirmed. `typed` asks for the
 * store-reported app name, sent as `confirm`; the route compares it before anything is sent.
 */
export interface StepRequest {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
  fields: StepField[];
  confirm: "plain" | "typed";
  /** The confirm dialog's title verb and button ("Register the bundle ID"). */
  verb: string;
  consequences: string[];
}

/** What a runtime adds to one step (see the file comment). */
export interface StepBinding {
  /** Another step of the plan covers this operation (two operations on one page). */
  hidden?: boolean;
  label?: string;
  state: StepState;
  stateAt?: number | null;
  /** The request that performs an `api` step. */
  run?: StepRequest;
  /**
   * A console page that owns the step (Apple's submit and release stay on the App Store page's
   * Distribute flow, A-17g, which confirms them typed): the step links there instead of running.
   */
  handoff?: { page: string; label: string };
  /** For an operator-asserted deep-linked step: the request that records "done". */
  assert?: StepRequest;
  /** A follow-up request once the step is done (Apple: assign the app it found to the product). */
  next?: StepRequest;
  /** The values to copy into the store's own console (a deep link's copy card). */
  copy?: { label: string; value: string }[];
  /** One line of what the vendor last said (the re-read, never the request). */
  detail?: string | null;
  /** Why the step cannot run yet (a missing identifier, an earlier step). */
  blockedBy?: string | null;
}

/** What a vendor read found for a deep-linked step. */
export interface VerifyOutcome {
  satisfied: boolean;
  resultIds?: Record<string, string>;
  detail?: string | null;
}

/** A refusal a runtime or a route answers (the console maps `reason`). */
export interface FlowRefusal {
  ok: false;
  status: 404 | 409 | 422 | 428 | 429 | 502;
  reason: string;
  message: string;
  fields?: string[];
}

/** One step's outcome from a runtime's own write. */
export type RunOutcome =
  | {
      ok: true;
      outcome: "written" | "existing" | "replayed";
      opId: string;
      resultIds: Record<string, string>;
      /** The vendor's re-read, projected. */
      after: unknown;
    }
  | FlowRefusal;

/** The rows a binding reads: this product's and the store's team rows. */
export interface LedgerView {
  product: readonly StoreOperationRow[];
  team: readonly StoreOperationRow[];
}

export interface FlowRuntime {
  /** The storefront adapter id. */
  readonly id: string;
  facts?(c: FlowContext, base: StoreFacts): Promise<StoreFacts>;
  bind?(
    c: FlowContext,
    op: StorefrontOp,
    facts: StoreFacts,
    ledger: LedgerView,
  ): Promise<StepBinding | null>;
  verify?(
    c: FlowContext,
    op: StorefrontOp,
    facts: StoreFacts,
    ledger: LedgerView,
  ): Promise<VerifyOutcome | FlowRefusal>;
  /** The app's name as the store reports it now (typed confirmation's phrase). */
  appName?(c: FlowContext, facts: StoreFacts): Promise<string | null>;
  runStep?(
    c: FlowContext,
    op: StorefrontOp,
    input: Record<string, unknown>,
    opts: { idempotencyKey: string; typedConfirmation: boolean },
  ): Promise<RunOutcome>;
  /** "Push listing" (S-15 §8.2): text and assets only, plain confirm, never a review submission. */
  pushListing?: {
    /** The store can stage the push without sending it for review (Play's `changesNotSentForReview`). */
    readonly stageOnly: boolean;
    run(
      c: FlowContext,
      opts: { idempotencyKey: string; stageOnly: boolean },
    ): Promise<RunOutcome>;
  };
}

/** The adapter and runtime pair a view and the routes work over. */
export interface FlowStore {
  adapter: StorefrontAdapter;
  runtime: FlowRuntime | null;
}
