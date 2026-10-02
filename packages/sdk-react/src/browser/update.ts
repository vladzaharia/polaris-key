// The wire v4 update decision for the browser transport (WIRE-CONTRACT-V4 §2.5, plans/P3-01.md
// §2.8). Everything that decides lives in `@polaris-key/client-core` (`runUpdateCheck`): the
// verification order, the floors, the fallback and the error map are the ones every SDK runs.
// This module is only the browser's transport around it: the two discovery endpoints, two
// `fetch` calls, and the mapping of a refusal onto React's `PolarisError`.
//
// It is a standalone function, like `fetchChangelog`, so the browser adapter and the React
// transcript replayer drive the same code.
//
// ── WHAT THE BROWSER TRUSTS ─────────────────────────────────────────────────────────────────
//
//   * feeds verify against the product keys the page PINS (`trust.pinnedKeys`): a browser holds
//     no verified trust manifest, so its effective product trust set is its pins;
//   * records verify against `update.pinnedReleaseKeys` only, never a product key;
//   * the outlet is the host's value, else the build stamp the web runtime synthesises
//     (`outletKind: "web"`, plans/P3-01.md §2.9), through `resolveUpdateOutlet`.

import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type {
  BinaryMethod,
  InstalledBuild,
  UpdateCheck,
} from "@polaris-key/protocol/update";
import {
  runUpdateCheck,
  type FetchOutcome,
  type ResolvedOutlet,
  type UpdateCheckContent,
  type UpdateCheckError,
  type VerifiedRevocation,
} from "@polaris-key/client-core";
import { ERROR_CODE_VALUES } from "../constants.generated.js";
import {
  PolarisError,
  type PolarisErrorCode,
  type UpdateDecideOptions,
} from "../core/types.js";
import type { DiscoveryDocument } from "./discovery.js";
import type { TrustSet } from "./offline.js";

/** The two cache slices (`CacheRecordV3.feeds` and `.releaseRecords`). */
export interface UpdateSlices {
  feeds?: Record<string, string>;
  releaseRecords?: Record<string, string>;
}

export interface BrowserDecideOptions extends UpdateDecideOptions {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  /** The `X-PKey-*` metadata a public read carries. */
  headers: Record<string, string>;
  /** The verified discovery document, or null when discovery has not answered. */
  discovery: DiscoveryDocument | null;
  /** The pinned product keys: the browser's effective product trust set. */
  trust: TrustSet;
  /** `pinnedReleaseKeys`. */
  releaseKeys: TrustSet;
  /** Epoch seconds. */
  now: number;
  /** The rollout bucket's install id (the page's device id), or null for none (out of every
   *  client-evaluated rollout). */
  installId: string | null;
  installed: InstalledBuild;
  outlet: ResolvedOutlet;
  methods: readonly BinaryMethod[];
  cache: UpdateSlices;
  /** The content decision's inputs (plans/P4-13.md §2.5): the page's pack facet's
   *  `contentInput()`. Omitted: no content decision. */
  content?: UpdateCheckContent;
}

export interface BrowserDecideResult {
  check: UpdateCheck;
  /** The slices to persist. */
  cache: Required<UpdateSlices>;
  /** With `content`: the revocations to keep (`BrowserPacks.recordRevocations`). */
  revocations?: {
    learned: { revocation: VerifiedRevocation; jws: string }[];
    relearnCleared: string[];
  };
}

/** The transport's own code for a failed fetch: React's `network`, unless the Worker's answer
 *  names a wire code (`feed_not_composable`, …), which `errors` then carries instead. */
const NETWORK = "network";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A service fragment's endpoint template, or null when the fragment lacks it. */
function endpoint(
  discovery: DiscoveryDocument | null,
  service: "update" | "release" | "distribution",
  name: string,
): string | null {
  const fragment = discovery?.services?.[service as never] as unknown;
  if (!isRecord(fragment) || fragment.enabled !== true) return null;
  const endpoints = fragment.endpoints;
  if (!isRecord(endpoints)) return null;
  const t = endpoints[name];
  return typeof t === "string" && t !== "" ? t : null;
}

/** Substitute `{name}` placeholders (percent-encoded) and resolve against the control plane. */
function expand(
  template: string,
  baseUrl: string,
  values: Record<string, string>,
): URL {
  let out = template;
  for (const [k, v] of Object.entries(values))
    out = out.split(`{${k}}`).join(encodeURIComponent(v));
  return new URL(out, `${baseUrl}/`);
}

/** The wire code a refusal body names (`{error: {code}}` or `{error: "code"}`), or null. */
async function wireCodeOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const e = body.error;
    if (typeof e === "string" && e !== "") return e;
    if (isRecord(e) && typeof e.code === "string" && e.code !== "")
      return e.code;
    return null;
  } catch {
    return null;
  }
}

async function getJose(
  url: URL,
  o: BrowserDecideOptions,
  maxBytes?: number,
): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await o.fetchImpl(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/jose", ...o.headers },
    });
  } catch {
    return { ok: false, code: NETWORK };
  }
  if (!res.ok) return { ok: false, code: (await wireCodeOf(res)) ?? NETWORK };
  if (maxBytes !== undefined) {
    // §2.5 step 11: stop reading once the body cannot be a record any feed pins. The verifier
    // refuses such a body at step `hash` without hashing it, so a stand-in of the bound + 1
    // bytes carries the same verdict without buffering the rest.
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        // Nothing to release.
      }
      return { ok: true, body: "\u0000".repeat(maxBytes + 1) };
    }
  }
  try {
    const text = await res.text();
    return {
      ok: true,
      body:
        maxBytes !== undefined && text.length > maxBytes
          ? text.slice(0, maxBytes + 1)
          : text,
    };
  } catch {
    return { ok: false, code: NETWORK };
  }
}

const REGISTERED = new Set<string>(ERROR_CODE_VALUES);

/** Raise §2.5's "nothing to decide from" error as React's `PolarisError`. A transport failure
 *  is `network`, with the Worker's wire code as `wireCode` when its answer named one. */
function raise(error: UpdateCheckError): PolarisError {
  const message = error.detail
    ? `${error.code} (${error.detail})`
    : `update decision: ${error.code}`;
  const ui: readonly string[] = [
    "feed-rejected",
    "feed-rollback",
    "record-rejected",
    "record-mismatch",
    NETWORK,
  ];
  if (ui.includes(error.code) && REGISTERED.has(error.code))
    return new PolarisError(
      error.code as PolarisErrorCode,
      message,
      undefined,
      error.detail ?? undefined,
    );
  return new PolarisError(NETWORK, message, error.code);
}

/**
 * §2.5 steps 1–18 for a browser. Step 1 reads the two endpoints from discovery and refuses with
 * `service-unavailable` before dialling when either is absent. The rest is `runUpdateCheck`
 * over two credentialed `fetch` calls (`application/jose`). Throws `PolarisError`.
 */
export async function decideBrowserUpdate(
  o: BrowserDecideOptions,
): Promise<BrowserDecideResult> {
  const feedTemplate = endpoint(o.discovery, "update", "feed");
  const recordTemplate = endpoint(o.discovery, "release", "record");
  if (feedTemplate === null || recordTemplate === null)
    throw new PolarisError(
      "service-unavailable",
      "This Worker serves no signed update feed; use checkUpdate().",
    );
  const platform = o.installed.platform;
  const r = await runUpdateCheck({
    ...(o.content ? { content: o.content } : {}),
    channel: o.channel ?? "stable",
    expectedAud: o.product,
    trust: o.trust,
    releaseKeys: o.releaseKeys,
    now: o.now,
    installId: o.installId,
    installed: o.installed,
    outlet: { id: o.outlet.id, kind: o.outlet.kind },
    subkind: o.outlet.subkind,
    staged: o.staged ?? null,
    skipVersion: o.skipVersion ?? null,
    methods: o.methods,
    cache: o.cache,
    fetchFeed: (channel) => {
      const url = expand(feedTemplate, o.baseUrl, { channel });
      url.searchParams.set("platform", platform);
      return getJose(url, o);
    },
    fetchRecord: (sha256) =>
      getJose(
        expand(recordTemplate, o.baseUrl, { sha256 }),
        o,
        MAX_RECORD_JWS_BYTES,
      ),
  });
  if (!r.ok) throw raise(r.error);
  return {
    check: r.check,
    cache: r.cache,
    ...(r.revocations ? { revocations: r.revocations } : {}),
  };
}

/**
 * A build's download URL (plans/P3-01.md §2.4): `distribution.endpoints.builds`, else
 * `release.endpoints.builds`, with `{selector}` = the record's version and `{buildId}` = the
 * build's id, each percent-encoded. That route serves the payload from every location; the
 * blob route is R2-only, so it is never used. Null when discovery has neither template.
 */
export function buildDownloadUrlFor(
  discovery: DiscoveryDocument | null,
  baseUrl: string,
  version: string,
  buildId: string,
): string | null {
  const template =
    endpoint(discovery, "distribution", "builds") ??
    endpoint(discovery, "release", "builds");
  if (template === null) return null;
  return expand(template, baseUrl, { selector: version, buildId }).toString();
}
