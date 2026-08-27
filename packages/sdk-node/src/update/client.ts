// The Update sub-client — the FEED over Release's truth store (D-05, §R1).
//
// Two jobs, both thin:
//
//   `check()`      `GET /<p>/update/version` → what the newest build on this channel is, plus
//                  whether the running version is behind it. The comparison uses client-core's
//                  `compareSemver`, the same one the server's build gate and every other SDK
//                  use — a version check that disagreed with the gate would tell a user to
//                  update to a build the gate then blocks.
//   `appcastUrl()` the Sparkle feed URL, taken from DISCOVERY rather than string-built here.
//                  §R1 moved these paths and left permanent aliases; a host that hard-codes one
//                  is a host that breaks the next time they move, whereas the discovery
//                  document is the product's own statement of where its feed lives.

import { PolarisError, compareSemver } from "@polaris-key/client-core";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import { appcastUrlFrom, type ProductDiscoveryDocument } from "../discovery.js";

export interface VersionCheck {
  /** The newest version on the requested channel. */
  version: string;
  tag: string;
  url: string;
  /** Whether the host application's own version is older than `version`. */
  updateAvailable: boolean;
}

export class UpdateClient {
  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly discovery: () => ProductDiscoveryDocument | null,
  ) {}

  /**
   * `GET /<p>/update/version` — the newest build, and whether we are behind it.
   *
   * `updateAvailable` is computed from `CoreOptions.version`, the HOST APPLICATION's version,
   * not the SDK's: the SDK ships inside the thing being updated.
   */
  async check(opts: { channel?: string } = {}): Promise<VersionCheck> {
    this.ctx.requireService("update");
    const url = new URL(this.ctx.url("update/version"));
    if (opts.channel) url.searchParams.set("channel", opts.channel);

    const f = this.ctx.fetcher();
    const token = this.tokens.current;
    const res = await f(url.toString(), {
      headers: this.ctx.headers(
        token ? { authorization: `Bearer ${token}` } : {},
      ),
      signal: this.ctx.deadline(),
    });
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      throw new PolarisError(
        body.error?.code ?? "forbidden",
        "This build is not entitled to that update channel.",
      );
    }
    if (!res.ok) {
      throw new PolarisError(
        "not_found",
        `update/version failed with status ${res.status}.`,
      );
    }
    const body = (await res.json()) as {
      version: string;
      tag: string;
      url: string;
    };
    return {
      ...body,
      updateAvailable: compareSemver(this.ctx.version, body.version) < 0,
    };
  }

  /**
   * The Sparkle appcast URL for this product, from the discovery document.
   *
   * Returns null when discovery has not been loaded or Update is not enabled — the same
   * fail-closed posture the sub-client gate takes, expressed as a value because a host asking
   * "where is my feed?" before discovery has run is a sequencing question, not an error.
   */
  appcastUrl(opts: { channel?: string; arch?: string } = {}): string | null {
    const doc = this.discovery();
    if (!doc) return null;
    return appcastUrlFrom(doc, opts);
  }
}
