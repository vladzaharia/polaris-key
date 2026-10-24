/**
 * The delivery facet of the channel read model (A-20.3): for every channel in the catalogue,
 * whether it is in scope for the product, whether the operator said they do not use it, whether
 * one click can set it up, and its state: `not_set_up`, `ready`, `live` or `attention`.
 *
 * - Scope: the channel's platforms meet `productPlatforms`, and (when the product has any
 *   deliverable at all) its deliverable kinds meet the product's. A channel out of scope is
 *   omitted, except one the operator declared an outlet for: that is listed with
 *   `attention: out_of_scope`.
 * - Fit: `channelFit` over the builds a customer can get now (`liveBuilds`). Builds exist but none
 *   fit is `attention` with the fit's reasons.
 * - Live, by plane: Polaris Key itself, a release with a fitting build; feed plane, a declared
 *   outlet and a release with a fitting build; every other plane, an availability record `live`
 *   for a declared outlet of the channel.
 * - One click (D5): in scope, not set up, and the store's delivery requirements are met
 *   (`storeRequirements`, P0-27.6): the team's credential (configured, in the console or as a
 *   secret) or an active credential of the product. No store call is made.
 *
 * Credential facts leave this module only as booleans and reason codes (D7): never an id, a meta
 * field, a key id or an issuer. Read-only.
 */

import {
  archFits,
  CHANNELS,
  channelFit,
  type ChannelEntry,
  type FitReason,
} from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { ServiceHooks } from "../../core/hooks.js";
import type { Env } from "../../platform/env.js";
import { parseJsonColumn } from "../../platform/json.js";
import {
  isPlatformCredentialId,
  PLATFORM_CREDENTIALS,
} from "../../core/platformCredentials.js";
import { storeRequirements } from "../../core/stores/requirements.js";
import { EMPTY_SETUP, isSetupChoices } from "../../core/settings/setupShape.js";
import { expiringCredentials } from "./attentionFacts.js";
import {
  liveBuilds,
  productPlatforms,
  type LiveBuild,
  type ProductPlatforms,
} from "./facts.js";
import { listOutlets, type DistOutletRow } from "./outlets.js";

/** How far ahead a credential counts as expiring; the console's Home uses the same window. */
export const CREDENTIAL_EXPIRY_WINDOW_SECONDS = 14 * 86_400;

export type DeliveryState = "not_set_up" | "ready" | "live" | "attention";

/**
 * Why a channel needs the operator. These are read-model reasons for the console, never wire
 * error codes: they are typed values passed to `attention(...)`, not `code:` literals, so the
 * errors.json scan does not take them for codes an SDK can receive.
 */
export type DeliveryAttentionCode =
  | "out_of_scope"
  | "no_fitting_build"
  | "credential_expiring"
  | "credential_missing";

export type DeliveryAttention = {
  code: DeliveryAttentionCode;
  /** Only `no_fitting_build`: the reasons from `channelFit`. */
  reasons?: FitReason[];
};

function attention(
  code: DeliveryAttentionCode,
  reasons?: FitReason[],
): DeliveryAttention {
  return reasons === undefined ? { code } : { code, reasons };
}

export interface DeliveryFacet {
  /** The catalogue channel id. */
  channel: string;
  /** The operator said they do not use this channel (`core.setup.notUsing`). */
  notUsing: boolean;
  inScope: boolean;
  /** An outlet for the channel is declared. */
  declared: boolean;
  /** In scope, not set up, and its credential slot is held. */
  oneClick: boolean;
  state: DeliveryState;
  attention: DeliveryAttention[];
  /** The platforms the channel serves for this product, with the arches it takes there. */
  platforms: { platform: string; arches: string[] }[];
}

function identityOf(o: DistOutletRow): Record<string, unknown> {
  const v = parseJsonColumn(o.identity_json);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * The package-manager subkind of a `direct` outlet: an explicit `identity.subkind`, else
 * `homebrew` when the outlet names a cask. No outlet stores one otherwise, so a bare `direct`
 * is Polaris Key itself.
 */
function subkindOf(o: DistOutletRow): string | null {
  if (o.kind !== "direct") return null;
  const id = identityOf(o);
  if (typeof id.subkind === "string") return id.subkind;
  return typeof id.homebrewCask === "string" ||
    typeof id.homebrewFormula === "string"
    ? "homebrew"
    : null;
}

function declaresChannel(o: DistOutletRow, c: ChannelEntry): boolean {
  return (
    o.removed_at === null &&
    o.kind === c.outlet.kind &&
    subkindOf(o) === (c.outlet.subkind ?? null)
  );
}

export interface DeliveryContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  /** Epoch seconds. */
  now: number;
  /** What the caller already computed (`productPlatforms`, `liveBuilds`), so each runs once. */
  known?: { facts: ProductPlatforms; builds: LiveBuild[] };
}

export async function deliveryFacets(
  ctx: DeliveryContext,
): Promise<DeliveryFacet[]> {
  const { env, db, product, hooks, now } = ctx;
  const builds = ctx.known?.builds ?? (await liveBuilds(hooks));
  const facts =
    ctx.known?.facts ??
    (await productPlatforms({ db, product, hooks, now, builds }));
  const outlets = (await listOutlets(db, product)).filter(
    (o) => o.removed_at === null,
  );

  const setupRow = await db.first<{
    value_json: string | null;
    expires_at: number | null;
  }>(
    "SELECT value_json, expires_at FROM product_settings WHERE product = ? AND key = 'core.setup'",
    product,
  );
  const stored =
    setupRow && (setupRow.expires_at === null || setupRow.expires_at > now)
      ? parseJsonColumn(setupRow.value_json)
      : null;
  const notUsing = new Set(
    (isSetupChoices(stored) ? stored : EMPTY_SETUP).notUsing,
  );

  // Credential facts, once per store: booleans only. The delivery facet's requirements are the
  // one definition of "held" (P0-27.6, `core/stores/requirements.ts`); no second copy here.
  const held = new Map<string, boolean>();
  const heldSlot = async (adapter: string): Promise<boolean> => {
    const cached = held.get(adapter);
    if (cached !== undefined) return cached;
    const v =
      (await storeRequirements(env, db, product, adapter, "delivery"))?.met ??
      false;
    held.set(adapter, v);
    return v;
  };
  const expiring = await expiringCredentials(
    db,
    product,
    now + CREDENTIAL_EXPIRY_WINDOW_SECONDS,
  );

  const liveOutlets = new Set(
    (
      await db.all<{ outlet_id: string }>(
        "SELECT DISTINCT outlet_id FROM dist_availability WHERE product = ? AND state = 'live'",
        product,
      )
    ).map((r) => r.outlet_id),
  );

  const out: DeliveryFacet[] = [];
  for (const c of CHANNELS) {
    const mine = outlets.filter((o) => declaresChannel(o, c));
    const declared = mine.length > 0;
    // A platform with a need (`platformNeeds`) stays only while a declared outlet meets it.
    const served = c.platforms.filter((p) => {
      const need = c.platformNeeds?.[p];
      return !need || mine.some((o) => typeof identityOf(o)[need] === "string");
    });
    const shared = facts.platforms.filter((p) => served.includes(p.platform));
    const kindOk =
      facts.kinds.length === 0 ||
      c.deliverableKinds.some((k) => facts.kinds.includes(k));
    const inScope = shared.length > 0 && kindOk;
    if (!inScope && !declared) continue;

    const attentions: DeliveryAttention[] = [];
    if (!inScope) attentions.push(attention("out_of_scope"));

    const fit = channelFit({ ...c, platforms: served }, builds);
    const anyFit = fit.some((f) => f.fits);
    if (inScope && fit.length > 0 && !anyFit)
      attentions.push(
        attention("no_fitting_build", [
          ...new Set(fit.flatMap((f) => f.reasons)),
        ]),
      );

    const slot = c.storefront?.credential ?? null;
    const slotHeld =
      slot === null || c.storefront === null
        ? true
        : await heldSlot(c.storefront.adapter);
    if (declared && slot !== null && !slotHeld)
      attentions.push(attention("credential_missing"));
    // Expiry only turns a channel the team uses (declared) into attention; an undeclared channel
    // stays not_set_up (and one click), whatever its shared credential's age.
    if (
      declared &&
      slot !== null &&
      isPlatformCredentialId(slot) &&
      expiring.some((e) => e.kind === PLATFORM_CREDENTIALS[slot].kind)
    )
      attentions.push(attention("credential_expiring"));

    let live = false;
    if (anyFit && inScope) {
      if (c.id === "polaris-key") live = true;
      else if (declared && c.plane === "feed") live = true;
    }
    if (
      declared &&
      c.id !== "polaris-key" &&
      c.plane !== "feed" &&
      mine.some((o) => liveOutlets.has(o.outlet_id))
    )
      live = true;

    const state: DeliveryState =
      attentions.length > 0
        ? "attention"
        : live
          ? "live"
          : declared
            ? "ready"
            : "not_set_up";

    const accepted = c.arches ?? {};
    out.push({
      channel: c.id,
      notUsing: notUsing.has(c.id),
      inScope,
      declared,
      oneClick: inScope && !declared && slot !== null && slotHeld,
      state,
      attention: attentions,
      platforms: shared.map((p) => {
        const list = accepted[c.platforms.find((x) => x === p.platform)!];
        return {
          platform: p.platform,
          arches: list ? p.arches.filter((a) => archFits(a, list)) : p.arches,
        };
      }),
    });
  }
  return out;
}

/** The delivery facet for the console's channels read (A-20.4). */
export function channelFacts(
  env: Env,
  db: Db,
  product: string,
  hooks: ServiceHooks,
  now: number = Math.floor(Date.now() / 1000),
  known?: DeliveryContext["known"],
): Promise<DeliveryFacet[]> {
  return deliveryFacets({ env, db, product, hooks, now, known });
}
