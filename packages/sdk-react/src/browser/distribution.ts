// The distribution model for the browser transport (SDK parity pass §3.8, feature
// `release.distribution`): every way to get the product, per platform, as the Worker's download
// page renders it (`GET /<p>/distribution/download.json`, packages/worker/src/services/
// distribution/page/model.ts). `@polaris-key/node`'s `distribution.downloadModel()` and
// `thisPlatform()`, field for field.
//
// Public and unsigned, like a release note: it is a listing, not a grant, so there is nothing to
// verify and no credential goes with it (no bearer, no cookie). The Worker's CORS list covers
// the route. Standalone functions, so the adapter and the transcript replayer drive the same code.

import { ErrorCode } from "../constants.generated.js";
import { PolarisError } from "../core/types.js";
import { wireCodeOf } from "./update.js";
import {
  osFamily,
  pageEnvironment,
  type BrowserFactsEnvironment,
} from "./bearer/facts.js";

/** One downloadable build. */
export interface DownloadBuild {
  releaseId: string;
  version: string;
  buildId: string;
  platform: string;
  arch: string;
  format: string | null;
  name: string;
  size: number | null;
  sha256: string | null;
  minOs: string | null;
  url: string;
  outletId: string;
}

/** One way to get the product (a store, a package manager, a direct download). */
export interface DownloadAction {
  id: string;
  kind: string;
  outletId: string;
  platforms: string[];
  label: string;
  url: string | null;
  deepLink: string | null;
  qr: string | null;
  command: string | null;
  fingerprint: string | null;
  version: string | null;
  build: DownloadBuild | null;
}

export interface DownloadPlatformGroup {
  platform: string;
  label: string;
  primary: string | null;
  actions: string[];
  builds: DownloadBuild[];
}

/** `GET /<p>/distribution/download.json`. */
export interface DownloadModel {
  schemaVersion: number;
  product: { slug: string; name: string };
  channel: string;
  pageUrl: string | null;
  listing: {
    name: string;
    subtitle: string | null;
    description: string | null;
    developerName: string | null;
    website: string | null;
  };
  release: {
    releaseId: string;
    version: string;
    title: string | null;
    publishedAt: number | null;
    summary: string | null;
  } | null;
  platforms: DownloadPlatformGroup[];
  actions: DownloadAction[];
  keys: { purpose: string; sha256: string; outletId: string | null }[];
}

/** `thisPlatform()`: one platform's group with its actions resolved, the primary first, and the
 *  other platforms for an "Also on" list. */
export interface ThisPlatform {
  platform: string | null;
  primary: DownloadAction | null;
  actions: DownloadAction[];
  builds: DownloadBuild[];
  alsoOn: { platform: string; label: string }[];
}

/** Fetch the download model, optionally for one channel. Throws `PolarisError`: `network` for a
 *  transport failure, the server's code (`not_found`, …) for a refusal, `bad_response` for a body
 *  that is not a model. */
export async function fetchDownloadModel(o: {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  channel?: string;
}): Promise<DownloadModel> {
  const url = new URL(
    `${o.baseUrl.replace(/\/+$/, "")}/${o.product}/distribution/download.json`,
  );
  if (o.channel) url.searchParams.set("channel", o.channel);
  let res: Response;
  try {
    res = await o.fetchImpl(url.toString(), {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new PolarisError(
      "network",
      (e as Error).message,
      ErrorCode.networkError,
    );
  }
  if (!res.ok) {
    const code = (await wireCodeOf(res)) ?? ErrorCode.notFound;
    throw new PolarisError(
      ERROR_CODES.has(code) ? (code as ErrorCode) : ErrorCode.notFound,
      `distribution/download.json failed with status ${res.status}.`,
      code,
    );
  }
  const model = (await res.json().catch(() => null)) as DownloadModel | null;
  if (
    !model ||
    typeof model !== "object" ||
    !Array.isArray(model.platforms) ||
    !Array.isArray(model.actions)
  )
    throw new PolarisError(
      ErrorCode.badResponse,
      "distribution/download.json is not a download model.",
      ErrorCode.badResponse,
    );
  return model;
}

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/** Resolve one platform's group from a model (pure). */
export function pickPlatform(
  model: DownloadModel,
  platform: string | null,
): ThisPlatform {
  const byId = new Map(model.actions.map((a) => [a.id, a]));
  const group = model.platforms.find((p) => p.platform === platform) ?? null;
  const actions = (group?.actions ?? [])
    .map((id) => byId.get(id))
    .filter((a): a is DownloadAction => a !== undefined);
  return {
    platform,
    primary: group?.primary ? (byId.get(group.primary) ?? null) : null,
    actions,
    builds: group?.builds ?? [],
    alsoOn: model.platforms
      .filter((p) => p.platform !== platform)
      .map((p) => ({ platform: p.platform, label: p.label })),
  };
}

/** The visitor's operating system as a download-page platform (`macos`, `windows`, `linux`,
 *  `android`, `ios`), from the same coarse OS family a report carries (`userAgentData.platform`,
 *  else the user agent), or null when it is none of those (or there is no navigator). */
export function browserPlatform(
  env: BrowserFactsEnvironment = pageEnvironment(),
): string | null {
  const family = osFamily(env);
  return DOWNLOAD_PLATFORMS.has(family) ? family : null;
}

const DOWNLOAD_PLATFORMS = new Set([
  "macos",
  "windows",
  "linux",
  "android",
  "ios",
]);
