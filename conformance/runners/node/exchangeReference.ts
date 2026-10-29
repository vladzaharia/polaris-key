// The reference client's half of the native-token exchange, shared by the exchange and link
// transcript runners (I-13.7, I-43.3): built from node:crypto and `fetch`, with no code from the
// Worker or from `@polaris-key/node`. The fixture device keys follow format.ts, "exchange".

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { expect } from "vitest";
import {
  ReplayServer,
  type JsonValue,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";

export const SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export const b64u = (b: Uint8Array): string =>
  Buffer.from(b).toString("base64url");

export interface DeviceKeys {
  signKey: string;
  agreeKey: string;
  proof(o: {
    purpose: string;
    product: string;
    deviceId: string;
    value: string;
    token: string | null;
  }): string;
}

/** The fixture keys of `label` (format.ts, "exchange"). */
export function deviceKeys(label: string): DeviceKeys {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({
    key: Buffer.concat([SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const raw = Buffer.from(
    (createPublicKey(priv).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  );
  const agree = createHash("sha256").update(`${label}:agree`).digest();
  agree[31]! &= 0x7f;
  return {
    signKey: b64u(raw),
    agreeKey: b64u(agree),
    proof(o) {
      const lines = [
        "pkey-proof/1",
        o.purpose,
        o.product,
        o.deviceId,
        o.value,
        o.token === null
          ? "-"
          : b64u(createHash("sha256").update(o.token).digest()),
      ];
      return b64u(sign(null, Buffer.from(lines.join("\n"), "utf8"), priv));
    },
  };
}

export const METADATA = {
  "x-pkey-channel": "stable",
  "x-pkey-sdk": "conformance-exchange-reference",
  "x-pkey-sdk-version": "1",
  "x-pkey-platform": "linux",
  "x-pkey-arch": "x86_64",
};

export type Observed = Record<string, JsonValue>;

/** Whether the last `discover` step of a replay showed an `exchange` member and the nonce
 *  endpoint (§12.11.6). A client sends nothing to the exchange routes when it did not. */
export const offered = new WeakMap<ReplayServer, boolean>();

const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

/** What the client reports for a Worker answer (the `expect` vocabulary of format.ts). */
export function observe(
  status: number,
  body: Record<string, unknown>,
): Observed {
  if (typeof body.access_token === "string") {
    const license = body.license as { id?: string } | null | undefined;
    return {
      result: "ok",
      tokenHeld: true,
      scope: (body.scope as string) ?? null,
      ...(body.issued_token_type !== undefined
        ? { issuedTokenType: body.issued_token_type as string }
        : {}),
      licenseId: license?.id ?? null,
    };
  }
  // The rung is not there: a 404 from the nonce or token route (the gate rolled back).
  if (status === 404) return { result: "unavailable", tokenHeld: false };
  if (status === 200 && body.status === "confirm") {
    const consent = body.consent as {
      firstTime: boolean;
      changed: boolean;
      as: JsonValue;
    };
    return {
      result: "confirm",
      firstTime: consent.firstTime,
      changed: consent.changed,
      as: consent.as,
    };
  }
  if (status === 200 && body.status === "choose") return { result: "choose" };
  if (status === 403 && body.error === "interstitial_required")
    return {
      result: "interstitial-required",
      reason: body.reason as string,
      url: body.url as string,
      linkHandle: body.linkHandle as string,
      expiresIn: body.expiresIn as number,
      tokenHeld: false,
    };
  return { result: "refused", code: errorCode(body), tokenHeld: false };
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  return text.startsWith("{") ? (JSON.parse(text) as never) : {};
}

/** One `exchange` step: the nonce request, then the grant, as the SDK sends them. */
export async function runExchange(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  // Discovery without the member: nothing is sent (§12.11.6).
  if (offered.get(server) === false)
    return { result: "unavailable", tokenHeld: false };
  const base = `${t.baseUrl}/${t.product}`;
  const device = deviceHeaders(t);
  const keys = deviceKeys(step.args.keyLabel as string);
  let nonce = step.args.nonce as string | undefined;
  if (nonce === undefined) {
    const res = await server.fetch(`${base}/identity/nonce`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({ signKey: keys.signKey, agreeKey: keys.agreeKey }),
    });
    const body = await json(res);
    if (res.status !== 200) return observe(res.status, body);
    nonce = body.nonce as string;
  }
  // The platform's provider returns its token for the nonce the Worker issued.
  const token = step.args.subjectToken as string;
  const form = new URLSearchParams({
    grant_type: EXCHANGE_GRANT,
    client_id: t.product,
    subject_token: token,
    subject_token_type: ID_TOKEN_TYPE,
    nonce,
    device_key: keys.signKey,
    proof: keys.proof({
      purpose: "exchange",
      product: t.product,
      deviceId: t.initial.deviceId,
      value: `${nonce}.${keys.signKey}`,
      token,
    }),
  });
  const res = await server.fetch(`${base}/identity/token`, {
    method: "POST",
    headers: { ...device, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return observe(res.status, await json(res));
}

/** The request headers of the device in `t`. */
export function deviceHeaders(t: Transcript): Record<string, string> {
  return {
    "x-pkey-device": t.initial.deviceId,
    "x-pkey-version": t.initial.version,
    ...METADATA,
  };
}

/** The code of a refusal body: `{"error":"x"}` or `{"error":{"code":"x"}}`. */
export function errorCode(body: Record<string, unknown>): string {
  const err = body.error;
  return typeof err === "string"
    ? err
    : ((err as { code?: string } | undefined)?.code ?? "");
}

/** Replay every step through `runStep`, then hold what the client reports to the recorded
 *  `expect`. */
export async function replay(
  t: Transcript,
  runStep: (
    server: ReplayServer,
    t: Transcript,
    step: Step,
  ) => Promise<Observed>,
): Promise<void> {
  const server = new ReplayServer(t);
  const reported: Observed[] = [];
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    reported.push(await runStep(server, t, step));
    server.endStep();
  }
  t.steps.forEach((step, i) => {
    for (const [key, want] of Object.entries(step.expect))
      expect(reported[i]![key], `${t.id} step ${i}: ${key}`).toEqual(want);
  });
}

/** One JSON POST the way the reference client sends it: the device's headers, a JSON body. */
export async function postJson(
  server: ReplayServer,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await server.fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
}
