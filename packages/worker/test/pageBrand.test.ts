// LK-07 (plans/LK-00.md §7.12, A3 §14.2; hard cutover): the Worker's customer pages are Polaris
// Locker; the console's own pages stay Polaris Key.
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../src/dispatch.js";
import {
  BRAND_PAGE_CSS,
  BRAND_PAGE_CSS_LOCKER,
  brandPageStyleSource,
  renderBrandPage,
} from "../src/core/brandHtml.js";
import { brandedHtmlSecurityHeaders } from "../src/core/securityHeaders.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

const NOW = 1_800_000_000;

describe("the shell", () => {
  const opts = {
    title: "Connect a device",
    heading: "Connect a device to Tidewater",
    surface: "device",
    app: { name: "Tidewater <Studio>", iconUrl: "https://img.plrs.im/a.png" },
  };

  it("is Polaris Locker by default", () => {
    const html = renderBrandPage(opts);
    expect(html).toContain('<html lang="en" data-brand="locker">');
    expect(html).toContain("· Polaris Locker</title>");
    expect(html).toContain('href="/assets/branding/locker/favicon.svg"');
    expect(html).toContain('aria-label="Polaris Locker"');
    expect(html).not.toContain("device</");
    expect(html).toContain("<title>Polaris Locker</title>");
    expect(html).not.toContain("Polaris Key");
    expect(html).not.toContain("Polaris&nbsp;Key");
    expect(html).toContain(`<style>${BRAND_PAGE_CSS_LOCKER}</style>`);
  });

  it("brand: key is the console's Pinned K page", () => {
    const html = renderBrandPage({ ...opts, brand: "key" });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("· Polaris Key</title>");
    expect(html).toContain("Polaris&nbsp;Key");
    expect(html).toContain(`<style>${BRAND_PAGE_CSS}</style>`);
    expect(html).not.toContain("Locker");
  });

  it("D9a: coral is identity only", () => {
    const tail = BRAND_PAGE_CSS_LOCKER.slice(BRAND_PAGE_CSS.length);
    // Actions, focus and link text are neutral ink; the coral is the lockup's and the underline's.
    expect(tail).toContain("--accent:#f6f8ff");
    expect(tail).toContain("--accent:#060912");
    expect(tail).toContain("--mb:#ff7869");
    expect(tail).toContain("text-decoration-color:var(--mb)");
    expect(tail).not.toMatch(/--(accent|focus|accent-fg):#(ff7869|c44438)/);
  });

  it("each identity's policy names its own stylesheet", () => {
    const locker = brandedHtmlSecurityHeaders().get("content-security-policy")!;
    const key = brandedHtmlSecurityHeaders(new Headers(), {
      brand: "key",
    }).get("content-security-policy")!;
    expect(locker).toContain(brandPageStyleSource("locker"));
    expect(key).toContain(brandPageStyleSource("key"));
    expect(brandPageStyleSource("locker")).not.toBe(
      brandPageStyleSource("key"),
    );
    expect(brandPageStyleSource()).toBe(brandPageStyleSource("locker"));
  });
});

describe("the dispatcher", () => {
  const get = (path: string) => {
    const env = makeEnv(new KvMock(), []);
    env.CONSOLE_ORIGIN = "https://key.plrs.im";
    return dispatchWith(
      new Request(`https://key.plrs.im${path}`),
      env,
      makeTestDb(),
      NOW,
    );
  };

  it("a customer page (device entry) is Polaris Locker under the Locker hash", async () => {
    const res = await get("/device");
    const html = await res.text();
    expect(html).toContain('data-brand="locker"');
    expect(html).not.toContain("Polaris Key");
    expect(res.headers.get("content-security-policy")).toContain(
      brandPageStyleSource("locker"),
    );
  });

  it("the console's own sign-in page stays Polaris Key under the Key hash", async () => {
    const res = await get("/manage/callback");
    const html = await res.text();
    expect(html).toContain("Polaris&nbsp;Key");
    expect(html).not.toContain("data-brand");
    expect(res.headers.get("content-security-policy")).toContain(
      brandPageStyleSource("key"),
    );
  });
});
