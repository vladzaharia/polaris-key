/**
 * The commerce bridge's periodic work (P6-01), on the connector cron with the store connectors
 * (`index.ts` `scheduled`). Each store is fault-isolated and skips itself when it is not set up.
 *
 *   - **Play acknowledgement retries.** A granted purchase whose acknowledgement failed is retried
 *     each tick while it is under three days old (Google's deadline; past it Google has refunded
 *     and voided it, which the voided poll then sees).
 *   - **Play Voided Purchases poll**, daily: every purchase Google voided in the last 30 days
 *     (`startTime`) is revoked — the backstop for a lost `voidedPurchaseNotification`.
 *   - **App Store re-read**, weekly per purchase: the Server API copy of every
 *     active App Store purchase is read again, so a refund whose notification was lost, refused
 *     or raced by a claim still revokes. At most `STEAM_BATCH` a tick.
 *   - **Steam ownership re-check**, weekly per purchase: Steam does not push refunds, so an active
 *     Steam grant whose owner no longer owns the DLC is revoked. At most `STEAM_BATCH` a tick.
 *
 * App Store refunds normally arrive as signed notifications; the weekly re-read is the backstop.
 */

import type { ScheduledServiceContext } from "../../../core/registry.js";
import { pk as kvKey } from "../../../kv.js";
import { readCommerceSettings } from "./settings.js";
import {
  acknowledgeOnce,
  appleContext,
  playContext,
  steamContext,
} from "./index.js";
import {
  applePurchase,
  checkTransaction,
  fetchTransaction,
  AppleRejected,
} from "./apple.js";
import { StoreUnavailable } from "./http.js";
import { listVoidedPurchases, playPurchasesClient } from "./play.js";
import { recheckSteamOwnership } from "./steam.js";
import {
  parseDetail,
  purchaseKeyHash,
  purchasesToRecheck,
  recordPurchase,
  revokeRecordedPurchase,
  type VerifiedPurchase,
} from "./state.js";

export const PLAY_ACK_WINDOW_SECONDS = 3 * 24 * 60 * 60;
export const PLAY_VOIDED_INTERVAL_SECONDS = 24 * 60 * 60;
export const PLAY_VOIDED_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
export const STEAM_RECHECK_SECONDS = 7 * 24 * 60 * 60;
export const STEAM_BATCH = 50;

export interface CommerceTick {
  acknowledged: number;
  voided: number;
  steamChecked: number;
  steamRevoked: number;
  errors: string[];
}

export async function runCommerceTick(
  ctx: ScheduledServiceContext,
): Promise<CommerceTick> {
  const out: CommerceTick = {
    acknowledged: 0,
    voided: 0,
    steamChecked: 0,
    steamRevoked: 0,
    errors: [],
  };
  if (!ctx.storeGrants || !ctx.product.services.license?.enabled) return out;
  const settings = await readCommerceSettings(ctx.db, ctx.product.slug);
  const record = {
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    storeGrants: ctx.storeGrants,
  };

  const pctx = await playContext(ctx, settings);
  if (pctx) {
    try {
      const api = playPurchasesClient(pctx, "commerce:recheck");
      // Acknowledgement retries: active purchases, under three days old, not yet acknowledged.
      const pending = await ctx.db.all<{
        purchase_key_hash: string;
        store_product_id: string;
        license_id: string;
        detail_json: string;
      }>(
        `SELECT purchase_key_hash, store_product_id, license_id, detail_json FROM dist_purchases
          WHERE product = ? AND store = 'play' AND state = 'active' AND first_seen >= ?
          ORDER BY first_seen LIMIT 50`,
        ctx.product.slug,
        ctx.now - PLAY_ACK_WINDOW_SECONDS,
      );
      for (const row of pending) {
        const detail = parseDetail(row.detail_json);
        if (
          detail.acknowledged === true ||
          typeof detail.purchaseToken !== "string"
        )
          continue;
        const purchase: VerifiedPurchase = {
          store: "play",
          purchaseKey: detail.purchaseToken,
          storeProductId: row.store_product_id,
          environment: "",
          state: "active",
          binding: null,
          detail: {},
        };
        if (
          await acknowledgeOnce(
            pctx,
            api,
            {
              ok: true,
              state: "active",
              flag: "",
              deliverable: "",
              licenseId: row.license_id,
              changed: false,
              purchaseKeyHash: row.purchase_key_hash,
            },
            purchase,
          )
        )
          out.acknowledged++;
      }
      // The daily Voided Purchases poll.
      const marker = kvKey(ctx.product.slug, "commerce-voided", "play");
      const last = Number((await ctx.env.HOT.get(marker)) ?? "0");
      if (!(ctx.now - last < PLAY_VOIDED_INTERVAL_SECONDS)) {
        const voided = await listVoidedPurchases(
          api,
          (ctx.now - PLAY_VOIDED_LOOKBACK_SECONDS) * 1000,
        );
        for (const v of voided) {
          const hash = await purchaseKeyHash("play", v.purchaseToken);
          const r = await revokeRecordedPurchase(record, "play", hash, {
            voidedAt: Math.floor(v.voidedTimeMillis / 1000) || ctx.now,
          });
          if (r?.ok && r.changed) out.voided++;
        }
        await ctx.env.HOT.put(marker, String(ctx.now), {
          expirationTtl: 2 * PLAY_VOIDED_INTERVAL_SECONDS,
        });
      }
    } catch (e) {
      out.errors.push(`play: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  const actx = await appleContext(ctx, settings);
  if (actx) {
    try {
      const due = await purchasesToRecheck(
        ctx.db,
        ctx.product.slug,
        "app-store",
        {
          before: ctx.now - STEAM_RECHECK_SECONDS,
          states: ["active"],
          limit: STEAM_BATCH,
        },
      );
      for (const row of due) {
        const d = parseDetail(row.detail_json);
        if (
          typeof d.transactionId !== "string" ||
          typeof d.environment !== "string"
        )
          continue;
        try {
          const tx = await fetchTransaction(
            actx,
            d.transactionId,
            d.environment,
            "commerce:recheck",
          );
          checkTransaction(tx, actx.settings);
          await recordPurchase(record, applePurchase(tx));
        } catch (e) {
          if (!(e instanceof StoreUnavailable || e instanceof AppleRejected))
            throw e;
          out.errors.push(`app-store row: ${e.message}`);
          // Backoff, as for Steam: due again in an hour.
          await ctx.db.run(
            `UPDATE dist_purchases SET last_verified = ?
              WHERE product = ? AND store = 'app-store' AND purchase_key_hash = ?`,
            ctx.now - STEAM_RECHECK_SECONDS + 3600,
            ctx.product.slug,
            row.purchase_key_hash,
          );
        }
      }
    } catch (e) {
      out.errors.push(
        `app-store: ${e instanceof Error ? e.message : "failed"}`,
      );
    }
  }

  const sctx = await steamContext(ctx, settings);
  if (sctx) {
    try {
      const due = await purchasesToRecheck(ctx.db, ctx.product.slug, "steam", {
        before: ctx.now - STEAM_RECHECK_SECONDS,
        states: ["active"],
        limit: STEAM_BATCH,
      });
      for (const row of due) {
        const d = parseDetail(row.detail_json);
        if (typeof d.steamId !== "string" || typeof d.dlcAppId !== "string")
          continue;
        out.steamChecked++;
        // One failing row must not block the rest. A failed row keeps its old
        // `last_verified` (retried next tick) and is reported; the batch goes on.
        let owns: boolean;
        try {
          owns = await recheckSteamOwnership(sctx, d.steamId, d.dlcAppId);
        } catch (e) {
          out.errors.push(
            `steam row: ${e instanceof Error ? e.message : "failed"}`,
          );
          // Backoff: due again in an hour, behind the rows that have not failed.
          await ctx.db.run(
            `UPDATE dist_purchases SET last_verified = ?
              WHERE product = ? AND store = 'steam' AND purchase_key_hash = ?`,
            ctx.now - STEAM_RECHECK_SECONDS + 3600,
            ctx.product.slug,
            row.purchase_key_hash,
          );
          continue;
        }
        if (owns) {
          await ctx.db.run(
            `UPDATE dist_purchases SET last_verified = ?
              WHERE product = ? AND store = 'steam' AND purchase_key_hash = ?`,
            ctx.now,
            ctx.product.slug,
            row.purchase_key_hash,
          );
        } else {
          const r = await revokeRecordedPurchase(
            record,
            "steam",
            row.purchase_key_hash,
            {
              revokedBy: "recheck",
            },
          );
          if (r?.ok && r.changed) out.steamRevoked++;
        }
      }
    } catch (e) {
      out.errors.push(`steam: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return out;
}
