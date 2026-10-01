// The License sub-client — activation, entitlements, and the gate (wire contract v3 §5).
//
// ── WHAT THE GATE READS, AND WHERE EACH INPUT COMES FROM ────────────────────────────────────
//
// `status()` is a pure call into `@polaris-key/client-core`'s `licenseState`; everything interesting
// is in assembling its inputs, and each one comes from exactly one owner:
//
//   licenseServiceEnabled  Core's resolved capabilities (discovery → expectedServices →
//                          default). FALSE short-circuits the machine to `not-applicable` with
//                          `isUsable: true`, which is how a config-only product boots usable
//                          instead of sitting on `needs-activation` forever (D-08).
//   activation             `"token"` if a `pkeyt_` credential is held, else `"bundle"` if a
//                          verified offline import left a license document, else null. A token
//                          SUPERSEDES a bundle (§7): once the device is online-activated the
//                          bundle is history.
//   doc / highWaterMark    the re-verified cache and the monotonic floor, both Core's.
//   blocked / lastSync…    unsigned hints that can only ever make the gate STRICTER (§4.1).
//
// Activation itself does not call `sync()` directly. It stores the token and RAISES AN EVENT;
// the facade wires that to `core.sync()`. The pre-suite client called refresh inline, which
// meant every activation path had to remember to, and a config-only product had no way to say
// "there is no licence here, sync anyway".

import { CHANNEL_STABLE, type JSONValue } from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  DocProfile,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  isUsable,
  licenseState,
  type LicenseState,
} from "@polaris-key/client-core";
import type { CacheManager } from "../core/cache.js";
import { nowSec, type CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { DevicesClient } from "../devices/client.js";
import {
  activateWithKey,
  deauthorize,
  enroll,
  type ActivationResult,
} from "./endpoints.js";

export type { ActivationResult };

export interface LicenseClientOptions {
  /** Collect a hardware fingerprint at activation. Defaults to true; set false to opt out
   *  entirely (the server then records this device as `unverified`). */
  fingerprint?: boolean;
}

/** Raised after a credential is minted, so the facade can sync without every activation path
 *  having to remember to. */
export type LicenseAcquiredListener = (
  source: ActivationSource,
) => Promise<void>;

export class LicenseClient {
  private readonly fingerprintEnabled: boolean;

  constructor(
    private readonly ctx: CoreContext,
    private readonly cache: CacheManager,
    private readonly tokens: TokenManager,
    private readonly devices: DevicesClient,
    private readonly onAcquired: LicenseAcquiredListener,
    opts: LicenseClientOptions = {},
  ) {
    this.fingerprintEnabled = opts.fingerprint !== false;
  }

  // ── Gate ──────────────────────────────────────────────────────────────────────────────
  /** How this install became activated, or null. §7: a token supersedes a bundle. */
  activation(): ActivationSource | null {
    if (this.tokens.current !== null) return "token";
    // A bundle activates ONLY if its licence document actually verified — a config-only
    // bundle imports settings and grants nothing.
    if (this.cache.state.importedBundle && this.cache.state.license)
      return "bundle";
    return null;
  }

  status(now = nowSec()): LicenseState {
    return licenseState({
      licenseServiceEnabled: this.ctx.enabled("license"),
      activation: this.activation(),
      doc: this.cache.state.license?.doc ?? null,
      now,
      highWaterMark: this.ctx.highWaterMark,
      lastSyncUnauthorized: this.cache.state.lastSyncUnauthorized,
      blocked: this.cache.state.blocked,
      lastVerifiedAt: this.cache.state.lastVerifiedAt,
    });
  }

  isLicensed(now = nowSec()): boolean {
    return isUsable(this.status(now));
  }

  // ── Reads off the license document ────────────────────────────────────────────────────
  private get doc(): LicenseDoc | null {
    return this.cache.state.license?.doc ?? null;
  }

  isEntitled(name: string): boolean {
    const e = this.doc?.entitlements[name];
    return Boolean(e && e.value === true);
  }

  getEntitlements(): Record<string, JSONValue> {
    const out: Record<string, JSONValue> = {};
    for (const [k, v] of Object.entries(this.doc?.entitlements ?? {}))
      out[k] = v.value;
    return out;
  }

  /**
   * The channels this licence grants: the `channels` entitlement's string values, in order, as
   * granted — or `["stable"]` when the entitlement is absent or not an array. This is the
   * Worker's own answer (`entitledChannels` in core/entitlements.ts), and the same list every
   * SDK returns for the same document.
   *
   * The grants are RAW: `staging` is not rewritten to `beta` here. Whether a grant covers a
   * channel is the entitlement rule's question (WIRE-CONTRACT-V3 §5.1 rule 4, `channelEntitled`),
   * not this list's; `stable` is the floor every licence holds whether or not it is listed.
   */
  entitledChannels(): string[] {
    const value = this.doc?.entitlements["channels"]?.value;
    if (!Array.isArray(value)) return [CHANNEL_STABLE];
    return value.filter((v): v is string => typeof v === "string");
  }

  /** The signed greeting block, or null. Signed so it cannot be spoofed locally. */
  getProfile(): DocProfile | null {
    return this.doc?.profile ?? null;
  }

  getLicenseId(): string | null {
    return this.doc?.licenseId ?? null;
  }

  // ── Activation ────────────────────────────────────────────────────────────────────────
  private fingerprint() {
    return this.fingerprintEnabled ? this.devices.fingerprint() : null;
  }

  /** Obtain a licence with no key and no sign-in, when the product offers a free tier. */
  async enroll(): Promise<ActivationResult> {
    const r = await enroll(this.ctx, this.fingerprint());
    if (r.kind === "ok") await this.acquire(r.token, "enroll");
    return r;
  }

  async activateWithKey(key: string): Promise<ActivationResult> {
    const r = await activateWithKey(this.ctx, key, this.fingerprint());
    if (r.kind === "ok") await this.acquire(r.token, "activate");
    return r;
  }

  private async acquire(
    token: string,
    source: "activate" | "enroll",
  ): Promise<void> {
    await this.tokens.set(token, source);
    await this.onAcquired("token");
  }

  /**
   * Deauthorize this device and wipe every local credential and artifact.
   *
   * The network call is best-effort and the local wipe is not: a device deactivating on a
   * plane must not be left holding a token because the control plane was unreachable.
   */
  async deactivate(): Promise<void> {
    const token = this.tokens.current;
    if (token) {
      // `deauthorize` swallows transport failures, including local-only mode's refusal.
      await deauthorize(this.ctx, token).catch(() => undefined);
    }
    await this.tokens.clear();
    await this.cache.clear();
  }
}
