// Product discovery: `GET /<product>/.well-known/polaris.json` — wire contract v3.
//
// ── WHAT CHANGED FROM v2 ────────────────────────────────────────────────────────────────────
//
// The v2 document had a `modules` object each surface re-derived its own way, so it could say
// a capability was on while its routes 404ed. v3 replaces it with a top-level `services` map
// keyed by the five service slugs, every entry a projection of one authority (the product's
// `services_json`), and a disabled service is `{"enabled": false}` and NOTHING ELSE — no
// endpoint list to read a disabled service's shape out of. See the Worker's
// `src/core/discovery.ts` for the emitting side.
//
// The document is allowed to GROW: this parser validates the fields the SDK consumes and
// preserves the rest verbatim, so a product publishing richer onboarding metadata is not
// rejected by an SDK that predates it.
//
// ── FAIL-CLOSED (D-21) ──────────────────────────────────────────────────────────────────────
//
// A slug the document omits reads as DISABLED, not as "unknown, assume on". That is the point
// of parsing it at all: the SDK gates sub-client availability on this, so a service that is
// not advertised must not be reachable. The offline fallback — what a client believes before
// it has ever seen a document — is `CoreOptions.expectedServices`, resolved in
// `CoreContext.services()`; discovery, once loaded, always wins over it.

/** The five opt-in services. Core is not a service — it is always on. */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";

/** Canonical order. Iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "update",
  "identity",
];

/** Per-service state as the SDK consumes it. */
export type ServicesMap = Record<ServiceSlug, { enabled: boolean }>;

/**
 * What a client believes when it has neither a discovery document nor a stated expectation:
 * licensing + settings distribution, which is what every product ran before the suite existed.
 * Distribution and identity are OFF, so their sub-clients refuse until something says
 * otherwise — the fail-closed half of D-21 applied to the genuinely new surfaces.
 */
export const DEFAULT_SERVICES: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

const NONE: ServicesMap = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

/** A deep copy, so a caller holding a capability map cannot mutate a shared constant or the
 *  client's own resolved state. */
export function copyServices(services: ServicesMap): ServicesMap {
  return {
    license: { ...services.license },
    config: { ...services.config },
    release: { ...services.release },
    update: { ...services.update },
    identity: { ...services.identity },
  };
}

/** Turn a host's `expectedServices` list into a full map — everything unlisted is off. */
export function servicesFromList(slugs: readonly ServiceSlug[]): ServicesMap {
  const out: ServicesMap = {
    license: { enabled: false },
    config: { enabled: false },
    release: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  };
  for (const slug of slugs) {
    if (slug in out) out[slug] = { enabled: true };
  }
  return out;
}

/** One service's published fragment. `enabled` is the only field Core reads; the rest is the
 *  service's own business and is preserved for the sub-client that wants it. */
export interface ServiceFragment {
  enabled: boolean;
  endpoints?: Record<string, string>;
  [key: string]: unknown;
}

/** Core's always-on block (design spec §2.1). */
export interface DiscoveryCore {
  registration?: "open" | "requires-identity" | "requires-license";
  compat?: { min?: string; max?: string };
  endpoints?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProductDiscoveryTrust {
  jwksUrl?: string;
  trustManifestUrl?: string;
  pinnedKeys?: Record<string, string>;
  signingKid?: string;
  signingPub?: string;
  [key: string]: unknown;
}

export interface ProductDiscoveryDocument {
  version?: number;
  protocolVersion?: number;
  schemaVersion?: number;
  product: string;
  name?: string;
  baseUrl?: string;
  core?: DiscoveryCore;
  trust?: ProductDiscoveryTrust;
  /** The v3 authority. Absent slugs read as disabled. */
  services: Record<ServiceSlug, ServiceFragment>;
  [key: string]: unknown;
}

export type DiscoverProductResult =
  | { kind: "ok"; manifest: ProductDiscoveryDocument; services: ServicesMap }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; status: number; message: string };

export interface DiscoverProductOptions {
  baseUrl: string;
  product: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

function trust(value: unknown): ProductDiscoveryTrust | undefined {
  if (!isRecord(value)) return undefined;
  const pinnedKeys = stringMap(value.pinnedKeys);
  return { ...value, ...(pinnedKeys ? { pinnedKeys } : {}) };
}

/**
 * Read the `services` map. Every slug gets an entry: present-and-enabled from the document,
 * everything else `{enabled:false}`. A malformed `services` value is NOT "assume defaults" —
 * it is a rejected document, because silently substituting the permissive default is exactly
 * how a fail-closed gate becomes a fail-open one.
 */
function parseServices(value: unknown): {
  fragments: Record<ServiceSlug, ServiceFragment>;
  map: ServicesMap;
} | null {
  if (!isRecord(value)) return null;
  const fragments = {} as Record<ServiceSlug, ServiceFragment>;
  const map = { ...NONE } as ServicesMap;
  for (const slug of SERVICE_SLUGS) {
    const raw = value[slug];
    if (raw === undefined) {
      fragments[slug] = { enabled: false };
      map[slug] = { enabled: false };
      continue;
    }
    if (!isRecord(raw)) return null;
    // `enabled` must be a real boolean. A truthy string ("false"!) reading as on is the
    // classic version of this bug.
    const enabled = raw.enabled === true;
    fragments[slug] = { ...raw, enabled } as ServiceFragment;
    map[slug] = { enabled };
  }
  return { fragments, map };
}

function parseDiscovery(
  value: unknown,
  expectedProduct: string,
): DiscoverProductResult {
  if (!isRecord(value)) {
    return {
      kind: "invalid",
      message: "Discovery document must be a JSON object.",
    };
  }
  const productRecord = isRecord(value.product) ? value.product : null;
  const product =
    optionalString(value.product) ??
    optionalString(productRecord?.slug) ??
    optionalString(value.slug);
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
  const parsedServices = parseServices(value.services);
  if (!parsedServices) {
    return {
      kind: "invalid",
      message: "Discovery services must be a map of service fragments.",
    };
  }
  const parsedTrust =
    value.trust === undefined ? undefined : trust(value.trust);
  if (value.trust !== undefined && !parsedTrust) {
    return { kind: "invalid", message: "Discovery trust must be an object." };
  }

  return {
    kind: "ok",
    services: parsedServices.map,
    manifest: {
      ...value,
      product,
      services: parsedServices.fragments,
      ...(isRecord(value.core) ? { core: value.core as DiscoveryCore } : {}),
      ...(optionalString(value.name)
        ? { name: optionalString(value.name) }
        : {}),
      ...(optionalString(value.baseUrl)
        ? { baseUrl: optionalString(value.baseUrl) }
        : {}),
      ...(parsedTrust ? { trust: parsedTrust } : {}),
    },
  };
}

export async function discoverProduct(
  opts: DiscoverProductOptions,
): Promise<DiscoverProductResult> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;

  let res: Response;
  try {
    res = await f(url, { signal: opts.signal });
  } catch (e) {
    return { kind: "error", status: 0, message: (e as Error).message };
  }

  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) {
    return {
      kind: "error",
      status: res.status,
      message: await res.text().catch(() => ""),
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

/** The absolute appcast URL a Sparkle host should feed its updater, taken from Update's
 *  published fragment rather than string-built by the caller (§R1 moves these paths). */
export function appcastUrlFrom(
  doc: ProductDiscoveryDocument,
  opts: { channel?: string; arch?: string } = {},
): string | null {
  const base = doc.services.update?.endpoints?.appcast;
  if (!base || !doc.services.update.enabled) return null;
  const url = new URL(base);
  if (opts.arch) url.searchParams.set("arch", opts.arch);
  if (opts.channel && opts.channel !== "stable") {
    // `/update/<channel>/appcast.xml` is a PATH, not a query parameter (§R1) — the published
    // endpoint is the stable feed, and a channel feed is its sibling.
    url.pathname = url.pathname.replace(
      /\/appcast\.xml$/,
      `/${encodeURIComponent(opts.channel)}/appcast.xml`,
    );
  }
  return url.toString();
}
