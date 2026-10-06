/**
 * A-18j — decision 6 in Google Play's flow runtime: Polaris Key never deletes Play images, so an
 * image upload that leaves older images behind answers a `followUp` that counts them and names the
 * Console page where the operator removes them (`google-play.main-store-listing`). Both the image
 * step and "Push listing" carry it; an upload that leaves nothing behind carries none.
 *
 * A-18e's connector (the edit session and its writes) is stubbed here: its own behaviour is pinned
 * by `playStorefront.test.ts`. This file pins only what the runtime does with its results.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const play = vi.hoisted(() => ({
  oldImagesPerUpload: 0,
  uploads: [] as { language: string; imageType: string }[],
  commits: [] as { stageOnly?: boolean }[],
}));

vi.mock(
  "../src/services/distribution/connectors/play/storefront.js",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("../src/services/distribution/connectors/play/storefront.js")
      >();
    const written = (opId: string) => ({
      outcome: "written" as const,
      opId,
      resultIds: { [opId]: opId },
      before: null,
      after: null,
    });
    return {
      ...real,
      withPlayEditSession: async (
        _ctx: unknown,
        _purpose: unknown,
        fn: (s: unknown) => Promise<unknown>,
      ) => fn({ touched: { production: false } }),
      playImageFromListingAsset: async () => ({ size: 1 }),
      playUploadImage: async (
        _s: unknown,
        input: { language: string; imageType: string },
      ) => {
        play.uploads.push({
          language: input.language,
          imageType: input.imageType,
        });
        return {
          result: written(`img-${play.uploads.length}`),
          oldImages: play.oldImagesPerUpload,
          removeOldAt:
            play.oldImagesPerUpload > 0
              ? "google-play.main-store-listing"
              : null,
        };
      },
      playCommit: async (_s: unknown, input: { stageOnly?: boolean }) => {
        play.commits.push({ stageOnly: input.stageOnly });
        return written("commit");
      },
    };
  },
);

vi.mock(
  "../src/services/distribution/storefronts/slots.js",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("../src/services/distribution/storefronts/slots.js")
      >();
    return {
      ...real,
      acceptedAssets: async () => [
        { slot: "play:icon", locale: "" },
        { slot: "play:feature-graphic", locale: "" },
      ],
    };
  },
);

vi.mock(
  "../src/services/distribution/storefronts/outcome.js",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("../src/services/distribution/storefronts/outcome.js")
      >();
    // The listing fits with nothing to write: a push's text part sends no request.
    return {
      ...real,
      projectionFor: async () => ({
        store: "play",
        issues: [],
        payload: { app: {}, locales: {} },
      }),
    };
  },
);

import { GOOGLE_PLAY_FLOW } from "../src/services/distribution/storefronts/googlePlay.js";
import type { FlowContext } from "../src/services/distribution/storefronts/runtime.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, seedProduct } from "./seed.js";
import { envFor } from "./releaseRoutesFixture.js";

let c: FlowContext;
const KEY = "11111111-2222-3333-4444-888888888888";

beforeEach(async () => {
  const db = makeTestDb();
  await seedProduct(db, "acme");
  c = {
    env: envFor({ kv: new KvMock() }),
    db,
    product: "acme",
    productName: "Acme",
    hooks: {} as FlowContext["hooks"],
    session: {} as FlowContext["session"],
    now: NOW,
  };
  play.oldImagesPerUpload = 0;
  play.uploads.length = 0;
  play.commits.length = 0;
});

describe("Google Play's older images (decision 6)", () => {
  it("the image step counts the older images Play still holds and names the page to remove them", async () => {
    play.oldImagesPerUpload = 2;
    const r = await GOOGLE_PLAY_FLOW.runStep!(
      c,
      "writeListingAssets",
      {},
      {
        idempotencyKey: KEY,
        typedConfirmation: false,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(play.uploads).toHaveLength(2);
    expect(play.commits).toEqual([{ stageOnly: true }]);
    expect(r.followUp).toEqual({
      link: "google-play.main-store-listing",
      count: 4,
      text: expect.stringContaining("4 older images"),
    });
  });

  it("a listing push carries the same follow-up, staged", async () => {
    play.oldImagesPerUpload = 1;
    const r = await GOOGLE_PLAY_FLOW.pushListing!.run(c, {
      idempotencyKey: KEY,
      stageOnly: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(play.commits).toEqual([{ stageOnly: true }]);
    expect(r.followUp).toMatchObject({
      link: "google-play.main-store-listing",
      count: 2,
    });
    expect(r.followUp!.text).toContain("2 older images");
  });

  it("an upload that leaves no older image behind carries no follow-up", async () => {
    const r = await GOOGLE_PLAY_FLOW.runStep!(
      c,
      "writeListingAssets",
      {},
      {
        idempotencyKey: KEY,
        typedConfirmation: false,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.followUp).toBeUndefined();
  });
});
