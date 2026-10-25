import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACTION_REF_PLACEHOLDER, renderCiWorkflow } from "./ciWorkflow.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("renderCiWorkflow", () => {
  it("renders the workflow without release keys", () => {
    expect(
      renderCiWorkflow({
        product: "tonebox",
        channel: "stable",
        actionRef: SHA,
        releaseKeys: false,
      }),
    )
      .toBe(`# Publishes tonebox (the slug in .pkey/product) when a v* tag is pushed.
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      # Build your files into dist here, before the publish step.
      - uses: vladzaharia/polaris-key/actions/publish@${SHA}
        with:
          args: --tag \${{ github.ref_name }} --channel stable --dir dist
`);
  });

  it("adds the release key only when declared; channels is left at its default", () => {
    const out = renderCiWorkflow({
      product: "tonebox",
      channel: "beta",
      actionRef: ACTION_REF_PLACEHOLDER,
      releaseKeys: true,
      dir: "out",
    });
    expect(out).toContain("release-key: ${{ secrets.PKEY_RELEASE_KEY }}");
    expect(out).toContain("--channel beta --dir out");
    expect(out).not.toContain("channels:");
    expect(out).not.toContain("content-key");
  });

  it("adds a job per pack, signed with the release key", () => {
    const out = renderCiWorkflow({
      product: "tonebox",
      channel: "stable",
      actionRef: SHA,
      releaseKeys: true,
      packs: [{ id: "voices", dir: "packs/voices" }],
    });
    const doc = parse(out) as {
      jobs: Record<string, { environment: string; steps: unknown[] }>;
    };
    expect(Object.keys(doc.jobs)).toEqual(["publish", "publish-pack-voices"]);
    expect(out).toContain("--deliverable voices --dir packs/voices");
    expect(out).toContain(
      "--tag ${{ github.ref_name }} --channel stable --deliverable voices",
    );
    expect(out).not.toContain("content-key");
    expect(out.match(/release-key:/g)).toHaveLength(2);
  });

  it("parses as YAML with the pinned shape", () => {
    const doc = parse(
      renderCiWorkflow({
        product: "tonebox",
        channel: "stable",
        actionRef: SHA,
        releaseKeys: true,
      }),
    ) as any;
    expect(doc.on.push.tags).toEqual(["v*"]);
    expect(doc.jobs.publish.environment).toBe("release");
    expect(doc.jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
  });

  it("refuses text that could break out of the workflow", () => {
    for (const bad of [
      { channel: "a --base-url x" },
      { product: "a\nb" },
      { dir: "x; rm" },
      { actionRef: "v1" },
    ]) {
      expect(() =>
        renderCiWorkflow({
          product: "p",
          channel: "stable",
          actionRef: SHA,
          releaseKeys: false,
          ...bad,
        }),
      ).toThrow();
    }
  });
});
