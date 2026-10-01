/**
 * P3-03 — the descriptor → release record mapping (plans/P3-01.md §2.4): the CLI signs this
 * object and the Worker's ingest refuses any other (`descriptor-mismatch`).
 */
import { describe, expect, it } from "vitest";
import { descriptorToRecord, type ReleaseDescriptor } from "../src/index.js";

const SHA = "a".repeat(64);

function descriptor(): ReleaseDescriptor {
  return {
    descriptorVersion: 1,
    product: "acme",
    deliverable: "app",
    kind: "app",
    version: "1.2.3",
    seq: 7,
    tag: "v1.2.3",
    channel: "stable",
    title: "1.2.3",
    notes: "Fixes.",
    publishedAt: "2026-10-01T00:00:00Z",
    provenance: { commit: "b".repeat(40), workflowRun: "https://x/1" },
    builds: [
      {
        id: "macos",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        buildNumber: "4022",
        minOS: "13.0",
        requires: { engine: "4.3" },
        artifacts: [
          {
            name: "Acme-1.2.3-macos.dmg",
            role: "payload",
            sha256: SHA,
            size: 10,
            contentType: "application/x-apple-diskimage",
            locations: [{ provider: "r2", key: `blobs/sha256/${SHA}` }],
          },
        ],
      },
      {
        id: "ios",
        platform: "ios",
        arch: "arm64",
        format: "ipa",
        artifacts: [],
      },
    ],
  };
}

describe("descriptorToRecord", () => {
  it("moves the descriptor: product → aud, drops descriptorVersion, publishedAt and locations", () => {
    expect(
      descriptorToRecord(descriptor(), {
        seq: 7,
        issuedAt: 1700000000,
        minSupportedSeq: 3,
      }),
    ).toEqual({
      schemaVersion: 1,
      aud: "acme",
      deliverable: "app",
      kind: "app",
      version: "1.2.3",
      seq: 7,
      issuedAt: 1700000000,
      minSupportedSeq: 3,
      tag: "v1.2.3",
      channel: "stable",
      title: "1.2.3",
      notes: "Fixes.",
      provenance: { commit: "b".repeat(40), workflowRun: "https://x/1" },
      builds: [
        {
          id: "macos",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          buildNumber: "4022",
          minOS: "13.0",
          requires: { engine: "4.3" },
          artifacts: [
            {
              name: "Acme-1.2.3-macos.dmg",
              role: "payload",
              sha256: SHA,
              size: 10,
              contentType: "application/x-apple-diskimage",
            },
          ],
        },
        // A store-only build keeps `artifacts: []`; an absent buildNumber stays absent.
        {
          id: "ios",
          platform: "ios",
          arch: "arm64",
          format: "ipa",
          artifacts: [],
        },
      ],
    });
  });

  it("an optional field the descriptor omits stays absent", () => {
    const d = descriptor();
    delete d.tag;
    delete d.channel;
    delete d.title;
    delete d.notes;
    delete d.provenance;
    const r = descriptorToRecord(d, { seq: 1, issuedAt: 0 });
    for (const k of [
      "tag",
      "channel",
      "title",
      "notes",
      "provenance",
      "minSupportedSeq",
    ])
      expect(Object.hasOwn(r, k), k).toBe(false);
  });
});
