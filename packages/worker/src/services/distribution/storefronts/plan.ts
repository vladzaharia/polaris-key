/**
 * THE FLOW VIEW, BUILT FROM DECLARATIONS (A-18j; notes/S-15 §8.1). For each storefront adapter:
 * its connection (A-16), the product's app, a capability strip (one entry per operation, from the
 * adapter's `Support`), the prerequisites, and the plan: the ordered steps the flow runs, each
 * with its mode, the external writes it makes (for the review step), its state from the ledger and
 * what the console does to perform it.
 *
 * Nothing here names a store. A runtime (`runtime.ts`) adds facts and bindings; a store without
 * one gets every step its declaration can describe on its own (deep links, CI, PR) and none of the
 * `api` steps, which need a binding to run.
 */

import type { Support } from "../../../core/adapters/contract.js";
import {
  READ_OPS,
  TYPED_OPS,
  type StorefrontAdapter,
  type StorefrontOp,
} from "../../../core/storefront/adapter.js";
import {
  deepLink,
  renderDeepLink,
} from "../../../core/storefront/deeplinks.js";
import {
  listStoreOperations,
  type StoreOperationRow,
} from "../../../core/storefront/ledger.js";
import {
  LISTING_STORES,
  type ListingStore,
} from "../../../core/storefront/listingProfiles.js";
import {
  isPlatformCredentialId,
  platformCredentialStatus,
  platformPin,
  PLATFORM_CREDENTIALS,
  resolvePlatformCredential,
} from "../../../core/platformCredentials.js";
import { peekPlatformAppName } from "../connectors/platformApps.js";
import { listOutlets, parseJsonColumn } from "../outlets.js";
import type {
  FlowContext,
  FlowStore,
  LedgerView,
  StepBinding,
  StepRequest,
  StepState,
  StoreConnection,
  StoreFacts,
} from "./runtime.js";

/** The flow's phases, in order (S-15 §8.1 steps 5–7). */
export type StepPhase = "setup" | "listing" | "assets" | "store" | "submit";

/** The operations a plan is made of, in run order, with their phase. Read-only ones are absent. */
export const PLAN_OPS: readonly { op: StorefrontOp; phase: StepPhase }[] = [
  { op: "identifiers", phase: "setup" },
  { op: "createApp", phase: "setup" },
  { op: "notificationsUrl", phase: "setup" },
  { op: "writeListingText", phase: "listing" },
  { op: "category", phase: "listing" },
  { op: "contentRating", phase: "listing" },
  { op: "privacyDeclarations", phase: "listing" },
  { op: "writeListingAssets", phase: "assets" },
  { op: "pricing", phase: "store" },
  { op: "iap", phase: "store" },
  { op: "testers", phase: "store" },
  { op: "uploadBuild", phase: "store" },
  { op: "submit", phase: "submit" },
  { op: "release", phase: "submit" },
  { op: "rollout", phase: "submit" },
];

/** Every operation's name in the console (sentence case, ADMIN.md §5.8). */
export const OP_LABELS: Readonly<Record<StorefrontOp, string>> = {
  connect: "Connection check",
  listApps: "App list",
  identifiers: "Identifiers",
  createApp: "App record",
  readListing: "Listing import",
  writeListingText: "Listing text",
  writeListingAssets: "Listing images",
  category: "Category",
  contentRating: "Content rating",
  privacyDeclarations: "Privacy declarations",
  pricing: "Price and availability",
  iap: "In-app purchases",
  testers: "Testers",
  uploadBuild: "Build upload",
  notificationsUrl: "Store notifications",
  submit: "Submit for review",
  release: "Release",
  rollout: "Staged rollout",
  status: "Review and release status",
};

/** One capability: an operation and how the adapter performs it (its `Support`, as declared). */
export interface CapabilityView {
  op: StorefrontOp;
  label: string;
  support: Support;
}

export interface PrerequisiteView {
  id: string;
  label: string;
  /** `met`, `unmet`, or `unknown` (only a write proves it: Play's "Manage store presence"). */
  state: "met" | "unmet" | "unknown";
  detail: string;
  /** A console page that fixes it (`platform-stores`). */
  page: string | null;
}

/** One step of a store's plan. */
export interface FlowStepView {
  /** The step's id: its (first) operation. */
  id: StorefrontOp;
  /** Every operation the step covers (deep-linked operations on one page merge). */
  ops: StorefrontOp[];
  phase: StepPhase;
  label: string;
  mode: Support["mode"];
  /** Typed confirmation applies (submit, release, a price change; owner rule). */
  typed: boolean;
  state: StepState;
  stateAt: number | null;
  /** The external writes the step makes, as the review step lists them. */
  writes: string[];
  link: {
    url: string | null;
    /** `read`: the console polls the step's check while the page is open. */
    verify: "read" | "operator-assertion";
    every: number | null;
    until: number | null;
    /** The link's parameters the product does not have yet (`appId` before an app is assigned). */
    missing: string[];
  } | null;
  ci: { tool: string; commands: string[] } | null;
  pr: { repo: string } | null;
  run: StepRequest | null;
  assert: StepRequest | null;
  next: StepRequest | null;
  handoff: { page: string; label: string } | null;
  copy: { label: string; value: string }[];
  detail: string | null;
  blockedBy: string | null;
}

export interface StoreFlowView {
  id: string;
  label: string;
  /** The listing column the store's fit report row is (`play` for Google Play). */
  listingStore: ListingStore | null;
  connection: StoreConnection;
  app: { id: string; name: string | null } | null;
  outlets: string[];
  /** Why the store's flow is read-only, or null. */
  readOnly: string | null;
  capabilities: CapabilityView[];
  prerequisites: PrerequisiteView[];
  steps: FlowStepView[];
  /** "Push listing" (Listing page), when the store's runtime performs it. */
  pushListing: { stageOnly: boolean } | null;
  /** The store's name in typed confirmations ("the app's name in <label>"). */
  confirmationLabel: string;
}

// ── facts ────────────────────────────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The listing column a store's adapter projects to: its id, or one of its outlet kinds. */
export function listingStoreOf(
  adapter: StorefrontAdapter,
): ListingStore | null {
  return (
    LISTING_STORES.find(
      (s) =>
        s === adapter.id ||
        (adapter.outletKinds as readonly string[]).includes(s),
    ) ?? null
  );
}

/** The facts every store has: the connection, the pin, the product's outlets of its kinds. */
export async function baseFacts(
  c: FlowContext,
  adapter: StorefrontAdapter,
): Promise<StoreFacts> {
  const kinds = adapter.outletKinds as readonly string[];
  const outlets = (await listOutlets(c.db, c.product)).filter(
    (o) => o.removed_at === null && kinds.includes(o.kind),
  );
  const identifiers: Record<string, string> = {};
  for (const o of outlets) {
    const id = parseJsonColumn(o.identity_json);
    if (!id || typeof id !== "object" || Array.isArray(id)) continue;
    for (const [k, v] of Object.entries(id as Record<string, unknown>))
      if (typeof v === "string" && IDENT.test(v) && !(k in identifiers))
        identifiers[k] = v;
  }
  const cred = adapter.credential;
  if (cred === null || !isPlatformCredentialId(cred))
    return {
      connection: {
        state: "keyless",
        credential: null,
        credentialLabel: null,
        source: null,
        lastError: null,
      },
      app: null,
      linkParams: {},
      identifiers,
      outlets: outlets.map((o) => o.outlet_id),
    };
  const status = await platformCredentialStatus(c.env, c.db, cred);
  const ref = await resolvePlatformCredential(c.env, c.db, cred);
  const pin = await platformPin(c.db, cred, c.product);
  const app = pin
    ? {
        id: pin,
        // The name from A-16's cached app listing only: building the view calls no store.
        name: ref
          ? await peekPlatformAppName(
              c.env,
              PLATFORM_CREDENTIALS[cred].store,
              ref.version,
              pin,
            )
          : null,
      }
    : null;
  return {
    connection: {
      state: status.configured ? "connected" : "not-configured",
      credential: cred,
      credentialLabel: status.label,
      source: status.source,
      lastError: status["console"].lastError,
    },
    app,
    linkParams: pin ? { appId: pin } : {},
    identifiers,
    outlets: outlets.map((o) => o.outlet_id),
  };
}

// ── ledger ───────────────────────────────────────────────────────────────────────────────────

/** The product's and the team's newest rows for one store. */
export async function ledgerOf(
  c: FlowContext,
  store: string,
): Promise<LedgerView> {
  const id = store as Parameters<typeof listStoreOperations>[3];
  return {
    product: await listStoreOperations(
      c.db,
      { scope: "product", product: c.product },
      200,
      id,
    ),
    team: await listStoreOperations(c.db, { scope: "team" }, 200, id),
  };
}

/** The op name of a deep-linked step's ledger row (written by `admin.ts`'s check route). */
export const flowOp = (op: string): string =>
  `flow.${op.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`;

/** A CI step's ledger op (A-18h's report-back writes `ci.<command>`). */
export const ciOp = (command: string): string =>
  `ci.${command.replace(/-/g, "_")}`;

/** The state of the newest row among `rows` matching `match`. */
export function stateOf(
  rows: readonly StoreOperationRow[],
  match: (r: StoreOperationRow) => boolean,
): { state: StepState; at: number | null } {
  const row = rows.find(match);
  if (!row) return { state: "todo", at: null };
  return { state: row.state, at: row.finished_at ?? row.created_at };
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────

const API_PREFIX = "/manage/api/";

/** A request a binding names must stay on the console API. */
function checkRequest(r: StepRequest | undefined): StepRequest | null {
  if (!r) return null;
  if (!r.path.startsWith(API_PREFIX) || r.path.includes(".."))
    throw new Error(`a flow step may only call the console API: ${r.path}`);
  return r;
}

function writesOf(adapter: StorefrontAdapter, support: Support): string[] {
  switch (support.mode) {
    case "api":
      return [...support.rules];
    case "ci":
      return support.commands.map((cmd) => `${support.tool} ${cmd}`);
    case "pr":
      return [`a pull request to ${support.repo}`];
    case "deep-link":
      return [];
    case "unsupported":
      return [];
  }
  void adapter;
  return [];
}

/** A deep-link row rendered from the product's facts, or the parameters it still lacks. */
export function factLink(
  id: string,
  facts: StoreFacts,
): { url: string | null; missing: string[] } {
  const row = deepLink(id);
  const params = row?.params ?? [];
  const missing = params.filter((p) => !(p in facts.linkParams));
  let url: string | null = null;
  if (row && missing.length === 0) {
    try {
      url = renderDeepLink(
        row.id,
        Object.fromEntries(params.map((p) => [p, facts.linkParams[p]!])),
      );
    } catch {
      url = null;
    }
  }
  return { url, missing };
}

function linkOf(
  support: Extract<Support, { mode: "deep-link" }>,
  facts: StoreFacts,
): FlowStepView["link"] {
  const { url, missing } = factLink(support.link, facts);
  const v = support.verify;
  return {
    url,
    verify: v === "operator-assertion" ? "operator-assertion" : "read",
    every: v === "operator-assertion" ? null : v.every,
    until: v === "operator-assertion" ? null : v.until,
    missing,
  };
}

/** One store's view: connection, capabilities, prerequisites and plan. */
export async function storeView(
  c: FlowContext,
  { adapter, runtime }: FlowStore,
): Promise<StoreFlowView> {
  let facts = await baseFacts(c, adapter);
  if (runtime?.facts) facts = await runtime.facts(c, facts);
  const ledger = await ledgerOf(c, adapter.id);
  const ops = adapter.capabilities.ops;

  const capabilities: CapabilityView[] = (
    Object.keys(OP_LABELS) as StorefrontOp[]
  )
    .filter((op) => op in ops)
    .map((op) => ({ op, label: OP_LABELS[op], support: ops[op] }));

  const steps: FlowStepView[] = [];
  const byLink = new Map<string, FlowStepView>();
  for (const { op, phase } of PLAN_OPS) {
    const support = ops[op];
    if (!support || support.mode === "unsupported") continue;
    const binding: StepBinding | null = runtime?.bind
      ? await runtime.bind(c, op, facts, ledger)
      : null;
    if (binding?.hidden) continue;
    // An `api` operation nothing binds has no way to run here: it is not shown.
    if (support.mode === "api" && !binding?.run && !binding?.handoff) continue;
    if (support.mode === "deep-link") {
      const merged = byLink.get(support.link);
      if (merged && !binding) {
        merged.ops.push(op);
        merged.label = `${merged.label}, ${OP_LABELS[op].toLowerCase()}`;
        continue;
      }
    }
    let state: { state: StepState; at: number | null };
    if (binding) state = { state: binding.state, at: binding.stateAt ?? null };
    else if (support.mode === "ci") {
      const names = support.commands.map(ciOp);
      state = stateOf(
        ledger.product,
        (r) => r.plane === "ci" && names.includes(r.op),
      );
    } else if (support.mode === "pr")
      state = stateOf(ledger.product, (r) => r.plane === "pr");
    else
      state = stateOf(
        ledger.product,
        (r) => r.plane === "deep-link" && r.op === flowOp(op),
      );
    const step: FlowStepView = {
      id: op,
      ops: [op],
      phase,
      label: binding?.label ?? OP_LABELS[op],
      mode: support.mode,
      typed:
        binding?.run?.confirm === "typed" ||
        (TYPED_OPS.includes(op) && !binding?.handoff && support.mode === "api"),
      state: state.state,
      stateAt: state.at,
      writes: writesOf(adapter, support),
      link: support.mode === "deep-link" ? linkOf(support, facts) : null,
      ci:
        support.mode === "ci"
          ? { tool: support.tool, commands: [...support.commands] }
          : null,
      pr: support.mode === "pr" ? { repo: support.repo } : null,
      run: checkRequest(binding?.run),
      assert: checkRequest(binding?.assert),
      next: checkRequest(binding?.next),
      handoff: binding?.handoff ?? null,
      copy: binding?.copy ?? [],
      detail: binding?.detail ?? null,
      blockedBy: binding?.blockedBy ?? null,
    };
    steps.push(step);
    if (support.mode === "deep-link" && !binding)
      byLink.set(support.link, step);
  }

  const prerequisites = prerequisitesOf(adapter, facts, ledger);
  const readOnly =
    facts.connection.state === "not-configured"
      ? `${adapter.label} has no team connection: a platform admin stores its credential in Platform → Store connections.`
      : null;
  return {
    id: adapter.id,
    label: adapter.label,
    listingStore: listingStoreOf(adapter),
    connection: facts.connection,
    app: facts.app,
    outlets: facts.outlets,
    readOnly,
    capabilities,
    prerequisites,
    steps,
    pushListing: runtime?.pushListing
      ? { stageOnly: runtime.pushListing.stageOnly }
      : null,
    confirmationLabel: adapter.confirmation.label,
  };
}

/** The checklist S-15 §8.1 step 2 computes for every store. */
function prerequisitesOf(
  adapter: StorefrontAdapter,
  facts: StoreFacts,
  ledger: LedgerView,
): PrerequisiteView[] {
  const out: PrerequisiteView[] = [];
  const conn = facts.connection;
  if (conn.state !== "keyless") {
    out.push({
      id: "connection",
      label: "Team connection",
      state: conn.state === "connected" ? "met" : "unmet",
      detail:
        conn.state === "connected"
          ? conn.lastError
            ? `${conn.credentialLabel ?? "The credential"} is stored; its last use failed: ${conn.lastError}`
            : `${conn.credentialLabel ?? "The credential"} is stored.`
          : `Store ${conn.credentialLabel ?? "the team credential"} in Platform → Store connections.`,
      page: "platform-stores",
    });
    const createsApps =
      adapter.capabilities.ops.createApp.mode !== "unsupported";
    out.push({
      id: "app",
      label: "The product's app",
      state: facts.app ? "met" : "unmet",
      detail: facts.app
        ? `${facts.app.name ?? facts.app.id} is assigned to this product.`
        : createsApps
          ? `Assign the app in Platform → Store connections, or create it in this flow's ${OP_LABELS.createApp.toLowerCase()} step.`
          : "Assign the app in Platform → Store connections.",
      page: "platform-stores",
    });
    // Only a write proves a write permission (S-15 §8.1 step 2): a done row for this store does.
    const wrote = [...ledger.product, ...ledger.team].some(
      (r) => r.state === "done" && r.plane === "worker",
    );
    out.push({
      id: "permissions",
      label: "Write permissions",
      state: wrote ? "met" : "unknown",
      detail: wrote
        ? `A write to ${adapter.label} has succeeded with this connection.`
        : `Confirmed by the first write: ${adapter.label} answers a missing permission when a step runs.`,
      page: null,
    });
  }
  return out;
}

/** Is `op` one the plan can show (not a read, not absent from the plan's order)? */
export function isPlanOp(op: string): op is StorefrontOp {
  return (
    PLAN_OPS.some((p) => p.op === op) &&
    !(READ_OPS as readonly string[]).includes(op)
  );
}
