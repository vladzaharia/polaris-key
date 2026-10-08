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
import { ErrorCode } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import {
  classifyResponse,
  readJson,
  responseError,
  transportError,
} from "../core/http.js";
import { redactOnPrint } from "../core/redact.js";
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
  /** The token is stored. It stays readable here, but the result prints (`console.log`,
   *  `util.inspect`, `JSON.stringify`) with it redacted. */
  | { kind: "ok"; token: string; deviceId: string }
  /** The product's policy is `requires-license` or `requires-identity`: activation (or a
   *  sign-in) is the mint path, and the endpoint refuses without telling you which. */
  | { kind: "registration-closed" }
  /** A 429; `retryAfterSeconds` from its `Retry-After` header when present. */
  | { kind: "rate-limited"; retryAfterSeconds?: number }
  | { kind: "not-configured" }
  /** The one taxonomy's failures (SP-46): `network-error` (no answer), `server-error` (a 5xx),
   *  `bad_response` (a 200 without a token), or the server's code for any other refusal. */
  | { kind: "error"; code: string; status?: number; message: string };

/** Remote device management needs a credential this client does not hold. A `PolarisError`
 *  with code `device-management-unsupported`. */
export class DeviceManagementUnsupportedError extends PolarisError {
  constructor(
    message = "Remote device management is not supported by this backend.",
  ) {
    super(ErrorCode.deviceManagementUnsupported, message);
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
      return {
        kind: "error",
        code: ErrorCode.networkError,
        message: transportError(e, "devices/register").message,
      };
    }
    if (res.status === 200) {
      let body: { token?: unknown; deviceId?: unknown } | null;
      try {
        body = await readJson(res, "devices/register");
      } catch (e) {
        const err = e as PolarisError;
        return { kind: "error", code: err.code, message: err.message };
      }
      if (typeof body?.token !== "string" || body.token === "")
        return {
          kind: "error",
          code: ErrorCode.badResponse,
          status: 200,
          message: "devices/register answered without a device token.",
        };
      return redactOnPrint<RegisterResult & { kind: "ok" }>(
        { kind: "ok", token: body.token, deviceId: String(body.deviceId) },
        ["token"],
      );
    }
    if (res.status === 403) return { kind: "registration-closed" };
    if (res.status === 404) return { kind: "not-configured" };
    const c = await classifyResponse(res);
    if (res.status === 429)
      return {
        kind: "rate-limited",
        ...(c.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: c.retryAfterSeconds }
          : {}),
      };
    return {
      kind: "error",
      code: c.code,
      status: res.status,
      message:
        c.message ?? `devices/register failed with status ${res.status}.`,
    };
  }

  /** `GET /<p>/devices` — the product's roster for this credential. Throws `PolarisError` in
   *  the one taxonomy (SP-46) on a failure. */
  async list(): Promise<AccountDevice[]> {
    const token = this.requireToken();
    const what = "device list";
    const res = await this.ctx.request(
      this.ctx.url("devices"),
      { headers: this.ctx.headers({ authorization: `Bearer ${token}` }) },
      what,
    );
    if (!res.ok) throw await responseError(res, what);
    const body = await readJson<{ devices?: AccountDevice[] } | null>(
      res,
      what,
    );
    return Array.isArray(body?.devices) ? body.devices : [];
  }

  /** `PATCH /<p>/devices/:id` — rename (self-only, server-enforced). */
  async rename(deviceId: string, label: string | null): Promise<void> {
    const token = this.requireToken();
    const what = "device rename";
    const res = await this.ctx.request(
      this.ctx.url(`devices/${encodeURIComponent(deviceId)}`),
      {
        method: "PATCH",
        headers: this.ctx.headers({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ label }),
      },
      what,
    );
    if (!res.ok) throw await responseError(res, what);
  }

  /** `DELETE /<p>/devices/:id` — release another device's seat. */
  async deauthorize(deviceId: string): Promise<void> {
    const token = this.requireToken();
    const what = "device deauthorize";
    const res = await this.ctx.request(
      this.ctx.url(`devices/${encodeURIComponent(deviceId)}`),
      {
        method: "DELETE",
        headers: this.ctx.headers({ authorization: `Bearer ${token}` }),
      },
      what,
    );
    if (!res.ok) throw await responseError(res, what);
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
