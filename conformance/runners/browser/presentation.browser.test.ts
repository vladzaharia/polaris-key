// @pkey-feature core.presentation
// `presentation-matrix.json` in a real browser engine, through the React SDK's browser source
// (plans/HA-13.md §5): every parse row via `BrowserPresentationSource.accept()` and a cold start
// from its cache, every pick row via client-core's `pickIconSize` (the SDK uses it directly), and
// every verify row via the browser fetch path (`fetchIconBytes`), whose WebCrypto is this
// engine's own.

import presentationMatrix from "../../corpus/v2/presentation-matrix.json";
import { describe, expect, it } from "vitest";
import { pickIconSize } from "@polaris-key/client-core/presentation";
import {
  BrowserPresentationSource,
  fetchIconBytes,
  memoryPresentationCache,
} from "@polaris-key/react/core";

const MATRIX = presentationMatrix as unknown as {
  presentationMatrixVersion: number;
  parseCases: {
    name: string;
    core: unknown;
    doc: { name?: unknown; product: string };
    expect: unknown;
  }[];
  pickCases: {
    name: string;
    icon: Parameters<typeof pickIconSize>[0];
    px: number;
    scale: number;
    decodable: string[];
    expect: unknown;
  }[];
  verifyCases: {
    name: string;
    bytes: string;
    sha256: string;
    expect: boolean;
  }[];
};

const noNetwork = (): typeof fetch => {
  throw new Error("the parse rows never dial");
};

const fromBase64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe("presentation-matrix.json in the browser", () => {
  it("is version 1", () => {
    expect(MATRIX.presentationMatrixVersion).toBe(1);
  });

  for (const c of MATRIX.parseCases)
    it(`parse: ${c.name}`, async () => {
      const cache = memoryPresentationCache();
      const s = new BrowserPresentationSource({
        product: c.doc.product,
        fetchImpl: noNetwork,
        cache,
      });
      await s.accept({
        core: c.core,
        name: c.doc.name,
        product: c.doc.product,
      });
      expect(s.current()).toEqual(c.expect);
      const cold = new BrowserPresentationSource({
        product: c.doc.product,
        fetchImpl: noNetwork,
        cache,
      });
      await cold.load();
      expect(cold.current()).toEqual(c.expect);
    });

  for (const c of MATRIX.pickCases)
    it(`pick: ${c.name}`, () => {
      expect(pickIconSize(c.icon, c.px, c.scale, c.decodable)).toEqual(
        c.expect,
      );
    });

  for (const c of MATRIX.verifyCases)
    it(`verify: ${c.name}`, async () => {
      const url = "https://img.plrs.im/p/a/icon";
      const bytes = fromBase64(c.bytes);
      const f = (async () =>
        new Response(bytes.slice(), { status: 200 })) as typeof fetch;
      const got = await fetchIconBytes(f, { url, sha256: c.sha256 }, url);
      expect(got !== null).toBe(c.expect);
      if (got !== null) expect(Array.from(got)).toEqual(Array.from(bytes));
    });
});
