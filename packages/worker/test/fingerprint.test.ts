import { describe, it, expect } from "vitest";
import {
  FINGERPRINT_COMPONENT_LENGTH,
  FINGERPRINT_HWID_LENGTH,
} from "@plrs/protocol";
import {
  computeComponentHash,
  computeHwid,
  matchFingerprint,
  parseFingerprint,
  resolveFingerprintMode,
  type ComponentMap,
  type StoredFingerprint,
} from "../src/fingerprint.js";

/** A syntactically valid component digest, distinguishable by its leading char. */
function hash(seed: string): string {
  return seed
    .padEnd(FINGERPRINT_COMPONENT_LENGTH, "x")
    .slice(0, FINGERPRINT_COMPONENT_LENGTH);
}

const FULL: ComponentMap = {
  machineUuid: hash("uuid"),
  boardSerial: hash("board"),
  cpuModel: hash("cpu"),
  primaryMac: hash("mac"),
  bootVolumeUuid: hash("boot"),
  ramBucket: hash("ram"),
  machineModel: hash("model"),
};

function stored(
  components: ComponentMap = FULL,
  anchorHash: string | null = components.machineUuid ?? null,
): StoredFingerprint {
  return { hwid: "stored-hwid", components, anchorHash, status: "verified" };
}

describe("parseFingerprint", () => {
  it("accepts a well-formed component map", () => {
    const parsed = parseFingerprint({ components: FULL, hwid: "whatever" });
    expect(parsed?.components).toEqual(FULL);
  });

  it("ignores the client-supplied hwid entirely", () => {
    // The server recomputes it; a forged value must not be able to reach the dedupe index.
    const parsed = parseFingerprint({ components: FULL, hwid: "forged" });
    expect(parsed).not.toHaveProperty("hwid");
  });

  it("drops unknown component names instead of rejecting", () => {
    // A newer SDK reporting a component this Worker doesn't know must still activate.
    const parsed = parseFingerprint({
      components: { machineUuid: hash("uuid"), tpmEndorsement: hash("tpm") },
    });
    expect(parsed?.components).toEqual({ machineUuid: hash("uuid") });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing components map", {}],
    ["an empty components map", { components: {} }],
    ["a components array", { components: [] }],
    ["a non-string value", { components: { machineUuid: 42 } }],
    ["a short digest", { components: { machineUuid: "abc" } }],
    ["a non-base64url digest", { components: { machineUuid: hash("a/b+c") } }],
  ])("rejects %s", (_label, input) => {
    expect(parseFingerprint(input)).toBeNull();
  });
});

describe("computeHwid", () => {
  it("is deterministic and correctly sized", async () => {
    const a = await computeHwid(FULL);
    const b = await computeHwid(FULL);
    expect(a).toBe(b);
    expect(a).toHaveLength(FINGERPRINT_HWID_LENGTH);
  });

  it("is independent of key insertion order", async () => {
    const reversed: ComponentMap = {};
    for (const key of Object.keys(FULL).reverse()) {
      reversed[key as keyof ComponentMap] = FULL[key as keyof ComponentMap];
    }
    expect(await computeHwid(reversed)).toBe(await computeHwid(FULL));
  });

  it("changes when any component changes", async () => {
    const drifted = { ...FULL, primaryMac: hash("mac2") };
    expect(await computeHwid(drifted)).not.toBe(await computeHwid(FULL));
  });

  it("changes when a component is dropped", async () => {
    const partial = { ...FULL };
    delete partial.ramBucket;
    expect(await computeHwid(partial)).not.toBe(await computeHwid(FULL));
  });
});

describe("computeComponentHash", () => {
  it("is domain-separated by product and component", async () => {
    const a = await computeComponentHash("djdl", "machineUuid", "RAW");
    const b = await computeComponentHash("other", "machineUuid", "RAW");
    const c = await computeComponentHash("djdl", "boardSerial", "RAW");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toHaveLength(FINGERPRINT_COMPONENT_LENGTH);
  });
});

describe("matchFingerprint", () => {
  it("reports exact when nothing changed", () => {
    expect(matchFingerprint(stored(), { components: FULL }, "normal")).toEqual({
      kind: "exact",
    });
  });

  it("tolerates two changed components at normal", () => {
    const presented = {
      ...FULL,
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
    };
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "normal",
    );
    expect(result.kind).toBe("drift");
    expect(result).toMatchObject({ drift: 2 });
  });

  it("widens tolerance to three when the anchor still matches", () => {
    // machineUuid intact => a disk + NIC + RAM swap is still the same machine.
    const presented = {
      ...FULL,
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
      primaryMac: hash("mac2"),
    };
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "normal",
    );
    expect(result).toMatchObject({ kind: "drift", drift: 3 });
  });

  it("does not widen tolerance when the anchor itself changed", () => {
    const presented = {
      ...FULL,
      machineUuid: hash("uuid2"),
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
    };
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "normal",
    );
    expect(result).toMatchObject({ kind: "mismatch", drift: 3 });
  });

  it("counts a dropped component as drift", () => {
    // Otherwise a caller could omit every component that doesn't match and pass at tolerance 0.
    const presented = { ...FULL };
    delete presented.boardSerial;
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "strict",
    );
    expect(result).toMatchObject({ kind: "mismatch", drift: 1 });
  });

  it("does not penalise a newly reported component", () => {
    // An SDK upgrade that learns to read more components must not look like hardware drift.
    const before = { machineUuid: FULL.machineUuid, cpuModel: FULL.cpuModel };
    const result = matchFingerprint(
      stored(before),
      { components: FULL },
      "strict",
    );
    expect(result).toEqual({ kind: "exact" });
  });

  it("rejects any drift at strict", () => {
    const presented = { ...FULL, ramBucket: hash("ram2") };
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "strict",
    );
    expect(result).toMatchObject({ kind: "mismatch", drift: 1 });
  });

  it("tolerates four changed components at lenient", () => {
    const presented = {
      ...FULL,
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
      primaryMac: hash("mac2"),
      bootVolumeUuid: hash("boot2"),
      machineModel: hash("model2"),
    };
    // 5 changed, anchor intact => tolerance 4 + 1 = 5.
    expect(
      matchFingerprint(stored(), { components: presented }, "lenient"),
    ).toMatchObject({ kind: "drift", drift: 5 });
  });

  it("never rejects at off, even with everything changed", () => {
    const presented: ComponentMap = {
      machineUuid: hash("z1"),
      boardSerial: hash("z2"),
      cpuModel: hash("z3"),
      primaryMac: hash("z4"),
      bootVolumeUuid: hash("z5"),
      ramBucket: hash("z6"),
      machineModel: hash("z7"),
    };
    expect(
      matchFingerprint(stored(), { components: presented }, "off").kind,
    ).toBe("drift");
  });

  it("names the changed components so drift can be audited", () => {
    const presented = {
      ...FULL,
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
    };
    const result = matchFingerprint(
      stored(),
      { components: presented },
      "normal",
    );
    expect(result.kind === "drift" && result.changed.sort()).toEqual([
      "cpuModel",
      "ramBucket",
    ]);
  });
});

describe("resolveFingerprintMode", () => {
  it("prefers the tier policy over the product default", () => {
    expect(resolveFingerprintMode("strict", "lenient")).toBe("strict");
  });

  it("falls back to the product default when the tier is unset", () => {
    expect(resolveFingerprintMode(null, "lenient")).toBe("lenient");
  });

  it("defaults to normal when neither is set or either is nonsense", () => {
    expect(resolveFingerprintMode(null, null)).toBe("normal");
    expect(resolveFingerprintMode("bogus", undefined)).toBe("normal");
  });
});
