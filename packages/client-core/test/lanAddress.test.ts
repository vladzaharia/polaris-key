// client-core's proof for the LAN address rule (WIRE-CONTRACT-V5 §15.4.1, plans/CC-IPV6.md): every
// row of `conformance/corpus/v2/peer-matrix.json` `lanAddresses`, which the corpus generator
// recomputed with its own reference (tools/corpus/reference/lanAddress.ts). Then the edges the
// corpus cannot carry.
// @pkey-feature connect.lan
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lanVerdict } from "../src/peer/index.js";

interface Row {
  id: string;
  remote: string;
  local?: string;
  allowLoopback: boolean;
  dial: boolean;
  key: string | null;
}

const MATRIX = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "peer-matrix.json",
    ),
    "utf8",
  ),
) as { lanAddresses: { rows: Row[] } };

describe("lanVerdict: peer-matrix lanAddresses", () => {
  const rows = MATRIX.lanAddresses.rows;

  it("has the rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(35);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it.each(rows.map((r) => [r.id, r] as const))("%s", (_id, r) => {
    expect(lanVerdict(r.remote, r.local, r.allowLoopback)).toEqual({
      dial: r.dial,
      key: r.key,
    });
  });
});

describe("lanVerdict: edges", () => {
  it("treats an absent and a null local alike", () => {
    expect(lanVerdict("2001:db8::1", null, false)).toEqual(
      lanVerdict("2001:db8::1", undefined, false),
    );
  });

  it("never gives a key for a refusal", () => {
    for (const a of ["8.8.8.8", "::", "ff02::fb", "not an address", ""])
      expect(lanVerdict(a, "2001:db8::2", true)).toEqual({
        dial: false,
        key: null,
      });
  });

  it("keys on the full address, not the /64", () => {
    const a = lanVerdict("fd00:1:2:3::5", null, false).key;
    const b = lanVerdict("fd00:1:2:3::6", null, false).key;
    expect(a).not.toBe(b);
  });

  it("gives one key to every spelling of an address", () => {
    const spellings = [
      "FD00:0:0:0:0:0:0:5",
      "fd00::5",
      "fd00::5%en0",
      "fd00::0.0.0.5",
    ];
    expect(
      new Set(spellings.map((s) => lanVerdict(s, null, false).key)),
    ).toEqual(new Set(["fd00::5"]));
  });

  it("does not let a local global address on the same /64 widen a link-local verdict", () => {
    expect(lanVerdict("fe80::1", "2001:db8:1:2::9", false).key).toBe("fe80::1");
    expect(lanVerdict("2001:db8:1:2::5", "fe80::9", false).dial).toBe(false);
  });
});
