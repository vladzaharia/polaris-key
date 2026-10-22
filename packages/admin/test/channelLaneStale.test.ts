import { describe, expect, it } from "vitest";
import type { ChannelPolicyDto } from "../src/api.js";
import { olderThanFallback } from "../src/console/sections/release/components/ChannelLanes.js";

const rel = (
  releaseId: string,
  version: string,
  channel: string,
  publishedAt: number,
) => ({ releaseId, version, channel, publishedAt, seq: 1, yanked: false });
const lane = (channel: string, resolved: string | null): ChannelPolicyDto => ({
  deliverable: "app",
  channel,
  pointer: null,
  pinned: false,
  includes: null,
  minSupported: null,
  critical: false,
  source: "manifest",
  modifiedAt: null,
  modifiedBy: null,
  resolved,
  byPlatform: {},
});

describe("olderThanFallback", () => {
  const channels = [lane("stable", "s"), lane("beta", "s")];
  it("names the track beta falls back to when its newest build is older", () => {
    const releases = [
      rel("s", "1.7.3", "stable", 200),
      rel("b", "1.7.0-beta.4", "beta", 100),
    ];
    expect(olderThanFallback(channels[1]!, { releases, channels })).toEqual({
      channel: "stable",
      version: "1.7.3",
    });
  });
  it("says nothing when the lane is the newer one or has no build", () => {
    const newer = [
      rel("s", "1.7.3", "stable", 100),
      rel("b", "1.8.0-beta.1", "beta", 200),
    ];
    expect(
      olderThanFallback(channels[1]!, { releases: newer, channels }),
    ).toBeNull();
    expect(
      olderThanFallback(channels[1]!, { releases: [], channels }),
    ).toBeNull();
    expect(
      olderThanFallback(channels[0]!, { releases: newer, channels }),
    ).toBeNull();
  });
});
