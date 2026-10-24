import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { parseManifest, renderOutletBlock } from "../src/index.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/outlet-block",
);
const update = process.env.UPDATE_GOLDENS === "1";

const product = {
  slug: "dice",
  name: "Dice",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
  },
};
const release = {
  release: {
    provider: { type: "github", owner: "acme", repo: "dice" },
    deliverables: {
      app: {
        kind: "app",
        artifacts: [
          {
            id: "apk",
            platform: "android",
            arch: "any",
            format: "apk",
            match: "Dice-*.apk",
          },
        ],
      },
    },
  },
};

const CASES: {
  name: string;
  channel: string;
  identity: Record<string, unknown>;
}[] = [
  {
    name: "itch",
    channel: "itch",
    identity: { target: "acme/dice", gameId: "123456" },
  },
  {
    name: "snap",
    channel: "snap",
    identity: { name: "dice", channels: { stable: "stable" } },
  },
  {
    name: "homebrew-cask",
    channel: "homebrew",
    identity: {
      platforms: ["macos"],
      homebrewCask: "dice",
      homebrewTap: "acme/homebrew-tap",
    },
  },
  {
    name: "homebrew-formula",
    channel: "homebrew",
    identity: { platforms: ["linux"], homebrewFormula: "dice" },
  },
  {
    name: "scoop",
    channel: "scoop",
    identity: {
      platforms: ["windows"],
      scoop: { bin: "dice.exe" },
      scoopBucket: "acme/scoop-bucket",
    },
  },
  {
    name: "winget",
    channel: "winget",
    identity: { packageIdentifier: "Acme.Dice" },
  },
  { name: "flathub", channel: "flathub", identity: { appId: "com.acme.Dice" } },
  {
    name: "fdroid",
    channel: "fdroid",
    identity: { artifact: "apk", packageName: "com.acme.dice" },
  },
];

function check(file: string, actual: string) {
  const path = join(dir, file);
  if (update) writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

describe("renderOutletBlock", () => {
  for (const c of CASES) {
    for (const format of ["yaml", "json"] as const) {
      it(`${c.name} (${format}): matches its golden and validates`, () => {
        const out = renderOutletBlock(c.channel, c.identity, { format });
        check(`${c.name}.${format}`, out);
        const doc = format === "yaml" ? YAML.parse(out) : JSON.parse(out);
        const result = parseManifest({
          product: JSON.stringify(product),
          schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
          release: JSON.stringify(release),
          distribution: JSON.stringify(doc),
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
      });
    }
  }

  it("yaml carries the label and one comment per field", () => {
    const out = renderOutletBlock(
      "itch",
      { gameId: "1", target: "a/b" },
      { format: "yaml" },
    );
    expect(
      out.split("\n").filter((l) => l.trim().startsWith("#")),
    ).toHaveLength(3);
    expect(out.indexOf("target")).toBeLessThan(out.indexOf("gameId"));
  });

  it("an outlet id option renames the entry", () => {
    const out = renderOutletBlock(
      "snap",
      {},
      { format: "json", outletId: "snap-beta" },
    );
    expect(JSON.parse(out)).toEqual({
      outlets: { "snap-beta": { kind: "snap" } },
    });
  });

  it("an unknown channel names the known ones", () => {
    expect(() => renderOutletBlock("nope", {}, { format: "yaml" })).toThrow(
      /unknown channel "nope"; known channels: polaris-key, .*itch/,
    );
  });

  it("an unknown field names the known ones", () => {
    expect(() =>
      renderOutletBlock("itch", { bogus: 1 }, { format: "yaml" }),
    ).toThrow(
      /unknown field bogus for channel itch; known fields: target, gameId/,
    );
  });
});
