// The License sub-client — activation, entitlements, and the gate (wire contract v3 §5).
//
// ── WHAT THE GATE READS, AND WHERE EACH INPUT COMES FROM ────────────────────────────────────
//
// `status()` is a pure call into `@polaris-key/client-core`'s `licenseState`; everything interesting
// is in assembling its inputs, and each one comes from exactly one owner:
//
//   licenseServiceEnabled  `ctx.licenseGateEnabled()`: the build's `expectedServices` (default
//                          licence + config) OR a discovery loaded this session. Unsigned
//                          discovery can switch the gate on, never off. FALSE
//                          short-circuits the machine to `not-applicable` with `isUsable:
//                          true`, which is how a config-only product (one that names
//                          `expectedServices` without `license`) boots usable (D-08).
//   activation             `"token"` if a `pkeyt_` credential is held, else `"bundle"` if a
//                          verified offline import left a license document, else null. A token
//                          SUPERSEDES a bundle (§7): once the device is online-activated the
//                          bundle is history.
//   doc / highWaterMark    the re-verified cache and the monotonic floor, both Core's.
//   blocked / lastSync…    unsigned hints, for display: the document they answered for was
//                          deleted when they were set, so no verdict depends on them (§4.1).
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

/** `license.licenseInfo()`: what an account screen shows (§3.3). */
export interface LicenseInfo {
  licenseId: string;
  /** `license.tier`, the tier id. */
  tier: string | null;
  /** `license.tierLabel`, the tier's display name. */
  tierLabel: string | null;
  /** `deviceLimit`, the seats this licence holds. */
  deviceLimit: number | null;
  profile: DocProfile | null;
  entitledChannels: string[];
  /** The gate's status now. */
  status: LicenseState["status"];
}

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
  /** Called after `deactivate()` wiped the device (the facade emits `events.license`). */
  onDeactivated: () => Promise<void> | void = () => undefined;

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
    // A bundle activates ONLY when the cached bundle re-verified on the reload profile and its
    // licence document is the cached one, byte for byte (WIRE-CONTRACT-V4 §4.1, §7) — a
    // config-only bundle imports settings and grants nothing.
    if (this.cache.state.bundle?.activates && this.cache.state.license)
      return "bundle";
    return null;
  }

  status(now = nowSec()): LicenseState {
    return licenseState({
      licenseServiceEnabled: this.ctx.licenseGateEnabled(),
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

  /**
   * Whether the licence grants the boolean entitlement `name`. FALSE whenever the gate is not
   * usable (S-19 G11): a revoked, expired or blocked device holds a signed document that still
   * lists its grants, and reading them past the gate would keep paid features on after a
   * revocation. A behaviour change from earlier releases, which read the cached document alone.
   */
  isEntitled(name: string, now = nowSec()): boolean {
    if (!isUsable(this.status(now))) return false;
    const e = this.doc?.entitlements[name];
    return Boolean(e && e.value === true);
  }

  /** The raw value of entitlement `name` (a number, string, list or object), or null when the
   *  licence does not carry it or the gate is not usable (G11). */
  entitlementValue(name: string, now = nowSec()): JSONValue | null {
    if (!isUsable(this.status(now))) return null;
    const e = this.doc?.entitlements[name];
    return e === undefined ? null : e.value;
  }

  /**
   * A summary of the licence for an account screen (SDK parity pass §3.3), read from the
   * enforced entitlement names (`license.tier`, `license.tierLabel`, `deviceLimit`, `channels`)
   * and the signed profile. Null when no licence document is held. The document carries no
   * licence expiry or device count today (W3 adds `licenseExpiresAt`), so neither is invented.
   */
  licenseInfo(): LicenseInfo | null {
    const doc = this.doc;
    if (!doc) return null;
    const str = (k: string): string | null => {
      const v = doc.entitlements[k]?.value;
      return typeof v === "string" ? v : null;
    };
    const limit = doc.entitlements["deviceLimit"]?.value;
    return {
      licenseId: doc.licenseId,
      tier: str("license.tier"),
      tierLabel: str("license.tierLabel"),
      deviceLimit: typeof limit === "number" ? limit : null,
      profile: doc.profile ?? null,
      entitledChannels: this.entitledChannels(),
      status: this.status().status,
    };
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
    await Promise.resolve(this.onDeactivated()).catch(() => undefined);
  }
}
