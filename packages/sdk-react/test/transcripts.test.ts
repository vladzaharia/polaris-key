// @pkey-feature core.discover
//
// The React transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, over the shared TypeScript replay engine
// in `conformance/runners/node/transcriptReplay.ts`.
//
// Which transcripts apply is DATA, read from `packages/sdk-react/parity.json` with the same rule
// every SDK uses: every feature the transcript proves is `implemented`, and nothing it
// presupposes is `na`. Every transcript but discovery-* authenticates with a `pkeyt_` device
// token and so requires `core.store`, which React declares `na` on both its runtimes: the
// browser adapter is a cookie session (browserAdapter.ts), and the desktop renderer reaches the
// Worker through the host's Node SDK, which the Node replayer covers. What is left is
// discovery, which React performs itself (`discoverProduct`).
//
// `result` is `discoverProduct`'s outcome; React reports a 404 as `{kind:"error",status:404}`,
// which is the vocabulary's `not-found`. `services` is the map the browser adapter installs from
// it (BrowserAdapter.loadCapabilities): the document's map on success, otherwise the
// pre-discovery belief, which with no `expectServices` is `defaultServices()`.

import { describe, expect, it } from "vitest";
import { discoverProduct } from "../src/browser/discovery.js";
import {
  copyServices,
  defaultServices,
  servicesFromList,
  type ServicesMap,
} from "../src/core/services.js";
import {
  applies,
  doctor,
  loadManifest,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Transcript,
} from "../../../conformance/runners/node/transcriptReplay.js";

const MANIFEST = loadManifest("packages/sdk-react/parity.json");
const TRANSCRIPTS = loadTranscripts();

async function replay(t: Transcript): Promise<void> {
  const server = new ReplayServer(t);
  let belief: ServicesMap = t.initial.services
    ? servicesFromList(t.initial.services as never)
    : defaultServices();
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    if (step.action !== "discover")
      throw new Error(`the React replayer has no mapping for "${step.action}"`);
    const r = await discoverProduct({
      baseUrl: t.baseUrl,
      product: t.product,
      fetchImpl: server.fetch as typeof fetch,
    });
    if (r.kind === "ok") belief = copyServices(r.services);
    server.endStep();
    const observed: Record<string, JsonValue> = {
      result: r.kind === "error" && r.status === 404 ? "not-found" : r.kind,
      services: Object.fromEntries(
        Object.entries(belief).map(([slug, s]) => [slug, s.enabled]),
      ),
    };
    for (const [key, want] of Object.entries(step.expect))
      expect(observed[key], `${t.id} step ${i}: ${key}`).toEqual(want);
  }
}

describe("HTTP transcripts: @polaris-key/react", () => {
  it("replays discovery-* and nothing that needs a device token", () => {
    const ids = TRANSCRIPTS.filter((t) => applies(t, MANIFEST)).map(
      (t) => t.id,
    );
    expect(ids).toEqual(["discovery-capabilities", "discovery-failure"]);
  });

  for (const t of TRANSCRIPTS) {
    const run = applies(t, MANIFEST) ? it : it.skip;
    run(`${t.id} (${t.features.join(", ")})`, async () => {
      await replay(t);
    });
  }
});

describe("the React replayer fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "discovery-capabilities")!;

  it("an extra request (the recording has no discovery exchange)", async () => {
    const t = doctor(base, 0, () => []);
    await expect(replay(t)).rejects.toThrow(
      /unexpected request: GET \/djdl\/\.well-known\/polaris\.json/,
    );
  });

  it("an omitted request (the recording expects a second discovery fetch)", async () => {
    const t = doctor(base, 0, (items) => [...items, items[0]!]);
    await expect(replay(t)).rejects.toThrow(
      /expected request not sent: GET \/djdl\/\.well-known\/polaris\.json/,
    );
  });

  it("a dropped required header", async () => {
    const t = doctor(base, 0, (items) =>
      items.map((x) => ({
        ...x,
        request: { ...x.request, requiredHeaders: ["x-pkey-doctored"] },
      })),
    );
    await expect(replay(t)).rejects.toThrow(
      /required header x-pkey-doctored: missing/,
    );
  });
});
