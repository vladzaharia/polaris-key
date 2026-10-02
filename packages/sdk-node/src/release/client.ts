// The Release sub-client — the software TRUTH store's public face (D-05, §R1).
//
// Release owns what the software is and where it comes from: the changelog, the install script,
// the artifacts. Update owns the FEED over it (appcast, version check). They are two services
// precisely because a product can want a changelog without wanting Sparkle, and the split is
// the one place in the suite where a cross-service dependency is sanctioned (update → release).
//
// Deliberately thin: these are public, unauthenticated GETs returning JSON. There is no signed
// document here and therefore no verification — a release note is not a grant. When Release's
// access mode is `entitled` (P2.T3) the server refuses without a device token; this client
// forwards the bearer when one is held and reports the refusal — by the refusal body's own
// code — rather than inventing a retry (pinned by the release-changelog transcripts).

import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";

/** One published release, as `GET /<p>/release/changelog` reports it. */
export interface ChangelogEntry {
  version: string;
  tag: string;
  date: string | null;
  /** The curated summary, or null when the release body yielded none. */
  summary: string | null;
  url: string;
}

export class ReleaseClient {
  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
  ) {}

  /**
   * `GET /<p>/release/changelog` — the published release list, newest first.
   *
   * Throws `PolarisError("service-unavailable")` when this product does not run Release: a
   * client that has not been told the service exists must not probe for it (D-21).
   */
  async changelog(): Promise<ChangelogEntry[]> {
    this.ctx.requireService("release", Feature.releaseChangelog);
    const res = await this.get("release/changelog");
    const body = (await res.json()) as { entries?: ChangelogEntry[] };
    return Array.isArray(body.entries) ? body.entries : [];
  }

  /** The canonical install-script URL, for a host that wants to print it rather than run it. */
  installUrl(): string {
    this.ctx.requireService("release", Feature.releaseDownload);
    return this.ctx.url("release/install.sh");
  }

  /** `GET /<p>/release/dl/:version/:binary-:arch` — the artifact URL (`?checksum=sha256`
   *  supported by the server). Built, not fetched: the caller streams it themselves. */
  downloadUrl(
    version: string,
    binary: string,
    arch: string,
    opts: { checksum?: boolean; dmg?: boolean } = {},
  ): string {
    this.ctx.requireService("release", Feature.releaseDownload);
    const name = `${binary}-${arch}${opts.dmg ? ".dmg" : ""}`;
    const url = new URL(
      this.ctx.url(
        `release/dl/${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
      ),
    );
    if (opts.checksum) url.searchParams.set("checksum", "sha256");
    return url.toString();
  }

  /** Shared GET. Forwards the device token when one is held so an `entitled` feed can
   *  authenticate; a public feed simply ignores it. */
  private async get(path: string): Promise<Response> {
    const f = this.ctx.fetcher();
    const token = this.tokens.current;
    const res = await f(this.ctx.url(path), {
      headers: this.ctx.headers(
        token ? { authorization: `Bearer ${token}` } : {},
      ),
      signal: this.ctx.deadline(),
    });
    if (res.status === 401 || res.status === 403) {
      // The refusal names itself: the nested v3 shape (`{"error":{"code":…}}`, the `entitled`
      // mode) or the flat one (`{"error":"download_auth_required"}`, `authenticated`/
      // `licensed`). Surface that code rather than inventing one.
      const body = (await res.json().catch(() => ({}))) as {
        error?: string | { code?: string };
      };
      const code =
        typeof body.error === "string" ? body.error : body.error?.code;
      throw new PolarisError(
        code ||
          (res.status === 401 ? ErrorCode.unauthorized : ErrorCode.forbidden),
        res.status === 401
          ? `${path} refused: this feed needs a usable licence.`
          : `${path} refused: this build is not entitled to that feed.`,
      );
    }
    if (!res.ok) {
      throw new PolarisError(
        "not_found",
        `${path} failed with status ${res.status}.`,
      );
    }
    return res;
  }
}
