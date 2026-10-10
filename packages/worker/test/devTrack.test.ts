/**
 * P2-08 — `dev` is a built-in release track beside `stable` and `beta`: the selector classifies,
 * the include chain is dev ⊇ beta ⊇ stable unless the product declares otherwise, the signed feed
 * answers for it, the editors store `beta` with `dev`, and the stale-track helper only calls a
 * track out when it is behind the track it falls back to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_CHANNELS } from "@polaris-key/manifest";
import { installDigestStream } from "./r2Mock.js";
import { NOW } from "./seed.js";
import { feedWorld, getFeed, publish, type FeedWorld } from "./feedWorld.js";
import { SLUG } from "./releaseRoutesFixture.js";
import {
  classifyChannel,
  resolveChannel,
} from "../src/services/release/channels.js";
import {
  channelClosure,
  defaultIncludes,
} from "../src/services/release/resolve.js";
import { stmtSetChannelPolicy } from "../src/services/release/model.js";
import { policyChannelOf } from "../src/services/release/gateway.js";
import { withIncludedChannels } from "../src/core/channels.js";
import { channelEntitled } from "../src/core/channels.js";
import { parseChannels } from "../src/services/license/admin/licenses.js";
import {
  buildsAhead,
  trackFallbackState,
} from "../src/services/release/trackState.js";

installDigestStream();

describe("the dev selector", () => {
  it("dev is a built-in channel and classifies as its own kind", () => {
    expect(BUILT_IN_CHANNELS).toEqual(["stable", "beta", "dev"]);
    expect(classifyChannel("dev")).toEqual({ kind: "dev", raw: "dev" });
    expect(policyChannelOf(classifyChannel("dev")!)).toBe("dev");
  });

  it("a manual channel named dev keeps priority", () => {
    const manual = [{ name: "dev", regex: "^v.*-dev$" }];
    expect(classifyChannel("dev", manual)).toMatchObject({
      kind: "manual",
      raw: "dev",
    });
    // Negative control: without the rule it is the built-in kind.
    expect(classifyChannel("dev", [])!.kind).toBe("dev");
  });

  it("the legacy GitHub resolver has no rule for dev", () => {
    expect(resolveChannel(classifyChannel("dev")!, [])).toBeNull();
  });
});

describe("the include chain", () => {
  it("defaults to dev ⊇ beta ⊇ stable", () => {
    expect(defaultIncludes("dev")).toEqual(["beta"]);
    expect(defaultIncludes("beta")).toEqual(["stable"]);
    expect(defaultIncludes("stable")).toEqual([]);
    expect(defaultIncludes("nightly")).toEqual([]);
    expect([...channelClosure("dev", new Map())].sort()).toEqual([
      "beta",
      "dev",
      "stable",
    ]);
  });

  it("a declared dev wins, including an empty includes", () => {
    const view = (includes: string[]) =>
      new Map([["dev", { includes } as never]]);
    expect([...channelClosure("dev", view([]))]).toEqual(["dev"]);
    expect([...channelClosure("dev", view(["stable"]))].sort()).toEqual([
      "dev",
      "stable",
    ]);
  });
});

describe("GET /update/dev/feed.jws", () => {
  let w: FeedWorld;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    w = await feedWorld();
  });
  afterEach(() => vi.useRealTimers());

  const macVersion = async () =>
    (await getFeed(w, "dev")).payload!.app.targets.find(
      (t: { platform: string }) => t.platform === "macos",
    ).release.version;

  it("signs channel dev for an undeclared dev, and serves the chain's builds", async () => {
    await publish(w, "1.3.0");
    await publish(w, "1.2.0-dev.1", { channel: "dev" });
    const { res, payload } = await getFeed(w, "dev");
    expect(res.status).toBe(200);
    expect(payload!.channel).toBe("dev");
    // The undeclared dev includes beta and stable, so the newer stable build is offered.
    expect(await macVersion()).toBe("1.3.0");
  });

  it("includes: [] on a declared dev restores dev-only builds", async () => {
    await publish(w, "1.3.0");
    await publish(w, "1.2.0-dev.1", { channel: "dev" });
    const s = stmtSetChannelPolicy(
      { product: SLUG, deliverableId: "app", channel: "dev" },
      { includes: [] } as never,
      { source: "admin", by: "u1", now: w.now },
    );
    await w.db.run(s.sql, ...s.params);
    expect(await macVersion()).toBe("1.2.0-dev.1");
  });
});

describe("what an editor stores", () => {
  it("choosing dev stores beta with it, once, in order", () => {
    expect(withIncludedChannels(["dev"])).toEqual(["beta", "dev"]);
    expect(withIncludedChannels(["beta", "dev"])).toEqual(["beta", "dev"]);
    expect(withIncludedChannels(["dev", "beta"])).toEqual(["dev", "beta"]);
    expect(withIncludedChannels(["qa", "dev"])).toEqual(["qa", "beta", "dev"]);
    // Negative control: nothing else is widened.
    expect(withIncludedChannels(["beta"])).toEqual(["beta"]);
    expect(withIncludedChannels([])).toEqual([]);
  });

  it("the licence and tier write path stores it; the wire predicate never infers it", () => {
    expect(JSON.parse(parseChannels(["dev"])!)).toEqual(["beta", "dev"]);
    expect(JSON.parse(parseChannels(["beta"])!)).toEqual(["beta"]);
    // A grant stored as ["dev"] is matched as stored: dev, not beta.
    expect(channelEntitled(["dev"], "dev")).toBe(true);
    expect(channelEntitled(["dev"], "beta")).toBe(false);
  });
});

describe("trackFallbackState", () => {
  it("is behind only when the track's newest is older than its fallback's", () => {
    expect(trackFallbackState("1.7.0-beta.4", "1.7.3")).toBe("behind");
    expect(trackFallbackState("1.8.0-beta.1", "1.7.3")).toBe("current");
    expect(trackFallbackState("1.7.3", "1.7.3")).toBe("current");
  });

  it("an empty track, or one with no fallback build, is not behind", () => {
    expect(trackFallbackState(null, "1.7.3")).toBe("empty");
    expect(trackFallbackState("1.7.0", null)).toBe("current");
  });

  it("age is not a rule: a track that has not moved is current", () => {
    // Only versions are compared; the helper takes no date, so a long-quiet track whose newest
    // build is the fallback's or newer is never called out.
    expect(trackFallbackState("1.9.0-dev.3", "1.7.3")).toBe("current");
  });

  it("counts the builds newer than the source track's current", () => {
    const dev = Array.from({ length: 14 }, (_, i) => `1.9.0-dev.${i + 1}`);
    expect(buildsAhead(dev, "1.9.0-dev.3")).toBe(11);
    expect(buildsAhead(dev, "1.9.0-dev.14")).toBe(0);
  });
});
