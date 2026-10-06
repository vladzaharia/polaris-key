/**
 * THE APPLE FLOW RUNTIME (A-18j; notes/S-15 §7.5 "A-17f", §8.1). The dropped A-17f New app wizard
 * becomes this: the App Store adapter's plan inside the generic flow, on the routes A-17b and
 * A-17c already serve and test. Nothing here writes to Apple itself; each binding names the
 * reviewed route that does, behind A-17a's write gate and the ledger:
 *
 *   identifiers         POST /manage/api/platform/store-connections/app-store/bundle-ids
 *   createApp           a deep link (App Store Connect has no app create), verified by this
 *                       runtime's `verify`: the app lookup by bundle id (A-17b's read), then
 *                       A-16's assignment of the app it found to the product
 *   notificationsUrl    POST …/distribution/connectors/asc/setup/notifications-url
 *   category, rating,   App Information, App Privacy and the version page: deep links ticked on
 *   privacy, images     A-17c's portal checklist (`setup/checklist`), shared with the App Store
 *                       page
 *   pricing             POST …/setup/availability, then …/setup/price (free; the INITIAL price,
 *                       which S-15 §6.4 keeps untyped)
 *   testers             POST …/setup/beta-group
 *   iap                 the Commerce page (A-17g)
 *   submit, release     the App Store page's Distribute flow (A-17g), which confirms both typed
 *                       with the app's name as App Store Connect reports it
 *
 * Listing text stays with A-17d's Distribute flow (What's New and promotional text) until A-18m
 * widens the gate; its step is not shown here, and "Push listing" appears once A-18m binds it.
 */

import type { StorefrontOp } from "../../../core/storefront/adapter.js";
import {
  budgetAllows,
  readRate,
  recordTeamRate,
} from "../../../core/storefront/budget.js";
import {
  appView,
  BUNDLE_PLATFORMS,
  isBundleIdentifier,
  lookupAppByBundleId,
} from "../../../core/ascProvisioning.js";
import type { StoreOperationRow } from "../../../core/storefront/ledger.js";
import { AscError, AscWriteDenied } from "../../../core/asc/client.js";
import { platformAscClient } from "../connectors/asc/platform.js";
import {
  checklistView,
  type AscChecklistItem,
} from "../connectors/asc/provision.js";
import { readListing } from "../listing/store.js";
import { flowOp } from "./plan.js";
import type {
  FlowContext,
  FlowRefusal,
  FlowRuntime,
  LedgerView,
  StepBinding,
  StepRequest,
  StepState,
  StoreFacts,
  VerifyOutcome,
} from "./runtime.js";

const enc = encodeURIComponent;
const productApi = (slug: string) => `/manage/api/products/${enc(slug)}`;
const setup = (slug: string, control: string) =>
  `${productApi(slug)}/distribution/connectors/asc/setup/${control}`;
const TEAM = "/manage/api/platform/store-connections/app-store";

/** The checklist item each deep-linked operation ticks (A-17c's `ASC_CHECKLIST`). */
const CHECKLIST: Partial<Record<StorefrontOp, AscChecklistItem>> = {
  category: "app_information",
  privacyDeclarations: "app_privacy",
  writeListingAssets: "screenshots",
};

const PLATFORM_LABEL: Record<string, string> = {
  IOS: "iOS, iPadOS, tvOS, visionOS",
  MAC_OS: "macOS",
  UNIVERSAL: "Universal",
};

function latest(
  rows: readonly StoreOperationRow[],
  op: string,
  naturalKey?: string,
): StoreOperationRow | null {
  return (
    rows.find(
      (r) =>
        r.op === op &&
        (naturalKey === undefined || r.natural_key === naturalKey),
    ) ?? null
  );
}

function rowState(row: StoreOperationRow | null): {
  state: StepState;
  stateAt: number | null;
} {
  return row
    ? { state: row.state, stateAt: row.finished_at ?? row.created_at }
    : { state: "todo", stateAt: null };
}

/** The bundle id the flow works with: the outlet's, else the newest one registered here. */
function bundleIdOf(facts: StoreFacts, ledger: LedgerView): string | null {
  const declared = facts.identifiers.bundleId;
  if (declared && isBundleIdentifier(declared)) return declared;
  const registered = ledger.team.find(
    (r) => r.op === "bundle_id.register" && r.state === "done",
  );
  return registered?.natural_key ?? null;
}

function resultIdsOf(row: StoreOperationRow | null): Record<string, string> {
  if (!row?.result_ids_json) return {};
  try {
    const v = JSON.parse(row.result_ids_json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}

const post = (
  path: string,
  verb: string,
  consequences: string[],
  fields: StepRequest["fields"] = [],
  body: Record<string, unknown> = {},
): StepRequest => ({
  method: "POST",
  path,
  body,
  fields,
  confirm: "plain",
  verb,
  consequences,
});

const NEEDS_APP =
  "Assign the product's App Store Connect app first (the app record step, or Platform → Store connections).";

export const APP_STORE_FLOW: FlowRuntime = {
  id: "app-store",

  async bind(c, op, facts, ledger): Promise<StepBinding | null> {
    const slug = c.product;
    const pinned = facts.app !== null;
    switch (op) {
      case "identifiers": {
        const bundleId = bundleIdOf(facts, ledger);
        const row = bundleId
          ? latest(ledger.team, "bundle_id.register", bundleId)
          : null;
        return {
          label: "Bundle ID",
          ...rowState(row),
          // A pinned app already has its bundle id: nothing is left to register.
          ...(pinned && !row ? { state: "done" as const } : {}),
          detail:
            row?.state === "done"
              ? `${bundleId} is registered with Apple.`
              : pinned
                ? "The assigned app already has its bundle ID."
                : null,
          run: post(
            `${TEAM}/bundle-ids`,
            "Register the bundle ID",
            [
              "Apple registers the explicit bundle ID for the team, or finds it if it exists.",
              "A bundle ID can't be renamed or deleted from Polaris Key afterwards.",
            ],
            [
              {
                name: "identifier",
                label: "Bundle ID",
                help: "Reverse-DNS, explicit (no wildcard). It must match the Godot export preset.",
                value: bundleId ?? "",
                required: true,
                maxLength: 155,
              },
              {
                name: "platform",
                label: "Platform",
                value: "IOS",
                required: true,
                options: BUNDLE_PLATFORMS.map((p) => ({
                  value: p,
                  label: PLATFORM_LABEL[p] ?? p,
                })),
              },
              {
                name: "name",
                label: "Name",
                help: "Letters, digits and spaces. Left empty, Apple's name is made from the bundle ID.",
                value: "",
                required: false,
                maxLength: 60,
              },
            ],
          ),
        };
      }
      case "createApp": {
        const bundleId = bundleIdOf(facts, ledger);
        const found = latest(ledger.product, flowOp("createApp"));
        const appId = resultIdsOf(found).appId ?? null;
        const stored = await readListing(c.db, slug);
        const app = stored?.model.app;
        const state = pinned
          ? { state: "done" as const, stateAt: found?.finished_at ?? null }
          : found?.state === "done"
            ? // Found in App Store Connect, not yet assigned: the step waits on the assignment.
              { state: "pending" as const, stateAt: found.finished_at }
            : rowState(found);
        return {
          label: "App record",
          ...state,
          detail: pinned
            ? `${facts.app!.name ?? facts.app!.id} is assigned to this product.`
            : appId
              ? `App Store Connect has the app (Apple ID ${appId}); assign it to this product to go on.`
              : null,
          blockedBy: bundleId ? null : "Register the bundle ID first.",
          copy: [
            { label: "Name", value: app?.name ?? c.productName },
            {
              label: "Primary language",
              value: app?.defaultLocale ?? "en-US",
            },
            ...(bundleId ? [{ label: "Bundle ID", value: bundleId }] : []),
            { label: "SKU", value: slug },
          ],
          ...(appId && !pinned
            ? {
                next: {
                  method: "PUT" as const,
                  path: `${TEAM}/apps/${enc(appId)}/product`,
                  body: { product: slug },
                  fields: [],
                  confirm: "plain" as const,
                  verb: "Assign the app to this product",
                  consequences: [
                    `App Store Connect app ${appId} is pinned to ${c.productName}: the team key acts on it for this product only.`,
                    "Release it again in Platform → Store connections.",
                  ],
                },
              }
            : {}),
        };
      }
      case "notificationsUrl": {
        const row = latest(ledger.product, "app.notifications_url");
        return {
          label: "App Store Server Notifications",
          ...rowState(row),
          blockedBy: pinned ? null : NEEDS_APP,
          run: post(
            setup(slug, "notifications-url"),
            "Set the notifications URL",
            [
              "App Store Connect sends this product's App Store Server Notifications (version 2, production and sandbox) to Polaris Key.",
              "The step shows what App Store Connect stored, read back after the write.",
            ],
          ),
        };
      }
      case "category":
      case "privacyDeclarations":
      case "writeListingAssets": {
        const item = CHECKLIST[op]!;
        const list = await checklistView(c.db, slug, facts.app?.id ?? null);
        const tick = list.find((t) => t.item === item);
        return {
          label: tick?.label ?? undefined,
          state: tick?.done ? "done" : "todo",
          stateAt: tick?.doneAt ?? null,
          blockedBy: pinned ? null : NEEDS_APP,
          assert: post(
            setup(slug, "checklist"),
            "Mark as done",
            [
              "Records that you completed it in App Store Connect. Apple's API can't confirm it.",
            ],
            [],
            { item, done: true },
          ),
        };
      }
      case "contentRating":
        // The age rating is on App Information, with the category: one step covers both.
        return { hidden: true, state: "todo" };
      case "pricing": {
        const availability = latest(ledger.product, "app.availability");
        const price = latest(ledger.product, "app.price");
        const both = availability?.state === "done" && price?.state === "done";
        const priceNext = availability?.state === "done";
        return {
          label: "Availability and price",
          ...(both
            ? rowState(price)
            : priceNext
              ? rowState(price)
              : rowState(availability)),
          ...(priceNext && !both && !price
            ? { state: "pending" as const }
            : {}),
          blockedBy: pinned ? null : NEEDS_APP,
          run: priceNext
            ? post(setup(slug, "price"), "Set the price to free", [
                "App Store Connect sets the app's first price schedule: free, from the USA base territory.",
                "Only while the app has no price yet; a later change is typed on the App Store page.",
              ])
            : post(setup(slug, "availability"), "Make the app available", [
                "App Store Connect makes the app available in every territory, and in new ones as Apple adds them.",
                "Only while the app has no availability yet.",
              ]),
        };
      }
      case "testers": {
        const row =
          ledger.product.find((r) => r.op === "testflight.group.create") ??
          null;
        return {
          label: "TestFlight group",
          ...rowState(row),
          blockedBy: pinned ? null : NEEDS_APP,
          run: post(
            setup(slug, "beta-group"),
            "Create the TestFlight group",
            [
              "App Store Connect creates the group, or finds it by name if it exists.",
            ],
            [
              {
                name: "name",
                label: "Group name",
                value: "Internal testers",
                required: true,
                maxLength: 50,
              },
              {
                name: "kind",
                label: "Kind",
                value: "internal",
                required: true,
                options: [
                  { value: "internal", label: "Internal (team members)" },
                  { value: "external", label: "External (needs beta review)" },
                ],
              },
            ],
          ),
        };
      }
      case "iap": {
        const created = ledger.product.some(
          (r) => r.op === "iap.create" && r.state === "done",
        );
        return {
          label: "In-App Purchases",
          state: created ? "done" : "todo",
          handoff: { page: "commerce", label: "Open Commerce" },
          blockedBy: pinned ? null : NEEDS_APP,
        };
      }
      case "submit": {
        const row = latest(ledger.product, "review_submission.submit");
        return {
          label: "Submit for App Review",
          ...rowState(row),
          handoff: { page: "app-store", label: "Open the Distribute flow" },
          blockedBy: pinned ? null : NEEDS_APP,
        };
      }
      case "release":
        return {
          label: "Release and phased release",
          state: "todo",
          handoff: { page: "app-store", label: "Open the App Store page" },
          blockedBy: pinned ? null : NEEDS_APP,
        };
      case "rollout":
        return { hidden: true, state: "todo" };
      default:
        return null;
    }
  },

  async verify(c, op, facts, ledger): Promise<VerifyOutcome | FlowRefusal> {
    if (op !== "createApp")
      return {
        ok: false,
        status: 422,
        reason: "not_verifiable",
        message: "this step is confirmed by you, not by a read",
      };
    if (facts.app)
      return {
        satisfied: true,
        resultIds: { appId: facts.app.id },
        detail: "assigned",
      };
    const bundleId = bundleIdOf(facts, ledger);
    if (!bundleId)
      return {
        ok: false,
        status: 409,
        reason: "no_bundle_id",
        message: "register the bundle ID first: the app record is found by it",
      };
    const rate = await readRate(
      c.env,
      "app-store",
      "",
      { source: "platform" },
      c.now,
    );
    if (!budgetAllows(rate, "background"))
      return {
        ok: false,
        status: 429,
        reason: "asc_budget_low",
        message:
          "the team key's App Store Connect budget is low: detection pauses until it recovers",
      };
    const client = await platformAscClient({
      env: c.env,
      db: c.db,
      actor: {
        sub: c.session.sub,
        name: c.session.name,
        email: c.session.email,
      },
      use: "asc:platform-provisioning",
      now: c.now,
      ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
      ...(c.sleep ? { sleep: c.sleep } : {}),
    });
    if (!client)
      return {
        ok: false,
        status: 409,
        reason: "not_configured",
        message:
          "the platform App Store connection has no usable App Store Connect key",
      };
    try {
      const app = await lookupAppByBundleId(client, bundleId);
      if (!app) return { satisfied: false, detail: null };
      const v = appView(app);
      return {
        satisfied: true,
        resultIds: { appId: v.appId },
        detail: v.name,
      };
    } catch (e) {
      if (e instanceof AscWriteDenied || e instanceof AscError)
        return {
          ok: false,
          status: 502,
          reason: "store_unavailable",
          message: e.message,
        };
      throw e;
    } finally {
      await recordTeamRate(c.env, "app-store", client.lastRate, c.now);
    }
  },
};
