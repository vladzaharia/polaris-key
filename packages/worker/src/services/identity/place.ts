/// <reference types="@cloudflare/workers-types" />

// The coarse place a request came from (I-37: moved from `portal/deviceLogin.ts`, same service).
// Cloudflare's edge writes it, never the client. Used by the portal's device approval and by the
// device-code confirm page.

import { displayValue } from "../../core/notify/templates.js";

/** A coarse place from Cloudflare's edge geolocation; every field may be unknown. */
export interface DeviceLoginLocation {
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2, upper-case. */
  country: string | null;
  /** "Lisbon, Portugal", or null when nothing is known. */
  label: string | null;
}

function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The request's coarse place: Cloudflare's `request.cf` (city, region, country), falling back to
 * the `cf-ipcountry` header the edge sets. Both are written by Cloudflare, never the client. Each
 * value is cleaned (`displayValue`) because it reaches an email subject's neighbourhood.
 */
export function requestLocation(req: Request): DeviceLoginLocation {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? displayValue(v, "") || null : null;
  const rawCountry =
    str(cf.country) ?? str(req.headers.get("cf-ipcountry")) ?? null;
  // `XX` (unknown) and `T1` (Tor) are Cloudflare's "no country".
  const country =
    rawCountry &&
    /^[A-Za-z]{2}$/.test(rawCountry) &&
    !/^(XX|T1)$/i.test(rawCountry)
      ? rawCountry.toUpperCase()
      : null;
  const city = str(cf.city);
  const region = str(cf.region);
  const parts = [city, country ? countryName(country) : region].filter(
    (p): p is string => Boolean(p),
  );
  return {
    city,
    region,
    country,
    label: parts.length ? parts.join(", ") : null,
  };
}
