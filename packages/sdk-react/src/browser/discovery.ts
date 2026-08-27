// Product discovery for the browser transport: `GET /<product>/.well-known/polaris.json`,
// wire contract v3.
//
// A deliberately smaller cousin of `@polaris-key/node`'s `discovery.ts`: the React SDK consumes the
// `services` map and the endpoints it needs, and preserves the rest verbatim for a host that
// wants richer onboarding metadata. The PARSING RULES are identical, and identical on purpose:
//
//   * a slug the document omits reads as DISABLED, never as "unknown, assume on";
//   * `enabled` must be a real boolean — a truthy `"false"` string reading as on is the
//     classic version of this bug;
//   * a MALFORMED `services` value rejects the whole document rather than falling back to the
//     permissive default, because silently substituting it is how a fail-closed gate becomes a
//     fail-open one.
//
// A rejected or unreachable document leaves the caller on its configured expectation
// (`expectServices`), which is the other half of D-21.

import {
  noServices,
  type ServiceSlug,
  type ServicesMap,
} from "../core/services.js";
import { SERVICE_SLUGS } from "../core/services.js";

/** One service's published fragment. `enabled` is the only field the capability map reads;
 *  the rest is the service's own business and is preserved for the UI that wants it. */
export interface ServiceFragment {
  enabled: boolean;
  endpoints?: Record<string, string>;
  [key: string]: unknown;
}

export interface DiscoveryDocument {
  product: string;
  name?: string;
  baseUrl?: string;
  core?: Record<string, unknown>;
  services: Record<ServiceSlug, ServiceFragment>;
  [key: string]: unknown;
}

export type DiscoveryResult =
  | { kind: "ok"; document: DiscoveryDocument; services: ServicesMap }
  | { kind: "invalid"; message: string }
  | { kind: "error"; status: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the `services` map. Every slug gets an entry; absent ⇒ `{enabled:false}`. Returns
 *  `null` for a malformed map, which the caller treats as a rejected document. */
export function parseServices(value: unknown): {
  fragments: Record<ServiceSlug, ServiceFragment>;
  map: ServicesMap;
} | null {
  if (!isRecord(value)) return null;
  const fragments = {} as Record<ServiceSlug, ServiceFragment>;
  const map = noServices();
  for (const slug of SERVICE_SLUGS) {
    const raw = value[slug];
    if (raw === undefined) {
      fragments[slug] = { enabled: false };
      continue;
    }
    if (!isRecord(raw)) return null;
    const enabled = raw.enabled === true;
    fragments[slug] = { ...raw, enabled } as ServiceFragment;
    map[slug] = { enabled };
  }
  return { fragments, map };
}

export function parseDiscovery(
  value: unknown,
  expectedProduct: string,
): DiscoveryResult {
  if (!isRecord(value)) {
    return {
      kind: "invalid",
      message: "Discovery document must be a JSON object.",
    };
  }
  const product =
    typeof value.product === "string" && value.product.length > 0
      ? value.product
      : typeof value.slug === "string" && value.slug.length > 0
        ? value.slug
        : null;
  if (!product) {
    return {
      kind: "invalid",
      message: "Discovery document is missing product.",
    };
  }
  if (product !== expectedProduct) {
    return {
      kind: "invalid",
      message: `Discovery document product ${product} does not match ${expectedProduct}.`,
    };
  }
  const parsed = parseServices(value.services);
  if (!parsed) {
    return {
      kind: "invalid",
      message: "Discovery services must be a map of service fragments.",
    };
  }
  return {
    kind: "ok",
    services: parsed.map,
    document: { ...value, product, services: parsed.fragments },
  };
}

export interface DiscoverOptions {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
}

export async function discoverProduct(
  opts: DiscoverOptions,
): Promise<DiscoveryResult> {
  const url = `${opts.baseUrl}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return { kind: "error", status: 0, message: (e as Error).message };
  }
  if (!res.ok) {
    return {
      kind: "error",
      status: res.status,
      message: `discovery ${res.status}`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      kind: "invalid",
      message: "Discovery response is not valid JSON.",
    };
  }
  return parseDiscovery(body, opts.product);
}
