// @pkey-feature core.devicekeys
// The Node conformance runner for `conformance/corpus/v2/device-proof.json` (WIRE-CONTRACT-V5
// §12.11.1, §15.8). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Every row: the message bytes (or none, when a field breaks the line format) and the verdict.
// The `keys` value is rebuilt from its parts. The signer and the key stores (CC-26.1) are the last describe.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEVICE_PROOF_PURPOSES,
  createWebDeviceKeyStore,
  deviceProofKeysValue,
  deviceProofMessage,
  memoryDeviceKeyStorage,
  signDeviceProof,
  signKeysProof,
  verifyDeviceProof,
  type DeviceKeyPort,
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

// The signer (CC-26.1): every valid row's fields, signed by a fresh store key, give the row's
// message bytes (a `keys` value names the key, so only its shape is compared) and verify.
describe("device-proof.json through the signer", () => {
  const valid = corpus.cases.filter((r) => r.id.startsWith("valid-"));

  it("covers every purpose", () => {
    expect(valid.map((r) => r.purpose)).toEqual([...DEVICE_PROOF_PURPOSES]);
  });

  it.each(valid.map((r) => [r.id, r] as const))("signs %s", async (_id, r) => {
    const store = createWebDeviceKeyStore({
      storage: memoryDeviceKeyStorage(),
    });
    const seen: Uint8Array[] = [];
    const port: DeviceKeyPort = {
      ensure: () => store.ensure(),
      publicKeys: () => store.publicKeys(),
      sign: (m) => (seen.push(m), store.sign(m)),
      dh: (p) => store.dh(p),
      rotate: () => store.rotate(),
      wipe: () => store.wipe(),
    };
    let proof: DeviceProof;
    if (r.purpose === "keys") {
      const out = await signKeysProof(port, {
        product: r.product,
        deviceId: r.deviceId,
        issuedAt: r.now,
      });
      proof = out.proof;
      expect(proof.value).toBe(
        deviceProofKeysValue(out.keys.signKey, out.keys.agreeKey, out.issuedAt),
      );
      const expected = hex(deviceProofMessage(proof)!);
      expect(hex(seen[0]!)).toBe(expected);
      // Same layout as the corpus row, apart from the key-bearing value line.
      const ref = new TextDecoder().decode(Buffer.from(r.messageHex!, "hex"));
      const mine = new TextDecoder().decode(seen[0]!);
      const a = ref.split("\n");
      const b = mine.split("\n");
      expect(b.length).toBe(a.length);
      expect(b.filter((_, i) => i !== 4)).toEqual(a.filter((_, i) => i !== 4));
    } else {
      proof = await signDeviceProof(port, {
        purpose: r.purpose,
        product: r.product,
        deviceId: r.deviceId,
        value: r.value,
        tokenHash: r.tokenHash,
        now: r.now,
      });
      expect(seen).toHaveLength(1);
      expect(hex(seen[0]!)).toBe(r.messageHex);
    }
    expect(await verifyDeviceProof(proof, { now: r.now })).toBe(true);
    // The row's own (corpus-key) signature does not verify under this store's key.
    expect(
      await verifyDeviceProof({ ...proof, sig: r.sig }, { now: r.now }),
    ).toBe(false);
  });
});
