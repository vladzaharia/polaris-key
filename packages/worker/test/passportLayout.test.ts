// PX-33: the product passport on the Worker's hosted sign-in pages (SIGN-IN.md "the product
// passport"). The layout switch is CSS (landscape = at least 60 rem wide AND width:height >= 1.2),
// so these tests pin the markup and the stylesheet rules; the browser run is the portal e2e.
import { describe, expect, it } from "vitest";
import {
  BRAND_PAGE_CSS_LOCKER,
  renderAuthCard,
} from "../src/core/brandHtml.js";
import { pageApp } from "../src/core/brandPage.js";

const IMG = "https://img.plrs.im";
const facts = {
  name: "DJDL",
  iconUrl: `${IMG}/djdl/a/aa/128.webp`,
  developer: "Example Audio",
  device: "Studio Mac mini",
  action: "wants you to sign in",
};

function page(passport?: Parameters<typeof renderAuthCard>[0]["passport"]) {
  return renderAuthCard({
    title: "Sign in",
    heading: "Sign in",
    body: "<p>x</p>",
    footer: { icon: "lock", text: "Polaris Locker signs you in." },
    ...(passport ? { passport } : {}),
  });
}

describe("the hosted passport markup", () => {
  it("is a pane with the icon, name, developer and device, and art when there is some", () => {
    const html = page({ ...facts, artUrl: `${IMG}/djdl/a/bb/640.webp` });
    expect(html).toContain('<main class="ac ac-wide">');
    expect(html).toContain(
      `<img class="ac-art" src="${IMG}/djdl/a/bb/640.webp" alt="" loading="lazy">`,
    );
    expect(html).toContain(
      "<strong><bdi>DJDL</bdi></strong> wants you to sign in",
    );
    expect(html).toContain("Example Audio");
    expect(html).toContain("on <bdi>Studio Mac mini</bdi>");
    // The art comes first in the pane, then the icon (each fact once, art above the icon).
    expect(html.indexOf('<img class="ac-art"')).toBeLessThan(
      html.lastIndexOf(`src="${facts.iconUrl}"`),
    );
  });

  it("draws no art element and no generated fill without art", () => {
    const html = page(facts);
    expect(html).toContain('<aside class="ac-passport ac-noart">');
    expect(html).not.toContain('<img class="ac-art"');
    expect(BRAND_PAGE_CSS_LOCKER).not.toMatch(/linear-gradient/);
  });

  it("centres the icon large in the pane when there is no art, so the pane has no void (N4)", () => {
    const rule = BRAND_PAGE_CSS_LOCKER.slice(
      BRAND_PAGE_CSS_LOCKER.indexOf(".ac-passport.ac-noart{"),
    );
    expect(rule).toContain(
      ".ac-passport.ac-noart{justify-content:center;align-items:center;text-align:center}",
    );
    expect(rule).toContain("width:96px;height:96px");
    // With art, the pane keeps its art-first layout.
    expect(page({ ...facts, artUrl: `${IMG}/djdl/a/bb/640.webp` })).toContain(
      '<aside class="ac-passport">',
    );
  });

  it("is absent on a page with no app request", () => {
    const html = page();
    expect(html).toContain('<main class="ac">');
    expect(html).not.toContain("<aside");
    expect(html).not.toContain('class="ac ac-wide"');
  });

  it("never draws the art in an inline style, a script or an event handler", () => {
    const html = page({ ...facts, artUrl: `${IMG}/djdl/a/bb/640.webp` });
    expect(html).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
  });
});

describe("the hosted passport stylesheet", () => {
  const rule = BRAND_PAGE_CSS_LOCKER.slice(
    BRAND_PAGE_CSS_LOCKER.indexOf("main.ac-wide{max-width"),
  );
  const query = BRAND_PAGE_CSS_LOCKER.slice(
    BRAND_PAGE_CSS_LOCKER.lastIndexOf(
      "@media",
      BRAND_PAGE_CSS_LOCKER.indexOf("main.ac-wide{max-width"),
    ),
    BRAND_PAGE_CSS_LOCKER.indexOf(
      "{",
      BRAND_PAGE_CSS_LOCKER.lastIndexOf(
        "@media",
        BRAND_PAGE_CSS_LOCKER.indexOf("main.ac-wide{max-width"),
      ),
    ),
  );

  it("switches on width >= 60 rem, width:height >= 1.2 and room for 46 rem, nothing else", () => {
    expect(query).toBe("@media (min-width: 60rem) and (min-aspect-ratio: 6/5)");
    // Rem in a container query follows the root font size: 200 % text stacks the strip.
    expect(BRAND_PAGE_CSS_LOCKER).toContain(
      "@container (min-width: 46rem){main.ac-wide{",
    );
    expect(BRAND_PAGE_CSS_LOCKER).toContain("body{container-type:inline-size}");
  });

  it("makes a 17.5 rem neutral start pane, a 46 rem card and a 56 px icon (radius 14)", () => {
    expect(rule).toContain("max-width:46rem");
    expect(rule).toContain("minmax(0,17.5rem) minmax(0,1fr)");
    expect(rule).toContain("background:var(--sunken)");
    expect(rule).toContain("width:56px;height:56px;border-radius:14px");
    expect(rule).toContain("aspect-ratio:16/10");
    expect(rule).toContain("max-height:40%");
    expect(rule).toContain("object-fit:cover");
  });

  it("anchors the receipt at the pane's foot, keeps the device line with the pane text, and handles forced colours", () => {
    expect(rule).toContain("main.ac-wide .ac-foot{grid-column:1;grid-row:2;");
    // Minor 14: "on <device>" sits under the name and developer, not pushed to the foot.
    expect(rule).toContain(".ac-pass-where{margin-top:.25rem;");
    expect(rule).not.toContain("ac-pass-where{margin-top:auto");
    expect(rule).toContain(".ac-art+img,.ac-art+.ac-mono{margin-top:-1.75rem");
    expect(BRAND_PAGE_CSS_LOCKER).toContain(
      "@media (forced-colors: active){main.ac-wide .ac-passport",
    );
  });
});

describe("pageApp with art", () => {
  it("keeps icon and art on the one image origin and drops art elsewhere", () => {
    const shown = pageApp({
      name: "A",
      iconUrl: `${IMG}/a/1.webp`,
      artUrl: `${IMG}/a/2.webp`,
    });
    expect(shown.imgOrigin).toBe(IMG);
    expect(shown.app.artUrl).toBe(`${IMG}/a/2.webp`);
    const other = pageApp({
      name: "A",
      iconUrl: `${IMG}/a/1.webp`,
      artUrl: "https://evil.example/x.webp",
    });
    expect(other.app.artUrl).toBeUndefined();
    expect(other.imgOrigin).toBe(IMG);
  });

  it("allows art alone, and drops everything the policy cannot name", () => {
    expect(pageApp({ name: "A", artUrl: `${IMG}/x.webp` }).imgOrigin).toBe(IMG);
    const none = pageApp({
      name: "A",
      iconUrl: "not a url",
      artUrl: "javascript:x",
    });
    expect(none).toEqual({ app: { name: "A" }, imgOrigin: null });
  });
});
