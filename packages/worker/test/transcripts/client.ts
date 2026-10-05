/// <reference types="@cloudflare/workers-types" />
// The client moves a scenario is made of — each one the request a wire-contract-v3 client sends
// for that move, with the assertion a replaying SDK is held to. Kept in one place so the eight
// scenarios cannot drift from one another on what "a document fetch" or "a report" looks like.

import { expect } from "vitest";
import { REPORT_KEYS } from "../../src/core/devices.js";
import type { RequestBody } from "./format.js";
import type { StepRecorder } from "./recorder.js";

/** A well-formed device id — 32 base64url chars, the shape §6 states and every SDK derives. */
export const DEVICE = "TRANSCRIPTDEVICE0000000000000001";

/** The host application version every transcript's client reports. */
export const VERSION = "1.0.0";

/** Recording epoch. A fixed instant, the same one the Worker suite seeds rows at. */
export const T0 = 1_700_000_000;

/** A hashed fingerprint as the recorder sends it: three components including the anchor, each
 *  in the 22-char per-component digest shape. Raw hardware values never exist here (rule 7). */
export const FINGERPRINT = {
  fingerprint: {
    components: {
      machineUuid: "TRANSCRIPTmachineUuid0",
      boardSerial: "TRANSCRIPTboardSerial0",
      cpuModel: "TRANSCRIPTcpuModel0000",
    },
    hwid: "TRANSCRIPThwid000000000000000000",
  },
};

/** What a replaying SDK's fingerprint body is held to: SOME hashed fingerprint. Which
 *  components a host can read is its own business, so only the shape is pinned. */
export const FINGERPRINT_EXPECT: RequestBody = {
  json: { fingerprint: { components: {}, hwid: "" } },
  match: "shape",
  allowedKeys: ["fingerprint"],
};

/** The platform device name the recorded client stands in for (`initial.deviceName`, PX-W13). */
export const TRANSCRIPT_DEVICE_NAME = "Transcript Device";

/** A fingerprint body that also carries the device label (`license/activate` and
 *  `devices/register`, PX-W13 §8 Q2). */
export const LABELLED_FINGERPRINT = {
  ...FINGERPRINT,
  deviceName: TRANSCRIPT_DEVICE_NAME,
};

/** What a replaying SDK's activation or registration body is held to: some hashed fingerprint
 *  and a device label. The label's value is pinned by `device-label.json` and the device-code
 *  transcripts; here only its presence and type are. */
export const LABELLED_FINGERPRINT_EXPECT: RequestBody = {
  json: { fingerprint: { components: {}, hwid: "" }, deviceName: "" },
  match: "shape",
  allowedKeys: ["fingerprint", "deviceName"],
};

/** The report allowlist, straight from the handler that enforces it. A replaying SDK that sends
 *  any other top-level key fails: the Worker would drop it silently, which is exactly the kind
 *  of drift a transcript exists to surface. */
export const REPORT_ALLOWED_KEYS: string[] = [...REPORT_KEYS];

/** The recorder's own facts snapshot (a fixed host), sent alongside the verified values. */
const RECORDER_FACTS = {
  os: { name: "linux", version: "6.8", build: "transcript", kernel: "6.8.0" },
  hardware: { cpuModel: "recorder", cpuCores: 4, ramMb: 8192 },
  runtime: { name: "recorder", version: "1" },
  locale: "en-US",
  timezone: "UTC",
};

/** `GET /<p>/.well-known/polaris-trust.jws` — Core's trust refresh. Public, so nothing but the
 *  path is held; clients differ on whether they send metadata here and the contract does not
 *  require it. */
export async function trust(s: StepRecorder, product: string): Promise<void> {
  const res = await s.send({
    method: "GET",
    path: `/${product}/.well-known/polaris-trust.jws`,
    metadata: false,
    headers: { accept: "application/jose" },
  });
  expect(res.status).toBe(200);
}

/** `GET /<p>/.well-known/polaris.json`. */
export async function discovery(
  s: StepRecorder,
  product: string,
  opts: { runtimeFailure?: boolean } = {},
): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${product}/.well-known/polaris.json`,
    metadata: false,
    ...(opts.runtimeFailure ? { runtimeFailure: true } : {}),
  });
}

/** `GET /<p>/<slice>/document`, conditional when an ETag is held. */
export async function document(
  s: StepRecorder,
  product: string,
  slice: "license" | "config",
  etag?: string,
): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${product}/${slice}/document`,
    bearer: "token",
    ...(etag !== undefined ? { ifNoneMatch: etag } : {}),
  });
}

/** `POST /<p>/devices/report` as part of a sync: the verified values plus host facts, held to
 *  the allowlist and to carrying both maps. */
export async function syncReport(
  s: StepRecorder,
  product: string,
  values: {
    config: Record<string, unknown>;
    entitlements: Record<string, unknown>;
  },
): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${product}/devices/report`,
    bearer: "token",
    body: { ...RECORDER_FACTS, ...values },
    expectBody: {
      json: { config: {}, entitlements: {} },
      match: "shape",
      allowedKeys: REPORT_ALLOWED_KEYS,
    },
  });
}

/** `POST /<p>/devices/report` as the explicit telemetry call: the values must be the ones the
 *  client's VERIFIED documents carry (R4-05), so they are held by subset. */
export async function explicitReport(
  s: StepRecorder,
  product: string,
  values: {
    config: Record<string, unknown>;
    entitlements: Record<string, unknown>;
  },
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${product}/devices/report`,
    bearer: "token",
    body: { ...RECORDER_FACTS, ...values, ...extra },
    expectBody: {
      json: values as never,
      match: "subset",
      allowedKeys: REPORT_ALLOWED_KEYS,
    },
  });
}

/** The ETag a 200 carried. */
export function etagOf(res: Response): string {
  const etag = res.headers.get("etag");
  expect(etag).toBeTruthy();
  return etag!;
}
