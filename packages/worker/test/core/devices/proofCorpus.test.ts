// The Worker's `pkey-proof/1` verifier over every row of `device-proof.json` (CC-03.4, R-6).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deviceProofMessage,
  keyPopValue,
  verifyDeviceProof,
} from "../../../src/core/devices/proof.js";
import { WORKER_ROOT } from "../../paths.js";

type Row = Parameters<typeof verifyDeviceProof>[0] & {
  id: string;
  verdict: string;
  messageHex: string | null;
};
interface Corpus {
  purposes: string[];
  keyValueCases: unknown[];
  cases: Row[];
}

const path = join(WORKER_ROOT, "../../conformance/corpus/v2/device-proof.json");
const corpus = JSON.parse(readFileSync(path, "utf8")) as Corpus;
describe("device-proof.json", () => {
  it("has a valid row for every purpose", () => {
    for (const p of corpus.purposes)
      expect(
        corpus.cases.some((r) => r.purpose === p && r.verdict === "ok"),
      ).toBe(true);
  });

  for (const r of corpus.cases)
    it(r.id, async () => {
      const msg = deviceProofMessage(r);
      expect(msg && Buffer.from(msg).toString("hex")).toBe(r.messageHex);
      expect(await verifyDeviceProof(r)).toBe(r.verdict === "ok");
    });

  it("builds the keys value from its parts", () => {
    type Parts = { signKey: string; agreeKey: string; issuedAt: number };
    for (const c of corpus.keyValueCases as (Parts & { value: string })[])
      expect(keyPopValue(c.signKey, c.agreeKey, c.issuedAt)).toBe(c.value);
  });
});
