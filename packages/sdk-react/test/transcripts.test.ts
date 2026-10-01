// @pkey-feature core.discover config.schema release.changelog release.download
//
// The React transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, over the shared TypeScript replay engine
// in `conformance/runners/node/transcriptReplay.ts`.
//
// Which transcripts apply is DATA, read from `packages/sdk-react/parity.json` with the same rule
// every SDK uses: every feature the transcript proves is `implemented`, and nothing it
// presupposes is `na`. Every transcript that authenticates with a `pkeyt_` device token
// requires `core.store`, which React declares `na` on both its runtimes: the browser adapter is
// a cookie session (browserAdapter.ts), and the desktop renderer reaches the Worker through the
// host's Node SDK, which the Node replayer covers. What is left is what the browser transport
// performs itself, over the same standalone functions the browser adapter calls: discovery
// (`discoverProduct`), the catalog fetch (`fetchCatalog`) and the Release client
// (`fetchChangelog`, `buildInstallUrl`, `buildDownloadUrl`).
//
// `result` is `discoverProduct`'s outcome; React reports a 404 as `{kind:"error",status:404}`,
// which is the vocabulary's `not-found`. `services` is the map the browser adapter installs from
// it (BrowserAdapter.loadCapabilities): the document's map on success, otherwise the
// pre-discovery belief, which with no `expectServices` is `defaultServices()`.

import { describe, expect, it } from "vitest";
import { discoverProduct } from "../src/browser/discovery.js";
import { fetchCatalog } from "../src/browser/catalog.js";
import {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
} from "../src/browser/release.js";
import { PolarisError } from "../src/core/types.js";
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
  const base = {
    baseUrl: t.baseUrl,
    product: t.product,
    fetchImpl: server.fetch as typeof fetch,
  };
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    const observed: Record<string, JsonValue> = {};
    switch (step.action) {
      case "discover": {
        const r = await discoverProduct(base);
        if (r.kind === "ok") belief = copyServices(r.services);
        observed.result =
          r.kind === "error" && r.status === 404 ? "not-found" : r.kind;
        break;
      }
      case "fetchSchema":
        observed.catalog = (await fetchCatalog(base)) as JsonValue;
        break;
      case "changelog":
        try {
          observed.entries = (await fetchChangelog(base)) as never;
          observed.result = "ok";
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          // React's `code` is its UI vocabulary; the code the other SDKs report is `wireCode`.
          observed.result = "error";
          observed.code = e.wireCode ?? e.code;
        }
        break;
      case "installUrl":
        observed.url = buildInstallUrl(t.baseUrl, t.product);
        break;
      case "downloadUrl":
        observed.url = buildDownloadUrl(
          t.baseUrl,
          t.product,
          String(step.args.version),
          String(step.args.binary),
          String(step.args.arch),
          {
            checksum: step.args.checksum === true,
            dmg: step.args.dmg === true,
          },
        );
        break;
      default:
        throw new Error(
          `the React replayer has no mapping for "${step.action}"`,
        );
    }
    server.endStep();
    observed.services = Object.fromEntries(
      Object.entries(belief).map(([slug, s]) => [slug, s.enabled]),
    );
    for (const [key, want] of Object.entries(step.expect))
      expect(observed[key], `${t.id} step ${i}: ${key}`).toEqual(want);
  }
}

describe("HTTP transcripts: @polaris-key/react", () => {
  it("replays what the browser transport does itself, and nothing that needs a device token", () => {
    const ids = TRANSCRIPTS.filter((t) => applies(t, MANIFEST)).map(
      (t) => t.id,
    );
    expect(ids.sort()).toEqual([
      "config-schema-fetch",
      "discovery-capabilities",
      "discovery-failure",
      "release-changelog",
    ]);
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
