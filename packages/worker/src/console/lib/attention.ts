/**
 * What needs the operator, across every product the session can see (`GET /manage/api/attention`;
 * UX-12, ST-44). One server read replaces the client's derivation from each product's setup state
 * and the retired summary read.
 *
 * Only things that are broken or about to break appear: a failed resync, a required secret with no
 * value, a missing signing key, an edge-mint recipe waiting for approval, a store credential that
 * is expiring or expired. Integration progress (what a product has not set up yet) never does:
 * that is the launch path's. Each item states one fact per line, names its product once, and
 * carries the area its fix lives in, so a member who cannot open the fix never sees the item
 * (`can()` per item, ST-29). Kinds that need a table not yet in the schema (a subscription token
 * that is about to expire, LX-41) join here when it lands.
 *
 * A fact about the platform itself (the Cloud Sync pause, ST-44b) is composed once by
 * `platformAttention`, with `product: null`, not once per product. It ignores product visibility
 * and is shown only to a member who can edit the Platform area, so a Platform admin with no
 * product grant sees it and a product role never does. `since`, `by` and `reason` ride on it for
 * that audience alone.
 */

import { channelLabel } from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import { serviceStateOf } from "../../core/services.js";
import { syncPauseNotice } from "../../core/accounts/syncPause.js";
import type { Env } from "../../platform/env.js";
import { getProductSyncState } from "../../core/products/store.js";
import type { ProductRow } from "../../core/repo.js";
import type { AreaId, Principal } from "../authz.js";
import { can, PLATFORM, productScope } from "../authz.js";
import {
  expiringCredentials,
  outletIdentityMismatches,
} from "../../services/distribution/public.js";
import {
  storefrontIdentityAmbiguities,
  storefrontIdentityMismatches,
} from "../../services/commerce/public.js";
import { parseServices } from "../../core/services.js";
import { attentionFactsFor } from "./shape.js";

export type AttentionTone = "danger" | "warning";

export type AttentionKind =
  | "sync.failed"
  | "secret.missing"
  | "secret.usage"
  | "signing.missing"
  | "mint.pending"
  | "credential.expiring"
  | "storefront.identity_mismatch"
  | "storefront.identity_ambiguous"
  | "channel.identity_mismatch"
  | "sync.paused";

/**
 * Where the fix lives: a product page by the console's page id, or a global page id when the
 * item's `product` is null.
 */
export interface AttentionAction {
  label: string;
  page: string;
  query?: Record<string, string>;
}

export interface AttentionItem {
  /**
   * Unique across products: `<slug>:<kind>:<subject>`. A platform item is `@platform:<kind>`;
   * `@` is outside the slug alphabet, so the two never collide.
   */
  id: string;
  /** `null` for a platform item (`platformAttention`). */
  product: { slug: string; name: string } | null;
  kind: AttentionKind;
  tone: AttentionTone;
  /** The service the fix belongs to (the row's accent), `null` for the product itself. */
  service: string | null;
  /** The pill's short word on the product's card: the problem in two or three words. */
  short: string;
  /** One fact per line: what happened, then its cause or consequence. */
  lines: string[];
  action: AttentionAction;
  /** The area the fix needs; the item is dropped for a member who lacks it. */
  area: AreaId;
  /** Platform items only: epoch seconds the pause began. */
  since?: number | null;
  /** Platform items only: the display name of who turned it on; never an id. */
  by?: string | null;
  /** Platform items only: the operator's own reason. */
  reason?: string | null;
}

/** A credential expiring within this many seconds is listed (14 days). */
const EXPIRY_WINDOW_SECONDS = 14 * 86_400;

const CREDENTIAL_LABELS: Readonly<Record<string, string>> = {
  "asc-api-key": "App Store Connect key",
  "app-store-server-key": "App Store server key",
  "steam-publisher-key": "Steam publisher key",
  "google-service-account": "Google Play key",
  "ms-partner-center": "Microsoft Store credential",
};

const STORE_LABELS = {
  "app-store": channelLabel("app-store"),
  play: channelLabel("google-play"),
  steam: channelLabel("steam"),
} as const;

/** What an outlet identity field is called in a sentence. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  appleId: "Apple ID",
  bundleId: "bundle ID",
  packageName: "package name",
  productId: "Store ID",
  appId: "app ID",
};

const day = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

function secretService(
  sources: readonly string[],
): "identity" | "config" | null {
  if (sources.some((s) => s.startsWith("OIDC"))) return "identity";
  if (sources.some((s) => s.startsWith("Edge mint"))) return "config";
  return null;
}

/**
 * A failed resync's stored message can carry whatever the upstream answered (an error body, a
 * header, a token echoed back). Home never repeats it: the message is only classified, and one of
 * these fixed reasons is shown. The full result is on the Releases page, behind its own gate.
 */
export function syncReason(message: string | null): string {
  const m = (message ?? "").toLowerCase();
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|permission|credential|token|bad credentials/.test(
      m,
    )
  )
    return "GitHub refused access to the repository.";
  if (/\b429\b|rate.?limit/.test(m)) return "GitHub rate-limited the request.";
  if (/manifest|invalid|schema|line \d+|validation|parse/.test(m))
    return "The manifest did not validate.";
  if (/\b404\b|not found|no such|missing/.test(m))
    return "The repository or its `.pkey/` directory was not found.";
  if (/\b5\d\d\b|timeout|timed out|network|fetch/.test(m))
    return "GitHub could not be reached.";
  return "The last resync did not finish.";
}

/** One product's items, unfiltered by who is asking. */
export async function productAttention(
  db: Db,
  p: ProductRow,
  now: number,
  /** Whether the asker may see an area's items; the reads for a hidden area are skipped. */
  sees: (area: AreaId) => boolean = () => true,
): Promise<AttentionItem[]> {
  const product = { slug: p.slug, name: p.name || p.slug };
  const items: AttentionItem[] = [];
  const id = (kind: AttentionKind, subject = "") =>
    `${p.slug}:${kind}${subject ? `:${subject}` : ""}`;

  const sync = await getProductSyncState(db, p.slug);
  if (sync?.status === "error")
    items.push({
      id: id("sync.failed"),
      product,
      kind: "sync.failed",
      tone: "danger",
      service: "release",
      short: "Resync failed",
      lines: ["Resync failed.", syncReason(sync.message)],
      action: { label: "Open error", page: "releases" },
      area: "ship",
    });

  const facts = await attentionFactsFor(db, p);
  for (const s of facts.secrets) {
    if (s.configured) continue;
    items.push({
      id: id("secret.missing", s.name),
      product,
      kind: "secret.missing",
      tone: "warning",
      service: secretService(s.sources) ?? "config",
      short: "Missing secret",
      lines: [
        `Required secret \`${s.name}\` has no value in the Default profile.`,
      ],
      action: { label: "Set secret", page: "keys" },
      area: "keys",
    });
  }
  if (!facts.signingConfigured)
    items.push({
      id: id("signing.missing"),
      product,
      kind: "signing.missing",
      tone: "danger",
      service: null,
      short: "No signing key",
      lines: ["No usable signing key.", "Nothing this product signs verifies."],
      action: { label: "Open keys", page: "keys" },
      area: "keys",
    });
  for (const name of facts.wrongUsage)
    items.push({
      id: id("secret.usage", name),
      product,
      kind: "secret.usage",
      tone: "warning",
      service: "config",
      short: "Secret not marked",
      lines: [`Secret \`${name}\` is not marked for edge minting.`],
      action: { label: "Open keys", page: "keys" },
      area: "keys",
    });
  for (const recipe of facts.unapprovedRecipes)
    items.push({
      id: id("mint.pending", recipe),
      product,
      kind: "mint.pending",
      tone: "warning",
      service: "config",
      short: "Needs approval",
      lines: [`Edge-mint recipe \`${recipe}\` awaits approval.`],
      action: {
        label: "Review recipe",
        page: "catalog-edit",
        query: { entry: recipe, recipe },
      },
      area: "config",
    });

  const creds = sees("ship")
    ? await expiringCredentials(db, p.slug, now + EXPIRY_WINDOW_SECONDS)
    : [];
  for (const c of creds) {
    const label = CREDENTIAL_LABELS[c.kind];
    if (!label) continue;
    const gone = c.expiresAt <= now;
    items.push({
      id: id("credential.expiring", c.id),
      product,
      kind: "credential.expiring",
      tone: gone ? "danger" : "warning",
      service: "release",
      short: gone ? "Credential expired" : "Credential expiring",
      lines: [`${label} ${gone ? "expired" : "expires"} ${day(c.expiresAt)}.`],
      action: { label: "Replace key", page: "storefronts" },
      area: "ship",
    });
  }

  // Only a product that sells through Commerce; a block left over while it is off is not news.
  if (
    sees("commerce") &&
    parseServices(p.services_json ?? null).services.commerce?.enabled === true
  ) {
    for (const m of await storefrontIdentityMismatches(db, p.slug))
      items.push({
        id: id("storefront.identity_mismatch", m.store),
        product,
        kind: "storefront.identity_mismatch",
        tone: "warning",
        service: "commerce",
        short: "App mismatch",
        lines: [
          `${STORE_LABELS[m.store]} purchases are checked against \`${m.typed}\`, not the assigned app \`${m.assigned}\`.`,
        ],
        action: { label: "Review", page: "commerce-overview" },
        area: "commerce",
      });
    for (const a of await storefrontIdentityAmbiguities(db, p.slug))
      items.push({
        id: id("storefront.identity_ambiguous", a.store),
        product,
        kind: "storefront.identity_ambiguous",
        tone: "warning",
        service: "commerce",
        short: "Keys disagree",
        lines: [
          `${STORE_LABELS[a.store]} keys name different apps.`,
          `Purchases are checked against \`${a.value}\`.`,
        ],
        action: { label: "Review", page: "commerce-overview" },
        area: "commerce",
      });
  }

  // Only while Distribution is on; an outlet row left over while it is off is not news.
  if (
    sees("ship") &&
    parseServices(p.services_json ?? null).services.distribution?.enabled ===
      true
  )
    for (const m of await outletIdentityMismatches(db, p.slug))
      items.push({
        id: id("channel.identity_mismatch", `${m.outletId}:${m.field}`),
        product,
        kind: "channel.identity_mismatch",
        tone: "warning",
        service: "distribution",
        short: "App mismatch",
        lines: [
          `The \`${m.outletId}\` channel declares ${FIELD_LABELS[m.field] ?? m.field} \`${m.declared}\`; the assigned app is \`${m.assigned}\`.`,
        ],
        action: {
          label: "Review",
          page: "outlets",
          query: { outlet: m.outletId },
        },
        area: "ship",
      });
  return items;
}

const RANK: Record<AttentionTone, number> = { danger: 0, warning: 1 };

/**
 * The platform's own items, composed once. Today that is the Cloud Sync pause: shown to a member
 * who can edit the Platform area (whatever their product grants), only while writes are paused
 * and at least one product has Cloud Sync on. `products` is every non-system product, not just
 * the ones the caller can see, so the existence check never depends on the caller's grants and
 * the answer names no product.
 */
export async function platformAttention(
  env: Env,
  db: Db,
  principal: Principal | null | undefined,
  products: readonly ProductRow[],
): Promise<AttentionItem[]> {
  if (!can(principal, PLATFORM, "platform", "edit")) return [];
  if (!products.some((p) => serviceStateOf(p).services.sync.enabled)) return [];
  const notice = await syncPauseNotice(env, db, true);
  if (!notice) return [];
  return [
    {
      id: "@platform:sync.paused",
      product: null,
      kind: "sync.paused",
      tone: "warning",
      service: "sync",
      short: "Writes paused",
      lines: [
        "Cloud Sync writes are paused for every product.",
        "Devices keep their changes and send them on resume.",
      ],
      action: {
        label: "Resume writes",
        page: "platform-settings",
        query: { setting: "cloudSync.writesPaused" },
      },
      area: "platform",
      since: notice.since,
      by: notice.by,
      reason: notice.reason,
    },
  ];
}

/**
 * The platform's items, then every visible product's items the principal may act on, the worst
 * first; within a tone the platform's come first, then products by name. `allProducts` is every
 * non-system product (default: `products`), for the platform items' existence check.
 */
export async function attentionAcross(
  db: Db,
  products: ProductRow[],
  principal: Principal | null | undefined,
  now: number,
  env?: Env,
  allProducts: readonly ProductRow[] = products,
): Promise<AttentionItem[]> {
  const platform = env
    ? await platformAttention(env, db, principal, allProducts)
    : [];
  const per = await Promise.all(
    products.map(async (p) => {
      const scope = productScope(p);
      const sees = (area: AreaId) => can(principal, scope, area, "view");
      const items = await productAttention(db, p, now, sees);
      return items.filter((i) => sees(i.area));
    }),
  );
  return [...platform, ...per.flat()].sort(
    (a, b) =>
      RANK[a.tone] - RANK[b.tone] ||
      (a.product === null ? 0 : 1) - (b.product === null ? 0 : 1) ||
      (a.product?.name ?? "").localeCompare(b.product?.name ?? "") ||
      a.id.localeCompare(b.id),
  );
}
