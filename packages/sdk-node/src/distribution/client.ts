// The Distribution sub-client (SDK parity pass §3.8, proposed id `release.distribution`): the
// public download model — every way to get the product, per platform, as the Worker's download
// page renders it (`GET /<p>/distribution/download.json`, packages/worker/src/services/
// distribution/page/model.ts). A CLI's "get it on your other machines" line, an Electron app's
// "also on" menu and a web download button all read this one document.
//
// Public and unsigned, like a release note: it is a listing, not a grant, so there is nothing to
// verify. The bearer is never sent.

import { platform as osPlatform } from "node:os";
import { PolarisError, canonicalPlatform } from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { readJson, responseError } from "../core/http.js";

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

/** `distribution.thisPlatform()`: this platform's group with its actions resolved, the primary
 *  first, and the other platforms for an "Also on" list. */
export interface ThisPlatform {
  platform: string | null;
  primary: DownloadAction | null;
  actions: DownloadAction[];
  builds: DownloadBuild[];
  alsoOn: { platform: string; label: string }[];
}

export class DistributionClient {
  constructor(private readonly ctx: CoreContext) {}

  /** The download model, optionally for one channel. */
  async downloadModel(opts: { channel?: string } = {}): Promise<DownloadModel> {
    this.ctx.requireService("distribution", Feature.releaseDownload);
    const url = new URL(this.ctx.url("distribution/download.json"));
    if (opts.channel) url.searchParams.set("channel", opts.channel);
    const what = "distribution/download.json";
    const res = await this.ctx.request(
      url.toString(),
      { headers: this.ctx.headers({ accept: "application/json" }) },
      what,
    );
    if (!res.ok) throw await responseError(res, what);
    const model = await readJson<DownloadModel | null>(res, what);
    if (
      !model ||
      !Array.isArray(model.platforms) ||
      !Array.isArray(model.actions)
    )
      throw new PolarisError(
        ErrorCode.badResponse,
        "distribution/download.json is not a download model.",
      );
    return model;
  }

  /** This platform first (`os.platform()`'s canonical value unless `platform` is given). */
  async thisPlatform(
    opts: { channel?: string; platform?: string } = {},
  ): Promise<ThisPlatform> {
    const model = await this.downloadModel(opts);
    return pickPlatform(
      model,
      opts.platform ?? canonicalPlatform(osPlatform()),
    );
  }
}

/** Resolve one platform's group from a model (pure; exported for hosts with their own fetch). */
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
