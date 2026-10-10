/**
 * Product-wide devices (`/manage/api/products/<slug>/devices…`): every device of a product,
 * whether or not it holds a license.
 *
 * A CORE per-product resource, not License's: an open- or requires-identity-registration game
 * has devices and no licenses at all, and License's `licenses/<id>/devices` can only reach a
 * device through the license it holds. The two routes share their write effects
 * (`core/console/deviceAdmin.ts`) so a deauthorize means the same thing whichever door it came through.
 *
 *   GET  devices                          paged list (status, platform, licensed, q, limit, cursor)
 *   GET  devices/summary                  counts for the console's chips
 *   GET  devices/<id>                     one device with fingerprint and facts
 *   POST devices/<id>/deauthorize
 *   POST devices/<id>/fingerprint/reset
 *
 * Reads and writes go through `core/repo.ts`; nothing here imports a service.
 *
 * Privacy: only what the license view already shows. Raw hardware values never exist server-side
 * (rule 7), and `lastSeen` is "last seen", not "online".
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { DeviceRow } from "../../core/repo.js";
import { ErrorCode } from "../../core/errors.js";
import { getDevice, getDeviceFacts, getFingerprint } from "../../core/repo.js";
import {
  deauthorizeDeviceAsAdmin,
  resetDeviceFingerprintAsAdmin,
} from "../../core/console/deviceAdmin.js";
import {
  shapeFacts,
  shapeFingerprint,
} from "../../core/console/deviceShape.js";
import { adminJson, err, notFound } from "../../core/console/respond.js";
import { deviceSummary, listDevicesPage } from "../../core/console/repo.js";
import type { AdminSession } from "../../core/console/session.js";
import {
  b64urlDecodeBinaryUnpadded,
  b64urlEncodeBinary,
} from "../../platform/bytes.js";

export const DEVICE_PAGE_DEFAULT = 50;
export const DEVICE_PAGE_MAX = 200;
const MAX_FILTER_LEN = 64;

/** The stored verdict summary, or null when absent or unreadable. */
function parseVerdict(
  json: string | null | undefined,
): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The list-row shape: the license view's, minus fingerprint and facts, plus license + seat. */
function shapeSummary(d: DeviceRow): Record<string, unknown> {
  return {
    deviceId: d.device_id,
    status: d.status,
    firstSeen: d.first_seen,
    lastSeen: d.last_seen,
    ua: d.ua ?? undefined,
    label: d.label ?? undefined,
    platform: d.platform ?? undefined,
    arch: d.arch ?? undefined,
    appVersion: d.app_version ?? undefined,
    sdkName: d.sdk_name ?? undefined,
    sdkVersion: d.sdk_version ?? undefined,
    // `''` is the stored sentinel for "no license" (NO_LICENSE_ID); on the wire it is null.
    licenseId: d.license_id === "" ? null : d.license_id,
    seatNo: d.seat_no ?? null,
    // PX-W17: the signed-in account as this product sees it (`ps_…`), or null. Only ever a
    // pairwise subject: no device of an Identity-off product carries one.
    subject: d.subject ?? null,
    // P6-02: the trust level and the last attestation verdict (a summary; never a raw token).
    trustLevel: d.trust_level === "attested" ? "attested" : "basic",
    attestedAt: d.attested_at ?? null,
    lastVerdict: parseVerdict(d.attestation_json),
  };
}

// ── cursor ───────────────────────────────────────────────────────────────────
// Opaque to the client: base64url of `[lastSeen, deviceId]`. Nothing here is secret (both values
// are in the row the previous page returned) so it is encoded, not signed.
function encodeCursor(row: DeviceRow): string {
  return b64urlEncodeBinary(JSON.stringify([row.last_seen, row.device_id]));
}

function decodeCursor(
  raw: string,
): { lastSeen: number; deviceId: string } | null {
  try {
    const parsed: unknown = JSON.parse(b64urlDecodeBinaryUnpadded(raw));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isInteger(parsed[0]) &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0 &&
      parsed[1].length <= 200
    ) {
      return { lastSeen: parsed[0] as number, deviceId: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

function badParam(field: string): Response {
  return err(400, ErrorCode.BadRequest, `invalid query parameter: ${field}`, {
    field,
  });
}

async function handleList(
  req: Request,
  db: Db,
  slug: string,
): Promise<Response> {
  const sp = new URL(req.url).searchParams;

  const status = sp.get("status") ?? "authorized";
  if (status !== "authorized" && status !== "deauthorized" && status !== "all")
    return badParam("status");

  let licensed: boolean | undefined;
  const licensedRaw = sp.get("licensed");
  if (licensedRaw !== null && licensedRaw !== "") {
    if (licensedRaw !== "true" && licensedRaw !== "false")
      return badParam("licensed");
    licensed = licensedRaw === "true";
  }

  const limitRaw = sp.get("limit");
  let limit = DEVICE_PAGE_DEFAULT;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) return badParam("limit");
    limit = Number(limitRaw);
    if (limit < 1 || limit > DEVICE_PAGE_MAX) return badParam("limit");
  }

  const platform = sp.get("platform") || undefined;
  if (platform !== undefined && platform.length > MAX_FILTER_LEN)
    return badParam("platform");
  const q = sp.get("q")?.trim() || undefined;
  if (q !== undefined && q.length > MAX_FILTER_LEN) return badParam("q");

  let after: { lastSeen: number; deviceId: string } | undefined;
  const cursorRaw = sp.get("cursor");
  if (cursorRaw) {
    const c = decodeCursor(cursorRaw);
    if (!c) return badParam("cursor");
    after = c;
  }

  const rows = await listDevicesPage(db, slug, {
    status,
    platform,
    licensed,
    q,
    limit,
    after,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return adminJson({
    devices: page.map(shapeSummary),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  });
}

export async function handleProductDevices(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const [first, action, sub] = rest;

  if (first === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return handleList(req, db, slug);
  }

  // Device ids are 32 URL-safe characters, so the literal `summary` can never collide with one.
  if (first === "summary") {
    if (action !== undefined) return notFound();
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson(await deviceSummary(db, slug));
  }

  const deviceId = first;
  const isDeauthorize = action === "deauthorize" && sub === undefined;
  const isReset = action === "fingerprint" && sub === "reset";
  if (action !== undefined && !isDeauthorize && !isReset) return notFound();

  if (action === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const device = await getDevice(db, slug, deviceId);
    if (!device) return notFound();
    return adminJson({
      ...shapeSummary(device),
      fingerprint: shapeFingerprint(await getFingerprint(db, slug, deviceId)),
      facts: shapeFacts(await getDeviceFacts(db, slug, deviceId)),
    });
  }

  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const device = await getDevice(db, slug, deviceId);
  if (!device) return notFound();
  const ctx = { env, db, session, now };
  if (isDeauthorize) await deauthorizeDeviceAsAdmin(ctx, device);
  else await resetDeviceFingerprintAsAdmin(ctx, device);
  return adminJson({ ok: true, deviceId });
}
