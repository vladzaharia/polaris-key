// Fixtures for the nearby (mode v) tests (CC-15.N2 to N4): a bare device D that speaks mode v with
// the client-core engine over a real socket to an approver's advert on the fake LAN, and a fake of
// the Worker's `nearby/approve` that holds the key-binding rule of WIRE-CONTRACT-V5 §12.11.5 rule 3.
import {
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import {
  RECORD,
  buildVouchRequest,
  type PeerChannel,
  type PeerHello,
  type SessionEvent,
  type VouchRequest,
} from "@polaris-key/client-core/peer";
import { dialRaceTo } from "../../src/connect/dial.js";
import { SocketLink, type SessionClosed } from "../../src/connect/session.js";
import type { MemoryMdnsNetwork } from "../lanFixtures.js";
import { until } from "../lanFixtures.js";

export const SLUG = "djdl";
export const D_ID = "NEARBYDEVICE".padEnd(31, "0") + "D";
export const REQUEST = "nr_0IvbE7YHMGPBP0VAfZDQhg";

export const memoryKeys = (): DeviceKeyPort =>
  createWebDeviceKeyStore({ storage: memoryDeviceKeyStorage() });

/** The adverts of mode v on the fake LAN: instance, port and TXT. */
export const approverAdverts = (net: MemoryMdnsNetwork) =>
  [...net.adverts.values()].filter((a) => a.txt.includes("m=v"));

export interface RawDOptions {
  keys?: DeviceKeyPort;
  deviceId?: string;
  request?: string;
  label?: string;
  /** Hold the SAS (default true, as the requester does); false commits at HELLO. */
  hold?: boolean;
  /** Which advert to dial (default: the only one). */
  port?: number;
  /** Show the code and send `VOUCH_REQ` as soon as the code is known. */
  auto?: boolean;
}

/** A device D at the record level: the engine, a socket and what came back. */
export class RawD {
  events: SessionEvent[] = [];
  records: { type: number; body: Uint8Array }[] = [];
  closed: SessionClosed | null = null;
  code: number | null = null;
  hello: PeerHello | null = null;
  keys: DeviceKeyPort;
  readonly helloOut: { label?: string; platform: string };

  private constructor(
    readonly link: SocketLink,
    private readonly o: Required<Pick<RawDOptions, "request" | "deviceId">> &
      RawDOptions,
    keys: DeviceKeyPort,
  ) {
    this.keys = keys;
    this.helloOut = {
      ...(o.label !== undefined ? { label: o.label } : {}),
      platform: process.platform,
    };
  }

  get channel(): PeerChannel {
    return this.link.channel;
  }

  static async dial(
    net: MemoryMdnsNetwork,
    o: RawDOptions = {},
  ): Promise<RawD> {
    const adverts = approverAdverts(net);
    const port = o.port ?? adverts[0]!.port;
    const keys = o.keys ?? memoryKeys();
    await keys.ensure();
    const { socket } = await dialRaceTo(["127.0.0.1"], port, {
      allowLoopback: true,
    });
    const self: { d: RawD | null } = { d: null };
    const link: SocketLink = new SocketLink({
      socket,
      channel: {
        mode: "v",
        role: "initiator",
        slug: SLUG,
        staticKey: crypto.getRandomValues(new Uint8Array(32)),
        holdSas: o.hold !== false,
        hello: {
          ...(o.label !== undefined ? { label: o.label } : {}),
          platform: process.platform,
          app: SLUG,
        },
      },
      onEvent: (e) => void self.d?.onEvent(e),
      onClosed: (c) => {
        if (self.d !== null) self.d.closed = c;
      },
    });
    const d = new RawD(
      link,
      { ...o, request: o.request ?? REQUEST, deviceId: o.deviceId ?? D_ID },
      keys,
    );
    self.d = d;
    await link.channel.start();
    return d;
  }

  private async onEvent(e: SessionEvent): Promise<void> {
    this.events.push(e);
    if (e.type === "established") this.hello = e.hello;
    if (e.type === "sas") {
      this.code = e.code;
      if (this.o.auto === true) await this.showAndRequest();
    }
    if (e.type === "record")
      this.records.push({ type: e.recordType, body: e.body });
  }

  /** The person chose this approver. */
  startSas(): Promise<void> {
    return this.channel.startSas();
  }

  /** D shows the code (its confirmation) and sends `VOUCH_REQ`. */
  async showAndRequest(over?: (body: Uint8Array) => Uint8Array): Promise<void> {
    const flow = this.channel.vouch!;
    flow.codeShown();
    await this.channel.confirmSas();
    let body = await buildVouchRequest({
      port: this.keys,
      slug: SLUG,
      h: this.channel.handshakeHash(),
      request: this.o.request,
      deviceId: this.o.deviceId,
      hello: this.helloOut,
    });
    if (over !== undefined) body = over(body);
    const v = flow.send({ type: RECORD.VOUCH_REQ, body });
    if (v.ok) await this.channel.sendRecord(RECORD.VOUCH_REQ, body);
  }

  async waitFor(f: () => boolean): Promise<void> {
    await until(f, 3000);
  }

  result(): string | null {
    const r = this.records.find((x) => x.type === RECORD.VOUCH_RESULT);
    return r === undefined
      ? null
      : (JSON.parse(new TextDecoder().decode(r.body)) as { status: string })
          .status;
  }

  close(): Promise<void> {
    return this.channel.close("peer_bye");
  }
}

/** What `nearby/start` registered for D, and the approve rules the Worker applies. */
export class FakeNearbyWorker {
  start = new Map<
    string,
    { deviceId: string; signKey: string; agreeKey: string }
  >();
  calls: { request: string; deviceId: string }[] = [];
  /** Does M have keys registered? A first approve without them answers `device_keys_required`. */
  mHasKeys = false;
  decided = new Set<string>();
  approved: string[] = [];

  async register(
    request: string,
    keys: DeviceKeyPort,
    deviceId: string,
  ): Promise<void> {
    const k = await keys.ensure();
    this.start.set(request, {
      deviceId,
      signKey: k.signKey,
      agreeKey: k.agreeKey,
    });
  }

  /** `POST nearby/approve` as M sends it: exactly what `pick()` returned. */
  approve(
    r: Pick<VouchRequest, "request" | "deviceId" | "signKey" | "agreeKey">,
  ): { http: number; body: string | null } {
    this.calls.push({ request: r.request, deviceId: r.deviceId });
    if (!this.mHasKeys)
      return {
        http: 409,
        body: JSON.stringify({ code: "device_keys_required" }),
      };
    const s = this.start.get(r.request);
    if (
      s === undefined ||
      this.decided.has(r.request) ||
      s.deviceId !== r.deviceId ||
      s.signKey !== r.signKey ||
      s.agreeKey !== r.agreeKey
    )
      return { http: 404, body: null };
    this.decided.add(r.request);
    this.approved.push(r.deviceId);
    return { http: 200, body: JSON.stringify({ status: "approved" }) };
  }
}
