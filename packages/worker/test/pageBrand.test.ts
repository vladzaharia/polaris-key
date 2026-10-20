// LK-07 (plans/LK-00.md §7.12, A3 §14.2): the Worker's customer pages take the Polaris Locker
// identity while `customer.host` is on, and are today's bytes while it is off.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  BRAND_PAGE_CSS,
  BRAND_PAGE_CSS_LOCKER,
  brandPageStyleSource,
  lockerizeBrandPageHtml,
  renderBrandPage,
  type BrandPageOptions,
} from "../src/core/brandHtml.js";
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const NOW = 1_800_000_000;

describe("the Locker shell", () => {
  const samples: BrandPageOptions[] = [
    { title: "Sign in", heading: "Too many sign-in attempts" },
    {
      title: "Connect a device",
      heading: "Connect a device to Tidewater",
      surface: "device",
      eyebrow: "Tidewater",
      app: { name: "Tidewater <Studio>", iconUrl: "https://img.plrs.im/a.png" },
      body: '<p class="muted">Code $& $1</p>',
      variant: "tv",
    },
  ];

  it("a Key page rewritten equals the page rendered as Locker", () => {
    for (const opts of samples) {
      expect(lockerizeBrandPageHtml(renderBrandPage(opts))).toBe(
        renderBrandPage({ ...opts, brand: "locker" }),
      );
    }
  });

  it("is not a Key page: nothing to rewrite", () => {
    expect(lockerizeBrandPageHtml("<p>hi</p>")).toBeNull();
    expect(
      lockerizeBrandPageHtml(
        renderBrandPage({ ...samples[0]!, brand: "locker" }),
      ),
    ).toBeNull();
  });

  it("draws the Locker identity and none of the Key one", () => {
    const html = renderBrandPage({ ...samples[1]!, brand: "locker" });
    expect(html).toContain('<html lang="en" data-brand="locker">');
    expect(html).toContain("· Polaris Locker</title>");
    expect(html).toContain('href="/assets/branding/locker/favicon.svg"');
    expect(html).toContain('aria-label="Polaris Locker device"');
    expect(html).toContain("<title>Polaris Locker</title>");
    expect(html).not.toContain("Polaris Key");
    expect(html).not.toContain("Polaris&nbsp;Key");
    expect(html).toContain(`<style>${BRAND_PAGE_CSS_LOCKER}</style>`);
  });

  it("keeps the Key page exactly what it was", () => {
    const html = renderBrandPage(samples[0]!);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<style>${BRAND_PAGE_CSS}</style>`);
    expect(html).toContain("Polaris&nbsp;Key");
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

  it("the two stylesheets have two hashes", () => {
    expect(brandPageStyleSource("locker")).not.toBe(brandPageStyleSource());
  });
});

describe("the dispatcher", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(() => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), []);
    env.CONSOLE_ORIGIN = API;
    env.CUSTOMER_ORIGIN = CUSTOMER;
  });
  async function setMode(mode: string): Promise<void> {
    await db.run(
      "INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('CUSTOMER_HOST', ?, 1, ?, 'test')",
      JSON.stringify(mode),
      NOW,
    );
    invalidatePlatformSettings(env, db);
  }
  const get = (path: string) =>
    dispatchWith(new Request(`${API}${path}`), env, db, NOW);

  it("off: the Key page and its Key policy", async () => {
    const res = await get("/device");
    const html = await res.text();
    expect(html).toContain("Polaris&nbsp;Key");
    expect(html).not.toContain("data-brand");
    expect(res.headers.get("content-security-policy")).toContain(
      brandPageStyleSource(),
    );
  });

  it("on: the same page as Locker, with the Locker stylesheet's hash", async () => {
    const key = await (await get("/device")).text();
    await setMode("on");
    const res = await get("/device");
    const html = await res.text();
    expect(html).toBe(lockerizeBrandPageHtml(key));
    expect(html).toContain('data-brand="locker"');
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(brandPageStyleSource("locker"));
    expect(csp).not.toContain(brandPageStyleSource());
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("on: the console's own pages stay Polaris Key", async () => {
    await setMode("on");
    const res = await get("/manage/login");
    expect(res.headers.get("content-security-policy") ?? "").not.toContain(
      brandPageStyleSource("locker"),
    );
    expect(await res.text()).not.toContain("Polaris Locker");
  });
});
