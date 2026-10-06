// The Devices sub-client — the Core device principal's own surface (wire contract v3 §6).
//
// `register()` is the headline: until v3 the only way to become a device was to present a
// licence key, which made "device" a licensing concept. D-08 undoes that — a config-only
// product's installs need an identity to fetch a document AS and a credential to fetch it
// WITH, and `POST /<p>/devices/register` is where they get one, keylessly, under the `open`
// registration policy.
//
// The rest (`list`/`rename`/`deauthorize`/`report`) are Core surfaces available under every
// policy, which is why they live here rather than under License: a device roster is a property
// of the product's fleet, not of any one grant.

import type { HardwareFingerprint } from "@polaris-key/protocol/core";
import { PolarisError } from "@polaris-key/client-core";
import type { PackInstallReport } from "@polaris-key/client-core/packs";
import type { CoreContext } from "../core/context.js";
import type { CacheManager } from "../core/cache.js";
import type { TokenManager } from "../core/token.js";
import {
  buildSnapshot,
  reportSnapshot,
  type SnapshotExtras,
} from "../core/telemetry.js";
import { collectFingerprint } from "./fingerprint.js";
import type { ProbeDeclaration } from "./facts.js";

/** One device as the server reports it. */
export interface AccountDevice {
  id: string;
  licenseId?: string;
  label?: string | null;
  status: string;
  current: boolean;
  firstSeen?: number;
  lastSeen?: number;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

export type RegisterResult =
  | { kind: "ok"; token: string; deviceId: string }
  /** The product's policy is `requires-license` or `requires-identity`: activation (or a
   *  sign-in) is the mint path, and the endpoint refuses without telling you which. */
  | { kind: "registration-closed" }
  | { kind: "rate-limited" }
  | { kind: "not-configured" }
  | { kind: "error"; message: string };

export class DeviceManagementUnsupportedError extends Error {
  readonly code = "device-management-unsupported";

  constructor(
    message = "Remote device management is not supported by this backend.",
  ) {
    super(message);
    this.name = "DeviceManagementUnsupportedError";
  }
}

export interface DevicesClientOptions {
  /** Product-declared companion-app probes answered in the report snapshot. */
  probes?: ProbeDeclaration[];
  /** Collect a hardware fingerprint when registering. Defaults to true; the server records an
   *  opted-out device as `unverified` rather than refusing it. */
  fingerprint?: boolean;
  /** The capability list every report carries as `caps` (P1b-10). `PolarisKeyClient` wires it to
   *  its own `caps()`; a standalone `DevicesClient` without it sends no `caps`. */
  caps?: () => string[];
}

export class DevicesClient {
  private readonly probes: ProbeDeclaration[];
  private readonly fingerprintEnabled: boolean;
  private readonly caps?: () => string[];
  /** The active pack set's id for the report's `content` (P4-06), set by the facade. */
  packSetId: () => Promise<string | null> = async () => null;
  /** Recent pack installs (P4-17); wired by the client like `packSetId`. */
  packInstalls: () => PackInstallReport[] = () => [];
  /** The gate, outlet and pending update events (§3.13); wired by the client. */
  reportExtras: () => Promise<SnapshotExtras> = async () => ({});
  /** Called after the server accepted a report, with the extras it carried. */
  reportAccepted: (extras: SnapshotExtras) => Promise<void> = async () =>
    undefined;

  constructor(
    private readonly ctx: CoreContext,
    private readonly cache: CacheManager,
    private readonly tokens: TokenManager,
    opts: DevicesClientOptions = {},
  ) {
    this.probes = opts.probes ?? [];
    this.fingerprintEnabled = opts.fingerprint !== false;
    if (opts.caps) this.caps = opts.caps;
  }

  /** This machine's hashed hardware components, or null when collection is disabled or
   *  nothing could be read. Raw hardware values never leave the device. */
  fingerprint(): HardwareFingerprint | null {
    if (!this.fingerprintEnabled) return null;
    try {
      return collectFingerprint(this.ctx.product);
    } catch {
      // Best-effort: a host that refuses every probe still registers.
      return null;
    }
  }

  /**
   * `POST /<p>/devices/register` — the keyless mint path (§6).
   *
   * No `Authorization` header is sent even when a stale token is held: a client re-registering
   * is asking for a FRESH credential, not authenticating with the old one. On success the new
   * token replaces whatever was stored.
   */
  async register(): Promise<RegisterResult> {
    const r = await this.requestRegistration();
    if (r.kind === "ok") await this.tokens.set(r.token, "register");
    return r;
  }

  /**
   * The registration request alone, without storing the token. `register()` stores it; the §5
   * re-register on 401 (P1b-06) lets `TokenManager.reacquireOnce` store it instead, so the one
   * request is byte-identical on both paths: the fingerprint when enabled, never a bearer.
   *
   * @internal
   */
  async requestRegistration(): Promise<RegisterResult> {
    const fingerprint = this.fingerprint();
    // Outside the try — see `license/endpoints.ts`: a local-only refusal is a configuration
    // error the host can fix, not a transport outcome to be reported as one.
    const f = this.ctx.fetcher();
    let res: Response;
    try {
      // PX-W13 §8 Q2: the device label rides along, seeding the device's name in the lists.
      const label = this.ctx.deviceLabel();
      const body = {
        ...(fingerprint ? { fingerprint } : {}),
        ...(label ? { deviceName: label } : {}),
      };
      const init: RequestInit =
        Object.keys(body).length > 0
          ? {
              method: "POST",
              headers: {
                ...this.ctx.headers(),
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              signal: this.ctx.deadline(),
            }
          : {
              method: "POST",
              headers: this.ctx.headers(),
              signal: this.ctx.deadline(),
            };
      res = await f(this.ctx.url("devices/register"), init);
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
    if (res.status === 200) {
      const body = (await res.json()) as { token: string; deviceId: string };
      return { kind: "ok", token: body.token, deviceId: body.deviceId };
    }
    if (res.status === 403) return { kind: "registration-closed" };
    if (res.status === 429) return { kind: "rate-limited" };
    if (res.status === 404) return { kind: "not-configured" };
    return { kind: "error", message: await res.text().catch(() => "") };
  }

  /** `GET /<p>/devices` — the product's roster for this credential. */
  async list(): Promise<AccountDevice[]> {
    const token = this.requireToken();
    const f = this.ctx.fetcher();
    const res = await f(this.ctx.url("devices"), {
      headers: this.ctx.headers({ authorization: `Bearer ${token}` }),
      signal: this.ctx.deadline(),
    });
    if (!res.ok) throw new Error(`device list failed: ${res.status}`);
    const body = (await res.json()) as { devices?: AccountDevice[] };
    return Array.isArray(body.devices) ? body.devices : [];
  }

  /** `PATCH /<p>/devices/:id` — rename (self-only, server-enforced). */
  async rename(deviceId: string, label: string | null): Promise<void> {
    const token = this.requireToken();
    const f = this.ctx.fetcher();
    const res = await f(
      this.ctx.url(`devices/${encodeURIComponent(deviceId)}`),
      {
        method: "PATCH",
        headers: this.ctx.headers({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ label }),
        signal: this.ctx.deadline(),
      },
    );
    if (!res.ok) throw new Error(`device rename failed: ${res.status}`);
  }

  /** `DELETE /<p>/devices/:id` — release another device's seat. */
  async deauthorize(deviceId: string): Promise<void> {
    const token = this.requireToken();
    const f = this.ctx.fetcher();
    const res = await f(
      this.ctx.url(`devices/${encodeURIComponent(deviceId)}`),
      {
        method: "DELETE",
        headers: this.ctx.headers({ authorization: `Bearer ${token}` }),
        signal: this.ctx.deadline(),
      },
    );
    if (!res.ok) throw new Error(`device deauthorize failed: ${res.status}`);
  }

  /** `POST /<p>/devices/report` — best-effort telemetry built from re-verified documents. */
  async report(): Promise<boolean> {
    const token = this.tokens.current;
    if (!token) return false;
    const packSetId = await this.packSetId().catch(() => null);
    const extras = await this.reportExtras().catch(() => ({}));
    const accepted = await reportSnapshot(
      this.ctx,
      token,
      buildSnapshot(
        this.cache,
        this.probes,
        this.caps?.(),
        packSetId,
        this.packInstalls(),
        extras,
      ),
    );
    if (accepted) await this.reportAccepted(extras).catch(() => undefined);
    return accepted;
  }

  private requireToken(): string {
    const token = this.tokens.current;
    if (!token) {
      throw new DeviceManagementUnsupportedError(
        "Activate or register before managing devices.",
      );
    }
    return token;
  }
}
