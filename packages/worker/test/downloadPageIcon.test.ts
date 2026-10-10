/**
 * HA-07 — the public download page shows the product's hosted icon (notes/S-20 §6.8): an
 * image-host URL in the header, the page's policy naming exactly the image host in `img-src`, and
 * the bytes host's document rule (`inertDocumentPolicy`) admitting exactly that origin. Without a
 * copy, with hosting off or with no image host, the page is what it was. `download.json` never
 * changes: the icon is resolved per request, beside the cached model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { seedHosted, setAssetHosting } from "./hostedFixture.js";
import { SLUG, model, onBytes, setup } from "./downloadWorld.js";
import { inertDocumentPolicy } from "../src/core/assets/bytesHost.js";
import {
  PAGE_ICON_WIDTH,
  pageCsp,
} from "../src/services/distribution/page/index.js";

const IMG = "https://img.example.test";
const A = "a".repeat(64);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the document rule admits exactly the image host as an image source", () => {
  const base =
    "default-src 'none'; style-src 'sha256-" +
    "A".repeat(43) +
    "='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-downloads";

  it("img-src may name data:, the image host, or both", () => {
    const opts = { imgOrigin: IMG };
    for (const img of [
      `img-src ${IMG}`,
      `img-src data: ${IMG}`,
      "img-src data:",
    ])
      expect(inertDocumentPolicy(`${base}; ${img}`, opts), img).toBe(true);
  });

  it("never any other source, a repeated one, or the image host when none is configured", () => {
    expect(inertDocumentPolicy(`${base}; img-src ${IMG}`)).toBe(false);
    for (const img of [
      "img-src https://evil.example.test",
      `img-src ${IMG}/a`,
      `img-src ${IMG} ${IMG}`,
      `img-src ${IMG} *`,
      "img-src 'self'",
      "img-src",
    ])
      expect(
        inertDocumentPolicy(`${base}; ${img}`, { imgOrigin: IMG }),
        img,
      ).toBe(false);
    // A configured origin that is not a bare https origin admits nothing more.
    expect(
      inertDocumentPolicy(`${base}; img-src http://img.example.test`, {
        imgOrigin: "http://img.example.test",
      }),
    ).toBe(false);
  });

  it("the page's policy names the image host only when given one", async () => {
    expect(await pageCsp()).not.toContain("img-src");
    const csp = await pageCsp(IMG);
    expect(csp).toContain(`img-src ${IMG}`);
    expect(inertDocumentPolicy(csp, { imgOrigin: IMG })).toBe(true);
    expect(inertDocumentPolicy(csp)).toBe(false);
  });
});

describe("the page shows the hosted icon", () => {
  async function hostedWorld() {
    const w = await setup();
    w.env.IMG_ORIGIN = IMG;
    return w;
  }

  it("in the header, at the width it draws, under a policy that names the image host", async () => {
    const w = await hostedWorld();
    const before = JSON.stringify(await model(w));
    await seedHosted(w.db, SLUG, "presentation.icon", {
      sha256: A,
      widths: [64, 128, 256],
    });
    const res = await onBytes(w, `/${SLUG}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await pageCsp(IMG));
    const html = await res.text();
    expect(html).toContain(
      `<img class="icon" src="${IMG}/${SLUG}/a/${A}/${PAGE_ICON_WIDTH}.webp" alt="" width="64" height="64" decoding="async">`,
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    // The model is unchanged: no field, so the recorded transcripts stay as they are.
    expect(JSON.stringify(await model(w))).toBe(before);
  });

  it("no copy: no icon and the policy it always had", async () => {
    const w = await hostedWorld();
    const res = await onBytes(w, `/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(await pageCsp());
    expect(await res.text()).not.toContain("<img");
  });

  for (const [label, off] of [
    [
      "the kill switch off (HA-10's assets.hosting.enabled)",
      (w: Awaited<ReturnType<typeof setup>>) =>
        setAssetHosting(w.env, w.db, "off"),
    ],
    ["no image host", null],
  ] as const)
    it(`rollback, ${label}: the page as before HA-07`, async () => {
      const w = await setup();
      if (off) {
        w.env.IMG_ORIGIN = IMG;
        await off(w);
      }
      await seedHosted(w.db, SLUG, "presentation.icon", { sha256: A });
      const res = await onBytes(w, `/${SLUG}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(await pageCsp());
      expect(await res.text()).not.toContain("<img");
    });
});
