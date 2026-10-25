import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  SetupChangeError,
  composeSetupChange,
  insertOutletBlock,
  outletBlockEntry,
  OutletInsertError,
  type IngestDocuments,
} from "../src/index.js";
import { product, release } from "./manifestDocs.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const documents: IngestDocuments = {
  product,
  schema: { schemaVersion: 1, entries: [] },
  release,
};
const itch = {
  channel: "itch",
  identity: { target: "acme/dice", gameId: "1" },
};

describe("insertOutletBlock", () => {
  const block = outletBlockEntry("itch", { target: "acme/dice", gameId: "1" });
  it("keeps the file's comments and appends the commented entry (yaml)", () => {
    const out = insertOutletBlock(
      "# my outlets\noutlets:\n  # existing\n  direct:\n    kind: direct\n",
      "yaml",
      block,
    );
    expect(out).toContain("# my outlets");
    expect(out).toContain("# existing");
    expect(out).toMatch(/# itch\.io/i);
    expect(Object.keys(YAML.parse(out).outlets)).toEqual(["direct", "itch"]);
  });
  it("starts a file from empty text", () => {
    expect(
      YAML.parse(insertOutletBlock("", "yaml", block)).outlets.itch.kind,
    ).toBe("itch");
  });
  it("rewrites json with two-space indent and a trailing newline", () => {
    const out = insertOutletBlock('{"outlets":{}}', "json", block);
    expect(out).toBe(
      `${JSON.stringify({ outlets: { itch: block.entry } }, null, 2)}\n`,
    );
  });
  it("refuses a duplicate and a non-mapping", () => {
    const once = insertOutletBlock("", "yaml", block);
    expect(() => insertOutletBlock(once, "yaml", block)).toThrow(
      OutletInsertError,
    );
    expect(() => insertOutletBlock("[]", "json", block)).toThrow(
      OutletInsertError,
    );
    expect(() => insertOutletBlock("outlets: 3", "yaml", block)).toThrow(
      OutletInsertError,
    );
  });
});

describe("composeSetupChange", () => {
  it("creates the distribution file and the workflow, validated", () => {
    const out = composeSetupChange({
      documents,
      distribution: null,
      outlets: [itch],
      workflow: { actionRef: SHA, channel: "stable" },
    });
    expect(out.files.map((f) => f.path)).toEqual([
      ".pkey/distribution.yaml",
      ".github/workflows/release.yml",
    ]);
    expect(out.summary).toEqual({ outlets: ["itch"], workflow: true });
    expect(out.files[1]!.text).toContain(`publish@${SHA}`);
    expect(out.files[1]!.text).not.toContain("release-key");
  });
  it("gives the step the release key when .pkey/release declares releaseKeys", () => {
    const withKeys = {
      ...documents,
      release: {
        release: {
          ...release.release,
          releaseKeys: [
            {
              kid: "ci-1",
              publicKey: "3aMoWC5MK15VC1dKg4dO93x7w2wAqxX_BM0MI_--tzc",
            },
          ],
        },
      },
    };
    const out = composeSetupChange({
      documents: withKeys,
      distribution: null,
      outlets: [],
      workflow: { actionRef: SHA, channel: "stable" },
    });
    expect(out.files[0]!.text).toContain("release-key:");
  });
  it("appends to an existing json file in place", () => {
    const out = composeSetupChange({
      documents,
      distribution: { path: ".pkey/distribution.json", text: '{"outlets":{}}' },
      outlets: [itch],
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.path).toBe(".pkey/distribution.json");
    expect(JSON.parse(out.files[0]!.text).outlets.itch.kind).toBe("itch");
  });
  it("refuses a duplicate outlet, an invalid result and an empty change", () => {
    const text =
      "outlets:\n  itch:\n    kind: itch\n    target: acme/dice\n    gameId: '1'\n";
    expect(() =>
      composeSetupChange({
        documents,
        distribution: { path: ".pkey/distribution.yaml", text },
        outlets: [itch],
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_outlet" }));
    expect(() =>
      composeSetupChange({
        documents,
        distribution: null,
        outlets: [{ channel: "itch", identity: { target: "nope" } }],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() =>
      composeSetupChange({ documents, distribution: null, outlets: [] }),
    ).toThrowError(expect.objectContaining({ code: "nothing" }));
  });
});
