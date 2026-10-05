// @pkey-feature core.headers
// React's header values (WIRE-CONTRACT-V3 §5.2). The browser adapter sends `X-PKey-Platform:
// web`, no `X-PKey-Arch` and `X-PKey-SDK: react`; this pins the captured `/identity/session`
// request against the `conformance/corpus/v2/headers.json` rows whose `expect` is `web`. The
// spelling lookups themselves are client-core's, run over every row by the Node runner
// (conformance/runners/node/headers.test.ts), which is one of React's testRoots.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalPlatform } from "@polaris-key/client-core";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { Platform, SdkId } from "../src/constants.generated.js";
import { makeDoc, makeFakeFetch, NOW_SEC } from "./fixtures.js";

interface HeaderCase {
  id: string;
  raw: string;
  expect: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "..", "conformance", "corpus", "v2", "headers.json"),
    "utf8",
  ),
) as {
  headersVersion: number;
  platformCases: HeaderCase[];
  archCases: HeaderCase[];
};

async function capturedSessionHeaders(): Promise<Record<string, string>> {
  const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
  const adapter = browserAdapter({
    productSlug: "acme",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW_SEC,
    version: "1.4.2",
  });
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
  const call = fetchImpl.mock.calls.find((c) =>
    String(c[0]).includes("/identity/session"),
  );
  adapter.dispose();
  return (call?.[1] as RequestInit).headers as Record<string, string>;
}

describe("React's header values (headers.json)", () => {
  it("is headersVersion 2", () => {
    expect(corpus.headersVersion).toBe(2);
    expect(corpus.platformCases.length).toBeGreaterThanOrEqual(31);
  });

  it("the captured request carries web, no arch and react", async () => {
    const headers = await capturedSessionHeaders();
    expect(headers["X-PKey-Platform"]).toBe("web");
    expect(headers["X-PKey-Arch"]).toBeUndefined();
    expect(headers["X-PKey-SDK"]).toBe("react");
    expect(SdkId.react).toBe("react");
  });

  const webRows = corpus.platformCases.filter((r) => r.expect === "web");

  it("the web rows exist and agree with what React sends", async () => {
    expect(webRows.length).toBeGreaterThanOrEqual(3);
    const sent = (await capturedSessionHeaders())["X-PKey-Platform"];
    for (const row of webRows) {
      expect(canonicalPlatform(row.raw)).toBe(row.expect);
      expect(sent).toBe(row.expect);
    }
    expect(Platform.web).toBe("web");
  });

  it("a doctored row fails the same comparison", async () => {
    const sent = (await capturedSessionHeaders())["X-PKey-Platform"];
    const doctored = { ...webRows[0]!, expect: "browser" };
    expect(sent === webRows[0]!.expect).toBe(true);
    expect(sent === doctored.expect).toBe(false);
  });
});
