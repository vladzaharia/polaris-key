// The native-token exchange transcripts (I-13.7, WIRE-CONTRACT-V5 §12.11.2, §12.11.3) replayed
// by a reference client: the conformance runner's own, built from node:crypto and `fetch`, with
// no code from the Worker or from `@polaris-key/node`.
//
// @pkey-feature identity.exchange
//
// Node has no platform identity to exchange, so its parity row for `identity.exchange` is N/A
// (runtime) and `transcripts.test.ts` skips these files by the `applies()` rule. This runner is
// the Node-side proof that the recordings are replayable by an independent implementation of
// the client half: it derives the fixture device keys (format.ts, "exchange"), builds the
// `pkey-proof/1` proof itself and sends the form the contract fixes, against `ReplayServer`,
// which holds every request to the recording byte for byte. Swift, Kotlin, React and Godot
// replay the same files through their SDKs when they implement the rung (I-44 to I-48).
//
// Every transcript that lists `identity.exchange` runs here. conformance/transcripts is read
// through `loadTranscripts`.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  doctor,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";

const SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

interface DeviceKeys {
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
function deviceKeys(label: string): DeviceKeys {
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

const METADATA = {
  "x-pkey-channel": "stable",
  "x-pkey-sdk": "conformance-exchange-reference",
  "x-pkey-sdk-version": "1",
  "x-pkey-platform": "linux",
  "x-pkey-arch": "x86_64",
};

type Observed = Record<string, JsonValue>;

const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

/** What the client reports for a Worker answer (the `expect` vocabulary of format.ts). */
function observe(status: number, body: Record<string, unknown>): Observed {
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
  const err = body.error;
  const code =
    typeof err === "string"
      ? err
      : ((err as { code?: string } | undefined)?.code ?? "");
  return { result: "refused", code, tokenHeld: false };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  return text.startsWith("{") ? (JSON.parse(text) as never) : {};
}

async function runStep(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  const base = `${t.baseUrl}/${t.product}`;
  const device = {
    "x-pkey-device": t.initial.deviceId,
    "x-pkey-version": t.initial.version,
    ...METADATA,
  };
  if (step.action === "discover") {
    const res = await server.fetch(`${base}/.well-known/polaris.json`);
    const doc = (await res.json()) as {
      services: Record<
        string,
        {
          enabled?: boolean;
          exchange?: JsonValue;
          endpoints?: Record<string, string>;
        }
      >;
    };
    const identity = doc.services.identity ?? {};
    return {
      result: "ok",
      services: Object.fromEntries(
        Object.entries(doc.services).map(([k, v]) => [k, v.enabled === true]),
      ),
      exchange: identity.exchange ?? null,
      nonceEndpoint: typeof identity.endpoints?.nonce === "string",
    } as Observed;
  }
  if (step.action === "choiceComplete") {
    // The SDK's input is the consent and the choice the host gave; the recording holds them.
    const sent = step.exchanges.items[0]!.request.body!.json as Record<
      string,
      JsonValue
    >;
    const res = await server.fetch(`${base}/identity/choice/complete`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({ ...sent, grant: step.args.grant }),
    });
    return observe(res.status, await json(res));
  }
  expect(step.action).toBe("exchange");
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

/** Replay every step, then hold what the client reports to the recorded `expect`. */
async function replay(t: Transcript): Promise<void> {
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

const EXCHANGE = loadTranscripts().filter((t) =>
  t.features.includes("identity.exchange"),
);

describe("identity.exchange transcripts, reference client", () => {
  it("covers the exchange scenarios", () => {
    expect(EXCHANGE.map((t) => t.id).sort()).toEqual([
      "discovery-identity-exchange",
      "exchange-choose",
      "exchange-confirm",
      "exchange-disabled",
      "exchange-errors",
      "exchange-gate-off",
      "exchange-no-link",
      "exchange-silent",
    ]);
  });

  for (const t of EXCHANGE)
    it(`${t.id}: the client half reproduces every request`, async () => {
      await replay(t);
    });

  const silent = EXCHANGE.find((t) => t.id === "exchange-silent")!;

  it("fails when the proof is not the recorded one", async () => {
    const doctored = doctor(silent, 0, (items) => {
      const copy = structuredClone(items);
      const form = copy[1]!.request.body!.json as Record<string, string>;
      const proof = form.proof!;
      form.proof = proof.replace(/.$/, proof.endsWith("A") ? "B" : "A");
      return copy;
    });
    await expect(replay(doctored)).rejects.toThrow(
      /does not match the recording/,
    );
  });

  it("fails when the grant is sent without the nonce request", async () => {
    const doctored = doctor(silent, 0, (items) => items.slice(1));
    await expect(replay(doctored)).rejects.toThrow(/unexpected request/);
  });
});
