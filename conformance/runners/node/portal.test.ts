// @pkey-feature ui.cli.portal
// `conformance/corpus/v2/portal-matrix.json` through the Node SDK (plans/DISC-01.md §4):
//
//   parseCases  the client's own path: `PortalStore.accept()` on a discovery document carrying the
//               row's `core`, then `current()`, then a cold start that reads the member back from
//               `portal.json` and must yield the same value
//   linkCases   client-core's `portalLink`, which the Node kit resolves its link through (the
//               kit's own wrapper is run over the same rows in packages/sdk-node/test/cli/portalUrl.test.ts)

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PORTAL_MATRIX_VERSION } from "@polaris-key/node";
import { portalLink, type ParsedPortal } from "@polaris-key/client-core/portal";
import { PortalStore } from "@polaris-key/node/core";

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "portal-matrix.json"),
    "utf8",
  ),
) as {
  portalMatrixVersion: number;
  parseCases: { name: string; core: unknown; expect: unknown }[];
  linkCases: {
    name: string;
    served: string | null;
    portal: unknown;
    baseUrl: string;
    product: string;
    expect: string | null;
  }[];
};

describe("portal-matrix.json: @polaris-key/node", () => {
  it("is the version this SDK was built against", () => {
    expect(MATRIX.portalMatrixVersion).toBe(PORTAL_MATRIX_VERSION);
  });

  for (const c of MATRIX.parseCases)
    it(`parse: ${c.name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pkey-portal-matrix-"));
      const opts = { product: "djdl", baseUrl: "https://key.plrs.im", dir };
      const store = new PortalStore(opts);
      await store.accept({ core: c.core });
      expect(store.current()).toEqual(c.expect);
      // The fixed point: what was stored reads back to itself on a cold start.
      const cold = new PortalStore(opts);
      await cold.load();
      expect(cold.current()).toEqual(c.expect);
    });

  for (const c of MATRIX.linkCases)
    it(`link: ${c.name}`, () => {
      expect(
        portalLink({
          served: c.served,
          portal: c.portal as ParsedPortal | null,
          baseUrl: c.baseUrl,
          product: c.product,
        }),
      ).toBe(c.expect);
    });
});
