/**
 * The slug manifest the build writes (dist/docs-slugs.json): routes for the console's link gate,
 * and per page the frontmatter and heading anchors. Skips when the docs have not been built.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REDIRECT_SCRIPT,
  isRedirectPage,
  redirectTarget,
} from "../scripts/redirect-fragments.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const manifestFile = join(dist, "docs-slugs.json");

describe("redirect pages", () => {
  const page =
    '<!doctype html><title>Redirecting to: /docs/a/</title><meta http-equiv="refresh" content="0;url=/docs/a/"><meta name="robots" content="noindex">';

  it("are recognized and give their target", () => {
    expect(isRedirectPage(page)).toBe(true);
    expect(redirectTarget(page)).toBe("/docs/a/");
    expect(isRedirectPage("<!doctype html><html><title>X</title>")).toBe(false);
  });

  it("keep one constant script, so one CSP hash covers every redirect", () => {
    expect(REDIRECT_SCRIPT).toContain("location.hash");
    expect(REDIRECT_SCRIPT).not.toContain("\n");
  });
});

describe.skipIf(!existsSync(manifestFile))("dist/docs-slugs.json", () => {
  const manifest = existsSync(manifestFile)
    ? (JSON.parse(readFileSync(manifestFile, "utf8")) as {
        routes: string[];
        pages: Record<
          string,
          {
            status?: string;
            type?: string;
            anchors?: string[];
            redirect?: string;
          }
        >;
      })
    : { routes: [], pages: {} };

  it("has a page entry for every route", () => {
    expect(Object.keys(manifest.pages).sort()).toEqual(
      [...manifest.routes].sort(),
    );
  });

  it("records frontmatter and anchors", () => {
    const stub = manifest.pages["/docs/help/add-a-license/"]!;
    expect(stub.status).toBe("stub");
    expect(stub.type).toBe("help");
    expect(stub.anchors).toEqual(
      expect.arrayContaining(["license_owned", "email_mismatch"]),
    );
  });

  it("records where a moved page forwards", () => {
    expect(manifest.pages["/docs/admin/activity/"]).toEqual({
      redirect: "/docs/operate/console/activity/",
    });
  });

  it("drops stubs from the sitemap", () => {
    const sitemap = readFileSync(join(dist, "sitemap-0.xml"), "utf8");
    expect(sitemap).not.toContain("/docs/help/add-a-license/");
    expect(sitemap).toContain("/docs/help/activate/");
  });

  it("renders the Help message stubs with the message id as the anchor", () => {
    const html = readFileSync(
      join(dist, "help/messages/devices/index.html"),
      "utf8",
    );
    expect(html).toContain('id="activation.device-limit"');
    expect(html).toContain("Device limit reached");
    expect(html).toContain('content="noindex"');
  });
});
