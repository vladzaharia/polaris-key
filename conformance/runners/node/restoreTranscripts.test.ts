// The silent-restore transcripts (I-49.8, WIRE-CONTRACT-V5 §12.11.8) replayed by a reference
// client: the conformance runner's own, built from node:crypto and `fetch`, with no code from the
// Worker or from `@polaris-key/node`.
//
// @pkey-feature identity.restore
//
// A Node process has no iCloud Keychain or Block Store to keep a restore secret in, so its parity
// row for `identity.restore` is N/A (runtime) and `transcripts.test.ts` skips these files by the
// `applies()` rule (the last test here pins that). This runner is the Node-side proof that the
// recordings are replayable by an independent implementation of the client half: it derives the
// fixture device keys (format.ts, "exchange"), signs the `restore` proof itself, sends the form
// the contract fixes and the enrol and revoke calls with the device token, against `ReplayServer`,
// which holds every request to the recording byte for byte. Swift, Kotlin and Godot replay the
// same files through their SDKs when they implement the rung (I-49.10, I-49.12, I-49.15).
//
// Every transcript that lists `identity.restore` runs here. The backup item is the step's args
// (`restoreId`, `restoreSecret`); conformance/transcripts is read through `loadTranscripts`.

import { describe, expect, it } from "vitest";
import {
  applies,
  doctor,
  loadManifest,
  loadTranscripts,
  ReplayServer,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";
import {
  deviceHeaders,
  deviceKeys,
  errorCode,
  json,
  observe,
  replay,
  type Observed,
} from "./exchangeReference.js";

const RESTORE_GRANT = "urn:polaris-key:grant-type:restore";

/** Whether the last `discover` step showed the `restore` member and endpoint (§12.11.6). */
const offered = new WeakMap<ReplayServer, boolean>();

/** What the client reports for a restore grant answer (the `expect` vocabulary of format.ts). */
function observeGrant(status: number, body: Record<string, unknown>): Observed {
  const seen = observe(status, body);
  if (seen.result !== "refused") return seen;
  return {
    ...seen,
    status,
    ...(typeof body.retryAfter === "number"
      ? { retryAfter: body.retryAfter }
      : {}),
  };
}

async function runStep(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  const device = deviceHeaders(t);
  const bearer = { authorization: `Bearer ${server.bindings.token}` };
  const base = `${t.baseUrl}/${t.product}`;

  if (step.action === "discover") {
    const res = await server.fetch(`${base}/.well-known/polaris.json`);
    const doc = (await res.json()) as {
      services: Record<
        string,
        {
          enabled?: boolean;
          restore?: unknown;
          endpoints?: Record<string, string>;
        }
      >;
    };
    const identity = doc.services.identity ?? {};
    const present =
      identity.restore === true &&
      typeof identity.endpoints?.restore === "string";
    offered.set(server, present);
    return {
      result: "ok",
      services: Object.fromEntries(
        Object.entries(doc.services).map(([k, v]) => [k, v.enabled === true]),
      ),
      restore: identity.restore === true,
      restoreEndpoint: typeof identity.endpoints?.restore === "string",
    };
  }

  if (step.action === "restoreRedeem") {
    // Discovery without the member: nothing is sent (§12.11.6).
    if (offered.get(server) === false)
      return { result: "unavailable", tokenHeld: false };
    const id = String(step.args.restoreId);
    const secret = String(step.args.restoreSecret);
    const product = String(step.args.product ?? t.product);
    const keys = deviceKeys(String(step.args.keyLabel));
    const form = new URLSearchParams({
      grant_type: RESTORE_GRANT,
      client_id: product,
      restore_id: id,
      restore_secret: secret,
      device_key: keys.signKey,
      agree_key: keys.agreeKey,
      proof: keys.proof({
        purpose: "restore",
        product,
        deviceId: t.initial.deviceId,
        value: String(step.args.proofValue ?? `${id}.${keys.signKey}`),
        token: secret,
      }),
    });
    const res = await server.fetch(`${t.baseUrl}/${product}/identity/token`, {
      method: "POST",
      headers: {
        ...device,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    return observeGrant(res.status, await json(res));
  }

  if (step.action === "choiceComplete") {
    // The SDK's input is the consent the host gave; the recording holds it.
    const sent = step.exchanges.items[0]!.request.body!.json as Record<
      string,
      unknown
    >;
    const res = await server.fetch(`${base}/identity/choice/complete`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({ ...sent, grant: step.args.grant }),
    });
    return observe(res.status, await json(res));
  }

  if (step.action === "restoreEnroll") {
    const held = step.args.restoreId;
    const res = await server.fetch(`${base}/identity/restore`, {
      method: "POST",
      headers: { ...device, ...bearer, "content-type": "application/json" },
      body: JSON.stringify(held === undefined ? {} : { restoreId: held }),
    });
    const body = await json(res);
    if (res.status === 201)
      return {
        result: "enrolled",
        restoreId: body.restoreId as string,
        secret: body.secret as string,
      };
    if (res.status === 200 && body.status === "current")
      return { result: "current" };
    if (res.status === 404) return { result: "unavailable" };
    return { result: "refused", status: res.status, code: errorCode(body) };
  }

  if (step.action === "restoreDelete") {
    const res = await server.fetch(`${base}/identity/restore`, {
      method: "DELETE",
      headers: { ...device, ...bearer },
    });
    return { result: res.status === 204 ? "ok" : "refused" };
  }

  expect(step.action).toBe("signOut");
  const res = await server.fetch(`${base}/identity/signout`, {
    method: "POST",
    headers: { ...device, ...bearer },
  });
  const body = await json(res);
  return { released: body.released as boolean, tokenHeld: !body.released };
}

const RESTORE = loadTranscripts().filter((t) =>
  t.features.includes("identity.restore"),
);

describe("identity.restore transcripts, reference client", () => {
  it("covers the restore scenarios", () => {
    expect(RESTORE.map((t) => t.id).sort()).toEqual([
      "discovery-identity-restore",
      "restore-confirm",
      "restore-errors",
      "restore-gate-off",
      "restore-happy",
      "restore-signout",
    ]);
  });

  for (const t of RESTORE)
    it(`${t.id}: the client half reproduces every request`, async () => {
      await replay(t, runStep);
    });

  const happy = RESTORE.find((t) => t.id === "restore-happy")!;

  it("fails when the proof is not the recorded one", async () => {
    const doctored = doctor(happy, 1, (items) => {
      const copy = structuredClone(items);
      const form = copy[0]!.request.body!.json as Record<string, string>;
      const proof = form.proof!;
      form.proof = proof.replace(/.$/, proof.endsWith("A") ? "B" : "A");
      return copy;
    });
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /does not match the recording/,
    );
  });

  it("fails when the secret is not the one the backup carried", async () => {
    const doctored = doctor(happy, 1, (items) => {
      const copy = structuredClone(items);
      const form = copy[0]!.request.body!.json as Record<string, string>;
      form.restore_secret = `rs_${"A".repeat(43)}`;
      return copy;
    });
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /does not match the recording/,
    );
  });

  it("fails when the enrolment is not sent", async () => {
    const doctored = doctor(happy, 2, () => []);
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /unexpected request/,
    );
  });

  it("is skipped by the Node SDK while its parity row is N/A", () => {
    const manifest = loadManifest("packages/sdk-node/parity.json");
    expect(manifest.features["identity.restore"]?.status).toBe("na");
    for (const t of RESTORE) expect(applies(t, manifest), t.id).toBe(false);
  });
});
