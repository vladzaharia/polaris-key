import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND, THEME_TOKENS } from "@polaris-key/brand";
import { makeTestDb } from "./helpers.js";
import { KvMock, asKv } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  BRAND_FONT_PATH,
  BRAND_PAGE_CSS,
  brandPageStyleSource,
  renderBrandPage,
} from "../src/core/brandHtml.js";
import {
  brandedHtmlSecurityHeaders,
  secureResponse,
} from "../src/securityHeaders.js";
import { handleAdminCallback } from "../src/admin/auth.js";
import { handleMagicVerify } from "../src/services/identity/portal/auth.js";
import {
  deviceFlowKey,
  handleAuthDeviceEntry,
  handleAuthDeviceVerify,
} from "../src/services/identity/oidc.js";
import {
  emailAssetOrigin,
  renderEmail,
  sendMagicLink,
  sendNotice,
} from "../src/services/identity/portal/email.js";
import { licenseAddedNotice } from "../src/services/identity/portal/notices.js";
import type { Env } from "../src/env.js";
import { artefacts } from "./singleUseMock.js";

/**
 * The Worker's branded pages and email (docs/design/BRAND.md): every server-rendered page on the
 * console host is the one shell (`core/brandHtml.ts`) under a policy that allows exactly its
 * stylesheet (by hash) and the brand font, with no inline style or script anywhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://key.plrs.im";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/** The checks every branded page must pass, as served (after the dispatcher's backstop). */
async function expectBrandedPage(res: Response): Promise<string> {
  const served = secureResponse(res);
  const csp = served.headers.get("content-security-policy")!;
  const html = await served.text();
  expect(served.headers.get("content-type")).toContain("text/html");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("font-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toMatch(/script-src|connect-src/);
  // One stylesheet, allowed by its hash; no style attribute, no script, no handler.
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(styles).toHaveLength(1);
  expect(csp).toContain(`'sha256-${sha256(styles[0]![1]!)}'`);
  expect(html).not.toMatch(/\sstyle=|<script|\son\w+=/i);
  // The console Logo's brand block: the Pinned K at 48 px (display cut) beside the wordmark text,
  // without the gold bit, and no lockup drawn at twice the console's size.
  expect(html).toMatch(
    /<div class="brand" role="img" aria-label="Polaris Key[^"]*">/,
  );
  expect(html).toContain(
    '<svg class="mark" xmlns="http://www.w3.org/2000/svg" width="48" height="48"',
  );
  expect(html).toContain(
    '<span class="wordmark" aria-hidden="true">Polaris&nbsp;Key',
  );
  expect(html).not.toContain('class="lockup"');
  expect(html.replace(styles[0]![0], "")).not.toContain("{");
  expect(html.toLowerCase()).not.toContain(BRAND.gold.dark.toLowerCase());
  expect(html.toLowerCase()).not.toContain(BRAND.gold.light.toLowerCase());
  return html;
}

describe("the branded page shell", () => {
  it("allows its stylesheet by hash and nothing else inline", () => {
    const csp = brandedHtmlSecurityHeaders().get("content-security-policy")!;
    expect(brandPageStyleSource()).toBe(`'sha256-${sha256(BRAND_PAGE_CSS)}'`);
    expect(csp).toBe(
      [
        "default-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        `style-src ${brandPageStyleSource()}`,
        "font-src 'self'",
      ].join("; "),
    );
  });

  it("themes from the brand tokens, dark first with light by media query", () => {
    expect(BRAND_PAGE_CSS).toContain(THEME_TOKENS.dark.surface.page);
    expect(BRAND_PAGE_CSS).toContain(
      `@media (prefers-color-scheme: light){:root{color-scheme:light;--page:${THEME_TOKENS.light.surface.page}`,
    );
    expect(BRAND_PAGE_CSS).toContain(THEME_TOKENS.dark.accent.violet.solid);
  });

  it("shares the console sign-in look: the Logo's brand block over one card, its md button", () => {
    expect(BRAND_PAGE_CSS).toContain(
      ".brand{display:flex;justify-content:center;align-items:center;gap:.75rem",
    );
    // The surface label is the Logo subtitle: small, regular weight, uppercase, muted.
    expect(BRAND_PAGE_CSS).toMatch(
      /\.surface\{color:var\(--muted\);font-size:\.75rem;[^}]*font-weight:400;[^}]*text-transform:uppercase/,
    );
    expect(BRAND_PAGE_CSS).toMatch(
      /\.wordmark\{[^}]*font-size:1rem;[^}]*font-weight:700/,
    );
    // The console's md Button: 36 px tall, 14 px, regular weight, full width.
    const button = /\.button\{([^}]*)\}/.exec(BRAND_PAGE_CSS)![1]!;
    expect(button).toContain("display:flex;width:100%");
    expect(button).toContain("min-height:2.25rem");
    expect(button).toContain("font-size:.875rem");
    expect(button).toContain("font-weight:400");
  });

  it("labels the surface beside the wordmark", () => {
    const html = renderBrandPage({
      title: "t",
      heading: "h",
      surface: "console",
    });
    expect(html).toContain(
      '<div class="brand" role="img" aria-label="Polaris Key console">',
    );
    expect(html).toContain(
      'Polaris&nbsp;Key<span class="surface">console</span></span>',
    );
    expect(renderBrandPage({ title: "t", heading: "h" })).not.toContain(
      'class="surface"',
    );
  });

  it("loads Rubik and JetBrains Mono only from files the admin build emits at the stable path", () => {
    const fonts = [...BRAND_PAGE_CSS.matchAll(/url\("([^"]+)"\)/g)].map(
      (m) => m[1]!,
    );
    expect(fonts).toEqual([
      `${BRAND_FONT_PATH}/rubik-var-latin.woff2`,
      `${BRAND_FONT_PATH}/jetbrains-mono-var-latin.woff2`,
    ]);
    const vite = readFileSync(
      join(here, "..", "..", "admin", "vite.config.ts"),
      "utf8",
    );
    expect(vite).toContain(
      `const BRAND_FONT_DIR = "${BRAND_FONT_PATH.slice(1)}"`,
    );
    const emitted = Array.from(
      (
        vite.match(/BRAND_FONT_FILES[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
      ).matchAll(/"([^"]+)"/g),
      (m) => m[1]!,
    );
    for (const url of fonts) {
      const name = url.slice(BRAND_FONT_PATH.length + 1);
      expect(emitted).toContain(name);
      expect(
        existsSync(join(here, "..", "..", "brand", "fonts", name)),
        name,
      ).toBe(true);
    }
  });

  it("escapes every value it is given", () => {
    const html = renderBrandPage({
      title: "<t>",
      heading: '"><script>alert(1)</script>',
      eyebrow: "<e>",
      surface: "<s>",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain('<span class="surface">&lt;s&gt;</span>');
    expect(html).toContain("&lt;t&gt; · Polaris Key");
    expect(html).toContain("&lt;e&gt;");
  });
});

describe("every server-rendered page on the console host uses the shell", () => {
  it("the admin sign-in error", async () => {
    const env = makeEnv(new KvMock(), []);
    env.PLATFORM_OIDC_ISSUER = "https://id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "polaris-admin";
    const res = await handleAdminCallback(
      new Request(`${ORIGIN}/manage/callback`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }) as unknown as Request,
      env,
      makeTestDb(),
      1_800_000_000,
    );
    expect(res.status).toBe(400);
    const html = await expectBrandedPage(res);
    expect(html).toContain("Missing authorization code.");
    expect(html).toContain('<span class="surface">console</span>');
    expect(html).not.toContain('class="eyebrow"');
    expect(html).toContain('href="/manage/login"');
  });

  it("the portal sign-in error", async () => {
    const res = await handleMagicVerify(
      new Request(`${ORIGIN}/magic/verify`) as unknown as Request,
      makeEnv(new KvMock(), []),
      makeTestDb(),
      1_800_000_000,
    );
    expect(res.status).toBe(400);
    const html = await expectBrandedPage(res);
    expect(html).toContain("Missing magic-link token.");
    expect(html).toContain('<span class="surface">account</span>');
  });

  it("the device code entry page", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const page = await handleAuthDeviceEntry(
      new Request(`${ORIGIN}/djdl/identity/auth/device`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }) as unknown as Request,
      env,
      product,
    );
    expect(page.status).toBe(200);
    const html = await expectBrandedPage(page);
    expect(html).toContain('<input id="user_code" name="user_code"');
    expect(html).toContain('<span class="surface">device</span>');
  });

  it("the device confirmation page keeps its IdP form target", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    env.HOT = asKv(kv);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    await artefacts(env).put(
      await deviceFlowKey(env, "djdl", "dc"),
      JSON.stringify({
        state: "s",
        deviceId: "d",
        userCode: "ABCD-EFGH",
        deviceName: "Ada's Mac",
        authorizeUrl: "https://id.example/authorize",
      }),
    );
    const page = await handleAuthDeviceVerify(
      new Request(
        `${ORIGIN}/djdl/auth/device/verify?device_code=dc`,
      ) as unknown as Request,
      env,
      product,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://id.example",
    );
    const html = await expectBrandedPage(page);
    expect(html).toContain('<dd class="code">ABCD-EFGH</dd>');
    expect(html).toContain("Continue to sign in");
  });
});

describe("the portal email", () => {
  function capture(env: Env) {
    const sent: { text: string; html: string; subject: string }[] = [];
    env.EMAIL = {
      send: async (m: { text: string; html: string; subject: string }) => {
        sent.push(m);
      },
    } as unknown as Env["EMAIL"];
    return sent;
  }

  it("the magic link: branded HTML beside the plain-text part", async () => {
    const env = makeEnv(new KvMock(), []);
    const sent = capture(env);
    const link = `${ORIGIN}/magic/verify?token=magic_abc&return_to=%2F`;
    expect(
      await sendMagicLink(env, makeTestDb(), "ada@example.com", link, NOW),
    ).toBe(true);
    const { text, html } = sent[0]!;
    // The plain-text part keeps the link as its first URL.
    expect(/https:\/\/\S+/.exec(text)?.[0]).toBe(link);
    expect(text).toContain("expires in 10 minutes");
    // Table layout, both schemes declared, the dark palette for clients that honour it.
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(THEME_TOKENS.light.accent.violet.solid);
    expect(html).toContain(THEME_TOKENS.dark.surface.page);
    // The link, escaped, in the button and as copyable text; the kit lockup from the link's origin.
    const escaped = link.replace(/&/g, "&amp;");
    expect(html.split(`href="${escaped}"`)).toHaveLength(3);
    expect(html).toContain(
      `<img class="pk-logo-light" src="${ORIGIN}/assets/branding/key/key-horizontal-light-944.png" width="472" height="160" alt="Polaris Key"`,
    );
    expect(html).toContain(
      `<img class="pk-logo-dark" src="${ORIGIN}/assets/branding/key/key-horizontal-dark-944.png" width="472" height="160" alt="Polaris Key"`,
    );
    expect(html).toContain(".pk-logo-dark{display:block !important");
    expect(html).not.toMatch(/app-icon|powered by/i);
    expect(html).not.toMatch(/<script|\son\w+=/i);
  });

  it("a notice: a text wordmark, no lockup, without a usable console origin", async () => {
    const env = makeEnv(new KvMock(), []);
    env.CONSOLE_ORIGIN = undefined;
    const sent = capture(env);
    const message = licenseAddedNotice({
      productName: "Mossgarden",
      productSlug: "mossgarden",
      origin: "http://key.plrs.im",
    });
    await sendNotice(env, makeTestDb(), "ada@example.com", message, NOW);
    expect(sent[0]!.text).toBe(message.text);
    expect(sent[0]!.html).not.toContain("<img");
    expect(sent[0]!.html).toContain(">Polaris Key</p>");
  });

  it("loads the lockup only over https (or http on loopback)", () => {
    expect(emailAssetOrigin("http://key.plrs.im/x")).toBeNull();
    expect(emailAssetOrigin("javascript:alert(1)")).toBeNull();
    expect(emailAssetOrigin(undefined, "https://key.plrs.im/")).toBe(ORIGIN);
    expect(emailAssetOrigin("http://localhost:8787/a")).toBe(
      "http://localhost:8787",
    );
    expect(
      renderEmail({
        subject: "s",
        heading: "h",
        paragraphs: [],
        footer: "f",
        origin: null,
      }),
    ).not.toContain("<img");
  });
});
