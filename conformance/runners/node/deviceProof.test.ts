// The Node conformance runner for `conformance/corpus/v2/device-proof.json` (WIRE-CONTRACT-V5
// §12.11.1, §15.8). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Every row: the message bytes (or none, when a field breaks the line format) and the verdict.
// The `keys` value is rebuilt from its parts. The signer and the key stores are CC-26's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEVICE_PROOF_PURPOSES,
  deviceProofKeysValue,
  deviceProofMessage,
  verifyDeviceProof,
  type DeviceProof,
} from "@polaris-key/client-core";

interface Row extends DeviceProof {
  id: string;
  now: number;
  verdict: "ok" | "fail";
  messageHex: string | null;
}
interface Corpus {
  deviceProofVersion: number;
  line1: string;
  purposes: string[];
  skewSeconds: number;
  keyValueCases: {
    signKey: string;
    agreeKey: string;
    issuedAt: number;
    value: string;
  }[];
  cases: Row[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "../../corpus/v2/device-proof.json"), "utf8"),
) as Corpus;
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("device-proof.json", () => {
  it("names the purposes the client knows", () => {
    expect(corpus.deviceProofVersion).toBe(1);
    expect(corpus.line1).toBe("pkey-proof/1");
    expect(corpus.purposes).toEqual([...DEVICE_PROOF_PURPOSES]);
  });

  it("builds the keys value from its parts", () => {
    for (const c of corpus.keyValueCases)
      expect(deviceProofKeysValue(c.signKey, c.agreeKey, c.issuedAt)).toBe(
        c.value,
      );
  });

  it.each(corpus.cases.map((r) => [r.id, r] as const))("%s", async (_id, r) => {
    const msg = deviceProofMessage(r);
    expect(msg === null ? null : hex(msg)).toBe(r.messageHex);
    expect(await verifyDeviceProof(r, { now: r.now })).toBe(r.verdict === "ok");
  });
});
