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

import { describe, expect, it } from "vitest";
import {
  doctor,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";
import {
  deviceHeaders,
  json,
  observe,
  offered,
  replay,
  runExchange,
  type Observed,
} from "./exchangeReference.js";

async function runStep(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  const base = `${t.baseUrl}/${t.product}`;
  const device = deviceHeaders(t);
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
    offered.set(
      server,
      identity.exchange !== undefined &&
        typeof identity.endpoints?.nonce === "string",
    );
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
  return runExchange(server, t, step);
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
      "exchange-gate-off-stale",
      "exchange-no-link",
      "exchange-silent",
    ]);
  });

  for (const t of EXCHANGE)
    it(`${t.id}: the client half reproduces every request`, async () => {
      await replay(t, runStep);
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
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /does not match the recording/,
    );
  });

  it("fails when the grant is sent without the nonce request", async () => {
    const doctored = doctor(silent, 0, (items) => items.slice(1));
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /unexpected request/,
    );
  });
});
