// The link-offer transcripts (I-43.3, WIRE-CONTRACT-V5 §12.11.4) replayed by a reference client:
// the conformance runner's own, built from node:crypto and `fetch`, with no code from the Worker
// or from `@polaris-key/node`.
//
// @pkey-feature identity.link
//
// Node has no platform identity to link, so its parity row for `identity.link` is N/A (runtime)
// and `transcripts.test.ts` skips these files by the `applies()` rule. This runner is the
// Node-side proof that the recordings are replayable by an independent implementation of the
// client half: it signs the `link` proof itself, redeems the sign-in code, sends the offer and the
// link with the device token as the bearer, against `ReplayServer`, which holds every request to
// the recording. The browser's half of the redirect sign-in is played as recorded. Swift, Kotlin
// and React replay the same files through their SDKs when they implement the link offer
// (I-44 to I-46).

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
  deviceKeys,
  json,
  deviceHeaders,
  errorCode,
  replay,
  runExchange,
  type Observed,
} from "./exchangeReference.js";

/** What the client reports for a link answer (the `expect` vocabulary of format.ts). */
function observeLink(status: number, body: Record<string, unknown>): Observed {
  if (status === 200 && body.linked !== undefined)
    return { result: "ok", linked: body.linked as JsonValue };
  return { result: "refused", status, code: errorCode(body) };
}

async function runStep(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  const base = `${t.baseUrl}/${t.product}`;
  const device = deviceHeaders(t);
  const bearer = (): Record<string, string> => ({
    authorization: `Bearer ${server.bindings.token}`,
  });
  switch (step.action) {
    case "exchange":
      return runExchange(server, t, step);
    case "browser": {
      // The person's browser, not the SDK: the recorded requests are played as they were sent.
      let last = 0;
      for (const item of step.exchanges.items) {
        const body = item.request.body?.json;
        const res = await server.fetch(`${t.baseUrl}${item.request.path}`, {
          method: item.request.method,
          ...(body !== undefined
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
          redirect: "manual",
        });
        last = res.status;
      }
      return { navigated: last === 303 ? "card" : "app" };
    }
    case "redirectComplete": {
      const recorded = step.exchanges.items[0]!.request;
      const form = {
        ...(recorded.body!.json as Record<string, string>),
        code: new URL(String(step.args.callbackUrl)).searchParams.get("code")!,
      };
      const res = await server.fetch(`${base}/identity/token`, {
        method: "POST",
        headers: {
          ...device,
          ...(recorded.headers.authorization ? bearer() : {}),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
      });
      const body = await json(res);
      return {
        result: typeof body.access_token === "string" ? "ok" : "refused",
        scope: (body.scope as string) ?? null,
        tokenHeld: typeof body.access_token === "string",
      };
    }
    case "linkOffer": {
      const res = await server.fetch(`${base}/identity/link`, {
        headers: { ...device, ...bearer() },
      });
      const body = await json(res);
      return { result: "ok", offer: (body.offer ?? null) as JsonValue };
    }
    case "link": {
      const keys = deviceKeys(String(step.args.keyLabel));
      const handle = String(step.args.linkHandle);
      const res = await server.fetch(`${base}/identity/link`, {
        method: "POST",
        headers: {
          ...device,
          ...bearer(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          linkHandle: handle,
          proof: keys.proof({
            purpose: "link",
            product: t.product,
            deviceId: t.initial.deviceId,
            value: String(step.args.proofValue ?? handle),
            token: null,
          }),
        }),
      });
      return observeLink(res.status, await json(res));
    }
    default:
      throw new Error(`${t.id}: unexpected action ${step.action}`);
  }
}

const LINK = loadTranscripts().filter((t) =>
  t.features.includes("identity.link"),
);

describe("identity.link transcripts, reference client", () => {
  it("covers the link scenarios", () => {
    expect(LINK.map((t) => t.id).sort()).toEqual(["link-errors", "link-offer"]);
  });

  for (const t of LINK)
    it(`${t.id}: the client half reproduces every request`, async () => {
      await replay(t, runStep);
    });

  const offer = LINK.find((t) => t.id === "link-offer")!;
  const linkIndex = offer.steps.findIndex((s) => s.action === "link");

  it("fails when the link proof is not the recorded one", async () => {
    const doctored = doctor(offer, linkIndex, (items) => {
      const copy = structuredClone(items);
      const body = copy[0]!.request.body!.json as Record<string, string>;
      const proof = body.proof!;
      body.proof = proof.replace(/.$/, proof.endsWith("A") ? "B" : "A");
      return copy;
    });
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /does not match the recording/,
    );
  });

  it("fails when the offer is asked for without the device token", async () => {
    const at = offer.steps.findIndex((s) => s.action === "linkOffer");
    const doctored = doctor(offer, at, (items) => items.slice(0, 0));
    await expect(replay(doctored, runStep)).rejects.toThrow(
      /unexpected request/,
    );
  });
});
