// The generated local-link corpus sections equal what their generators build (CC-29.1 to CC-29.3):
// `pnpm gen corpus --check` in process, for the two files that carry the sections.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildNoiseVectors } from "./corpus/noise.js";
import { buildPeerMatrix } from "./corpus/peerMatrix.js";
import { buildDeviceLabelCorpus } from "./corpus/device-label.js";
import {
  buildAdmissionCases,
  buildPeerCertCases,
  buildRingCases,
} from "./corpus/peer.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "conformance",
  "corpus",
  "v2",
);
const committed = (f: string): unknown =>
  JSON.parse(readFileSync(join(dir, f), "utf8"));
const same = (a: unknown): unknown => JSON.parse(JSON.stringify(a));

describe("local-link corpus sections", () => {
  it("noise-vectors.json carries the cpace section as built", () => {
    const built = same(buildNoiseVectors()) as Record<string, unknown>;
    expect(built.cpace).toEqual(
      (committed("noise-vectors.json") as Record<string, unknown>).cpace,
    );
  });
  it("peer-matrix.json carries the local section as built", () => {
    const built = same(buildPeerMatrix()) as Record<string, unknown>;
    expect(built.local).toEqual(
      (committed("peer-matrix.json") as Record<string, unknown>).local,
    );
  });
  // The peer references the local-link rows build on: label cleaning, ring and admission cases.
  it("device-label.json carries the label corpus as built", () => {
    expect(same(buildDeviceLabelCorpus())).toEqual(
      committed("device-label.json"),
    );
  });
  it("cases.json carries the ring and admission cases as built", async () => {
    const c = committed("cases.json") as Record<string, unknown>;
    expect(await buildPeerCertCases()).toHaveLength(
      (c.peerCertCases as unknown[]).length,
    );
    expect(same(await buildRingCases())).toEqual(c.ringCases);
    expect(same(await buildAdmissionCases())).toEqual(c.peerAdmissionCases);
  });
});
