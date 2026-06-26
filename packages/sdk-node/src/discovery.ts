// Product discovery: GET /<product>/.well-known/polaris.json. The document is allowed
// to grow over time, so the SDK validates the stable fields it consumes and preserves
// the rest for adopters that want richer onboarding metadata.

export interface ProductDiscoveryEndpoints {
  activate?: string;
  token?: string;
  config?: string;
  deauthorize?: string;
  report?: string;
  jwks?: string;
  schema?: string;
  [key: string]: string | undefined;
}

export interface ProductDiscoveryTrust {
  jwksUrl?: string;
  pinnedKeys?: Record<string, string>;
  signingKid?: string;
  signingPub?: string;
  [key: string]: unknown;
}

export interface ProductDiscoveryDocument {
  schemaVersion?: number;
  product: string;
  name?: string;
  baseUrl?: string;
  endpoints?: ProductDiscoveryEndpoints;
  trust?: ProductDiscoveryTrust;
  sdk?: Record<string, unknown>;
  [key: string]: unknown;
}

export type DiscoverProductResult =
  | { kind: "ok"; manifest: ProductDiscoveryDocument }
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

function endpoints(value: unknown): ProductDiscoveryEndpoints | undefined {
  if (!isRecord(value)) return undefined;
  const out: ProductDiscoveryEndpoints = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

function trust(value: unknown): ProductDiscoveryTrust | undefined {
  if (!isRecord(value)) return undefined;
  const pinnedKeys = stringMap(value.pinnedKeys);
  return {
    ...value,
    ...(optionalString(value.jwksUrl)
      ? { jwksUrl: optionalString(value.jwksUrl) }
      : {}),
    ...(optionalString(value.signingKid)
      ? { signingKid: optionalString(value.signingKid) }
      : {}),
    ...(optionalString(value.signingPub)
      ? { signingPub: optionalString(value.signingPub) }
      : {}),
    ...(pinnedKeys ? { pinnedKeys } : {}),
  };
}

function parseDiscovery(
  value: unknown,
  expectedProduct: string,
): DiscoverProductResult {
  if (!isRecord(value))
    return {
      kind: "invalid",
      message: "Discovery document must be a JSON object.",
    };
  const productRecord = isRecord(value.product) ? value.product : null;
  const product =
    optionalString(value.product) ??
    optionalString(productRecord?.slug) ??
    optionalString(value.slug);
  if (!product)
    return {
      kind: "invalid",
      message: "Discovery document is missing product.",
    };
  if (product !== expectedProduct) {
    return {
      kind: "invalid",
      message: `Discovery document product ${product} does not match ${expectedProduct}.`,
    };
  }
  const parsedEndpoints =
    value.endpoints === undefined ? undefined : endpoints(value.endpoints);
  if (value.endpoints !== undefined && !parsedEndpoints) {
    return {
      kind: "invalid",
      message: "Discovery endpoints must be a string map.",
    };
  }
  const parsedTrust =
    value.trust === undefined ? undefined : trust(value.trust);
  if (value.trust !== undefined && !parsedTrust) {
    return { kind: "invalid", message: "Discovery trust must be an object." };
  }

  return {
    kind: "ok",
    manifest: {
      ...value,
      product,
      ...(typeof value.schemaVersion === "number"
        ? { schemaVersion: value.schemaVersion }
        : {}),
      ...(optionalString(value.name)
        ? { name: optionalString(value.name) }
        : {}),
      ...(optionalString(value.baseUrl)
        ? { baseUrl: optionalString(value.baseUrl) }
        : {}),
      ...(parsedEndpoints ? { endpoints: parsedEndpoints } : {}),
      ...(parsedTrust ? { trust: parsedTrust } : {}),
      ...(isRecord(value.sdk) ? { sdk: value.sdk } : {}),
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
  if (!res.ok)
    return {
      kind: "error",
      status: res.status,
      message: await res.text().catch(() => ""),
    };

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
