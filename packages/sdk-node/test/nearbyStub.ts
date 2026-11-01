// A reduced stand-in for the Worker's nearby sign-in routes (V5 §12.11.5, §15.6.1), shared by the
// in-process nearby test and the Electron e2e (which serves it over loopback HTTP).
import { randomBytes } from "node:crypto";
import { verifyDeviceProof } from "@polaris-key/client-core";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { BASE, MultiWorker, PRODUCT } from "./lanFixtures.js";

export const IDENT = `${BASE}/${PRODUCT}/identity`;
export const SUBJECT = "ps_Wnnfb0uwgWH1iDEe7g0Fbg";

export interface Start {
  deviceId: string;
  signKey: string;
  agreeKey: string;
  label: string | null;
  state: "open" | "approved" | "denied" | "collected";
  license: string | null;
  token: string | null;
}

/** The Worker's connect routes plus the nearby routes and Identity's discovery fragment. */
export class NearbyStub extends MultiWorker {
  nearby = true;
  /** Licences with a free seat: more than one asks M to choose. */
  licenses = ["lic_a"];
  /** The next approve is from another network. */
  notNearby = false;
  starts = new Map<string, Start>();
  approves: Record<string, unknown>[] = [];
  keysPuts = 0;
  signouts = 0;
  /** The key ring routes (§13.11.2), reduced: one ring, a wrap per device. */
  ringRow: { ringId: string; rootKid: string } | null = null;
  wraps = new Map<string, Record<string, unknown>>();
  wrapPuts: string[] = [];

  constructor() {
    super();
    const base = this.fetch;
    this.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.slice(PRODUCT.length + 2);
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, string>)
          : {};
      const j = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), { status: s });
      if (path === ".well-known/polaris.json")
        return j({
          product: PRODUCT,
          services: {
            identity: {
              enabled: true,
              configured: true,
              ...(this.nearby ? { nearby: true } : {}),
              endpoints: {
                nearbyStart: `${IDENT}/nearby/start`,
                nearbyApprove: `${IDENT}/nearby/approve`,
                nearbyPoll: `${IDENT}/nearby/poll`,
                signout: `${IDENT}/signout`,
              },
            },
            connect: { enabled: false },
          },
        });
      if (path === "identity/signout") {
        this.signouts++;
        return j({ released: false });
      }
      if (path === "devices/keys" && init?.method === "PUT") this.keysPuts++;
      const deviceId = headers.get("x-pkey-device") ?? "";
      if (path.startsWith("devices/keyring"))
        return this.#keyring(path, init?.method ?? "GET", headers, body, j);
      if (path === "identity/nearby/start")
        return this.#start(deviceId, body, j);
      if (path === "identity/nearby/poll") return this.#poll(deviceId, body, j);
      if (path === "identity/nearby/approve")
        return this.#approve(headers, body, j);
      return base(input, init);
    }) as typeof fetch;
  }

  #keyring(
    path: string,
    method: string,
    h: Headers,
    b: Record<string, unknown>,
    j: (b: unknown, s?: number) => Response,
  ): Response {
    const me = this.tokens.get(
      (h.get("authorization") ?? "").replace("Bearer ", ""),
    );
    if (me === undefined) return j({ error: { code: "unauthorized" } }, 401);
    if (method === "GET" && path === "devices/keyring")
      return j({
        ring: this.ringRow && {
          ...this.ringRow,
          epoch: 1,
          state: "active",
          createdAt: 1,
          recovery: { set: false },
          adopted: [],
        },
        wrap: this.wraps.get(me) ?? null,
      });
    if (method === "POST" && path === "devices/keyring") {
      if (this.ringRow) return j({ error: { code: "keyring_conflict" } }, 409);
      this.ringRow = { ringId: String(b.ringId), rootKid: String(b.rootKid) };
      this.wraps.set(me, {
        epoch: 1,
        kid: b.rootKid,
        by: me,
        ...(b.wrap as object),
      });
      return j({ ringId: b.ringId, epoch: 1 }, 201);
    }
    const w = /^devices\/keyring\/wraps\/(.+)$/.exec(path);
    if (w && method === "PUT") {
      const target = decodeURIComponent(w[1]!);
      if (!this.wraps.has(me)) return j({ error: { code: "forbidden" } }, 403);
      if (this.wraps.has(target))
        return j({ error: { code: "keyring_conflict" } }, 409);
      this.wraps.set(target, { ...b, by: me });
      this.wrapPuts.push(target);
      return new Response(null, { status: 204 });
    }
    return j({}, 404);
  }

  async #proof(
    purpose: string,
    deviceId: string,
    value: string,
    signKey: string,
    sig: string,
  ): Promise<boolean> {
    return verifyDeviceProof({
      purpose: purpose as never,
      product: PRODUCT,
      deviceId,
      value,
      tokenHash: "-",
      signKey,
      sig,
    });
  }

  async #start(
    deviceId: string,
    b: Record<string, string>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    if (
      !(await this.#proof(
        "nearby-start",
        deviceId,
        `${b.signKey}.${b.agreeKey}`,
        b.signKey!,
        b.proof!,
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    const request = `nr_${base64UrlEncodeBytes(randomBytes(16)).slice(0, 22)}`;
    this.starts.set(request, {
      deviceId,
      signKey: b.signKey!,
      agreeKey: b.agreeKey!,
      label: b.deviceName ?? null,
      state: "open",
      license: null,
      token: null,
    });
    return j({ request, expiresIn: 300, interval: 3 }, 201);
  }

  async #poll(
    deviceId: string,
    b: Record<string, string>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    const s = this.starts.get(b.request!);
    if (s === undefined || s.deviceId !== deviceId)
      return j({ status: "timeout" });
    if (
      !(await this.#proof(
        "nearby-poll",
        deviceId,
        b.request!,
        s.signKey,
        b.proof!,
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    if (s.state === "denied")
      return j({ status: "error", reason: "access_denied" });
    if (s.state === "open") return j({ status: "pending" });
    if (s.state === "collected") return j({ status: "timeout" });
    s.state = "collected";
    this.members.set(deviceId, { signKey: s.signKey, agreeKey: s.agreeKey });
    this.tokens.set(s.token!, deviceId);
    return j({
      access_token: s.token,
      token_type: "Bearer",
      scope: "email",
      schemaVersion: 1,
      device: { id: deviceId },
      license: { id: s.license, name: "Ana", email: "ana@example.com" },
      subject: SUBJECT,
    });
  }

  async #approve(
    h: Headers,
    b: Record<string, unknown>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    const m = this.tokens.get(
      (h.get("authorization") ?? "").replace("Bearer ", ""),
    );
    if (m === undefined) return j({ error: { code: "account_required" } }, 403);
    const keys = this.members.get(m);
    if (keys === undefined)
      return j({ error: { code: "device_keys_required" } }, 409);
    if (
      !(await this.#proof(
        "nearby-approve",
        m,
        String(b.request),
        keys.signKey,
        String(b.proof),
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    const { proof: _p, ...logged } = b;
    this.approves.push(logged);
    const s = this.starts.get(String(b.request));
    if (
      s === undefined ||
      s.state !== "open" ||
      s.deviceId !== b.deviceId ||
      s.signKey !== b.signKey ||
      s.agreeKey !== b.agreeKey
    )
      return j({ error: { code: "not_found" } }, 404);
    if (this.notNearby) return j({ error: { code: "not_nearby" } }, 403);
    if (b.decision === "deny") {
      s.state = "denied";
      return new Response(null, { status: 204 });
    }
    const choice = b.choice as { kind: string; licenseId?: string } | undefined;
    if (choice === undefined && this.licenses.length > 1)
      return j({
        status: "choose",
        choices: {
          state: "choose",
          choices: this.licenses.map((id) => ({ id })),
        },
      });
    s.license = choice?.licenseId ?? this.licenses[0]!;
    s.token = `pkeyt_${base64UrlEncodeBytes(randomBytes(32))}`;
    s.state = "approved";
    return j({ status: "approved", deviceLabel: s.label });
  }
}
