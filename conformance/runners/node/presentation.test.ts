// @pkey-feature core.presentation
// `conformance/corpus/v2/presentation-matrix.json` through the Node SDK (plans/HA-13.md §5):
//
//   parseCases   the client's own path: `PresentationStore.accept()` on a discovery document
//                carrying the row's `core`, then `current()`, then a cold start that reads the
//                member back from `presentation.json` and must yield the same value
//   pickCases    client-core's `pickIconSize`, which the Node SDK uses directly
//   verifyCases  the SDK's fetch path: `fetchIconBytes` hands bytes back only when they hash to
//                the row's `sha256`

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickIconSize } from "@polaris-key/client-core/presentation";
import { fetchIconBytes, PresentationStore } from "@polaris-key/node/core";
import { PRESENTATION_MATRIX_VERSION } from "@polaris-key/node";

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "presentation-matrix.json"),
    "utf8",
  ),
) as {
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

describe("presentation-matrix.json: @polaris-key/node", () => {
  it("is the version this SDK was built against", () => {
    expect(MATRIX.presentationMatrixVersion).toBe(PRESENTATION_MATRIX_VERSION);
  });

  for (const c of MATRIX.parseCases)
    it(`parse: ${c.name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pkey-presentation-matrix-"));
      const store = new PresentationStore({
        product: c.doc.product,
        dir,
        fetcher: noNetwork,
      });
      await store.accept({
        core: c.core,
        name: c.doc.name,
        product: c.doc.product,
      });
      expect(store.current()).toEqual(c.expect);
      // The fixed point: what was stored reads back to itself on a cold start.
      const cold = new PresentationStore({
        product: c.doc.product,
        dir,
        fetcher: noNetwork,
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
      const bytes = Buffer.from(c.bytes, "base64");
      const f = (async () =>
        new Response(new Uint8Array(bytes), { status: 200 })) as typeof fetch;
      const got = await fetchIconBytes(f, { url, sha256: c.sha256 }, url);
      expect(got !== null).toBe(c.expect);
      if (got !== null) expect(Buffer.from(got)).toEqual(bytes);
    });
});
