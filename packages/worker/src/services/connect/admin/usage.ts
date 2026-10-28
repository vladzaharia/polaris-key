/**
 * `GET /manage/api/products/<slug>/connect/usage?days=30` (CC-16.W): the relay's meter.
 *
 *   { enabled: true, days: [{ day, bytes, sessions }],   // oldest first, one row per UTC day, zeros filled
 *     totals: { bytes, sessions }, people: number }
 *
 * `days` is clamped to 1..90 (default 30) and ends today (UTC). `people` counts the people with a
 * roster (`connect_rings`). Counters only: no subject or device appears. The meter holds no room
 * count (a room is a Durable Object per person), so none is returned; `sessions` is the relay
 * connections admitted. A product with Connect off answers `{ enabled: false }`.
 */

import { adminJson } from "../../../core/console/respond.js";
import type { ConnectAdminContext } from "./index.js";

const DAY = 86_400;
const iso = (sec: number): string =>
  new Date(sec * 1000).toISOString().slice(0, 10);

export async function handleRelayUsage(
  ctx: ConnectAdminContext,
): Promise<Response> {
  const { db, product, now, req } = ctx;
  if (!product.services.connect.enabled) return adminJson({ enabled: false });
  const asked = Number(new URL(req.url).searchParams.get("days") ?? 30);
  const n = Number.isInteger(asked) ? Math.min(90, Math.max(1, asked)) : 30;
  const from = iso(now - (n - 1) * DAY);
  const [rows, people] = await Promise.all([
    db.all<{ day: string; bytes: number; sessions: number }>(
      `SELECT day, bytes, sessions FROM connect_relay_daily
        WHERE product = ? AND day >= ? ORDER BY day`,
      product.slug,
      from,
    ),
    db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM connect_rings WHERE product = ?",
      product.slug,
    ),
  ]);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days = [];
  const totals = { bytes: 0, sessions: 0 };
  for (let i = n - 1; i >= 0; i--) {
    const day = iso(now - i * DAY);
    const r = byDay.get(day);
    const bytes = Number(r?.bytes ?? 0);
    const sessions = Number(r?.sessions ?? 0);
    totals.bytes += bytes;
    totals.sessions += sessions;
    days.push({ day, bytes, sessions });
  }
  return adminJson({
    enabled: true,
    days,
    totals,
    people: Number(people?.n ?? 0),
  });
}
