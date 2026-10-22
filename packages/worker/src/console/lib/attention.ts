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
 */

import type { Db } from "../../db/types.js";
import { serviceStateOf } from "../../core/services.js";
import type { SettingsEnv } from "../../core/platformSettings.js";
import { platformSetting } from "../../core/settings/platformRead.js";
import { getProductSyncState } from "../../core/products/store.js";
import type { ProductRow } from "../../core/repo.js";
import type { AreaId, Principal } from "../authz.js";
import { can, PLATFORM, productScope } from "../authz.js";
import { expiringCredentials } from "../../services/distribution/public.js";
import { attentionFactsFor } from "./shape.js";

export type AttentionTone = "danger" | "warning";

export type AttentionKind =
  | "sync.failed"
  | "secret.missing"
  | "secret.usage"
  | "signing.missing"
  | "mint.pending"
  | "credential.expiring"
  | "sync.paused";

/** Where the fix lives: a product page, by the console's page id. */
export interface AttentionAction {
  label: string;
  page: string;
  query?: Record<string, string>;
}

export interface AttentionItem {
  /** Unique across products: `<slug>:<kind>:<subject>`. */
  id: string;
  product: { slug: string; name: string };
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

/** One product's items, unfiltered by who is asking. `syncPaused`: the platform's Cloud Sync switch. */
export async function productAttention(
  db: Db,
  p: ProductRow,
  now: number,
  syncPaused = false,
): Promise<AttentionItem[]> {
  const product = { slug: p.slug, name: p.name || p.slug };
  const items: AttentionItem[] = [];
  const id = (kind: AttentionKind, subject = "") =>
    `${p.slug}:${kind}${subject ? `:${subject}` : ""}`;

  // The platform switch reaches every product with Cloud Sync on. The fix is the platform's, so
  // only a member who can edit the platform sees the item (`area`).
  if (syncPaused && serviceStateOf(p).services.sync.enabled)
    items.push({
      id: id("sync.paused"),
      product,
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
        page: "sync-setup",
        query: { resume: "1" },
      },
      area: "platform",
    });

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

  const creds = await expiringCredentials(
    db,
    p.slug,
    now + EXPIRY_WINDOW_SECONDS,
  );
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
  return items;
}

const RANK: Record<AttentionTone, number> = { danger: 0, warning: 1 };

/** Every visible product's items the principal may act on, the worst first. */
export async function attentionAcross(
  db: Db,
  products: ProductRow[],
  principal: Principal | null | undefined,
  now: number,
  env?: SettingsEnv,
): Promise<AttentionItem[]> {
  const syncPaused =
    env !== undefined &&
    (await platformSetting(env, db, "cloudSync.writesPaused")) === "on";
  const per = await Promise.all(
    products.map(async (p) => {
      const scope = productScope(p);
      const items = await productAttention(db, p, now, syncPaused);
      // A platform-area item (the Cloud Sync pause) is judged at platform scope: a product role
      // never holds the Platform area.
      return items.filter((i) =>
        can(
          principal,
          i.area === "platform" ? PLATFORM : scope,
          i.area,
          "view",
        ),
      );
    }),
  );
  return per
    .flat()
    .sort(
      (a, b) =>
        RANK[a.tone] - RANK[b.tone] ||
        a.product.name.localeCompare(b.product.name) ||
        a.id.localeCompare(b.id),
    );
}
