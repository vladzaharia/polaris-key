import { describe, expect, it } from "vitest";
import {
  attentionItems,
  bestLicense,
  buildLibrary,
  detectDevice,
  licenseStatus,
  platformsOnlyNote,
  quickAction,
  readPresentation,
} from "../src/portal/model/library.js";
import { artifact, DAY, license, NOW_S, release } from "./portalHarness.js";

const ph = (s?: string) => `#/p/x${s ? `/${s}` : ""}`;
const MAC = { os: "macos" as const, phone: false };
const PHONE = { os: "ios" as const, phone: true };

describe("status model (§5.3), first match wins", () => {
  it("suspended beats expired", () => {
    const l = license({
      product: "a",
      status: "disabled",
      expiresAt: NOW_S - DAY,
      usable: false,
    });
    expect(licenseStatus(l, NOW_S)).toMatchObject({
      kind: "suspended",
      label: "Suspended",
      tone: "danger",
      attention: true,
    });
  });

  it("an expiry in the past is 'Ended <date>', never 'Expires'", () => {
    const s = licenseStatus(
      license({ product: "a", expiresAt: NOW_S - 3 * DAY, usable: false }),
      NOW_S,
    );
    expect(s.kind).toBe("expired");
    expect(s.note).toMatch(/^Ended \d{1,2} \w{3} \d{4}$/);
  });

  it("expires within 14 days uses relative days, with the tier and end date", () => {
    const s = licenseStatus(
      license({
        product: "a",
        tier: "studio",
        expiresAt: NOW_S + 9 * DAY - 60,
      }),
      NOW_S,
    );
    expect(s).toMatchObject({
      kind: "expiresSoon",
      label: "Expires in 9 days",
      tone: "warning",
    });
    expect(s.note).toMatch(/^Studio · ends \d{1,2} \w{3}$/);
  });

  it("further out is Active with 'until <date>'", () => {
    const s = licenseStatus(
      license({
        product: "a",
        tier: "pro",
        expiresAt: NOW_S + 60 * DAY,
        deviceCount: 2,
      }),
      NOW_S,
    );
    expect(s.kind).toBe("active");
    expect(s.note).toMatch(/^Pro · until \d{1,2} \w{3} \d{4} · 2 devices$/);
  });

  it("never claims a seat limit it doesn't know", () => {
    const s = licenseStatus(license({ product: "a", deviceCount: 1 }), NOW_S);
    expect(s.note).toBe("1 device");
    expect(s.note).not.toMatch(/of/);
  });

  it("an OIDC license with no key is a signed-in app", () => {
    const s = licenseStatus(
      license({
        product: "a",
        identityProvider: "oidc",
        keyCount: 0,
        activeKeyCount: 0,
      }),
      NOW_S,
    );
    expect(s).toMatchObject({
      kind: "signedInApp",
      tone: "neutral",
      attention: false,
    });
  });

  it("the best license is the most favourable, then the newest", () => {
    const expired = license({
      product: "a",
      id: "old",
      expiresAt: NOW_S - DAY,
    });
    const active = license({
      product: "a",
      id: "new",
      activatedAt: NOW_S - 100 * DAY,
    });
    expect(bestLicense([expired, active], NOW_S).id).toBe("new");
  });
});

describe("grouping", () => {
  it("is one product per slug, newest first, with platforms from covered releases", () => {
    const lib = buildLibrary(
      [
        license({
          product: "nightfall",
          id: "l1",
          activatedAt: NOW_S - 50 * DAY,
        }),
        license({
          product: "nightfall",
          id: "l2",
          activatedAt: NOW_S - 2 * DAY,
          tier: "edu",
        }),
        license({ product: "ember", activatedAt: NOW_S - 10 * DAY }),
      ],
      [
        release({
          product: "nightfall",
          version: "1.4.2",
          artifacts: [
            artifact({
              artifactId: "m",
              name: "n.dmg",
              platform: "macos",
              arch: "universal",
            }),
            artifact({
              artifactId: "w",
              name: "n.exe",
              platform: "windows",
              arch: "x86_64",
            }),
          ],
        }),
      ],
      NOW_S,
    );
    expect(lib.map((p) => p.slug)).toEqual(["nightfall", "ember"]);
    expect(lib[0]!.licenses).toHaveLength(2);
    expect(lib[0]!.platforms).toEqual(["windows", "macos"]);
    expect(lib[0]!.latestVersion).toBe("1.4.2");
    expect(lib[1]!.platforms).toEqual([]);
  });

  it("reads only well-formed presentation fields", () => {
    expect(
      readPresentation({
        tintColor: "red",
        website: "http://x",
        developerName: "Kiln Games",
      }),
    ).toEqual({
      developer: "Kiln Games",
      tint: null,
      website: null,
      supportUrl: null,
      supportEmail: null,
    });
    expect(readPresentation(null).developer).toBeNull();
  });
});

describe("quick action (§5.4)", () => {
  const product = (releases: Parameters<typeof buildLibrary>[1], over = {}) =>
    buildLibrary([license({ product: "x", ...over })], releases, NOW_S)[0]!;

  it("downloads the Universal build for this Mac, named honestly", () => {
    const p = product([
      release({
        product: "x",
        version: "1.4.2",
        artifacts: [
          artifact({
            artifactId: "u",
            name: "x.dmg",
            platform: "macos",
            arch: "universal",
            sizeBytes: 2_100_000_000,
          }),
        ],
      }),
    ]);
    const a = quickAction(p, MAC, ph);
    expect(a).toMatchObject({ kind: "download", label: "Download for macOS" });
    if (a.kind === "download")
      expect(a.detail).toBe("Version 1.4.2 · Universal · 2.1 GB");
  });

  it("never guesses between two Mac builds: it opens the downloads", () => {
    const p = product([
      release({
        product: "x",
        version: "2.0.0",
        artifacts: [
          artifact({
            artifactId: "a",
            name: "a",
            platform: "macos",
            arch: "arm64",
          }),
          artifact({
            artifactId: "i",
            name: "i",
            platform: "macos",
            arch: "x86_64",
          }),
        ],
      }),
    ]);
    expect(quickAction(p, MAC, ph)).toEqual({
      kind: "link",
      label: "Download for macOS",
      href: "#/p/x/get",
      icon: "downloads",
    });
  });

  it("offers the last covered version when the newest isn't covered", () => {
    const p = product(
      [
        release({
          product: "x",
          version: "2.0",
          publishedAt: NOW_S - DAY,
          artifacts: [
            artifact({
              artifactId: "n",
              name: "n",
              platform: "macos",
              canDownload: false,
            }),
          ],
        }),
        release({
          product: "x",
          version: "1.8",
          publishedAt: NOW_S - 90 * DAY,
          artifacts: [
            artifact({ artifactId: "o", name: "o", platform: "macos" }),
          ],
        }),
      ],
      { expiresAt: NOW_S - DAY },
    );
    expect(quickAction(p, MAC, ph)).toMatchObject({
      kind: "download",
      label: "Download 1.8",
    });
  });

  it("says which platforms exist when none is for this device", () => {
    const p = product([
      release({
        product: "x",
        version: "1.1.0",
        artifacts: [
          artifact({ artifactId: "w", name: "w", platform: "windows" }),
          artifact({ artifactId: "l", name: "l", platform: "linux" }),
        ],
      }),
    ]);
    expect(quickAction(p, MAC, ph)).toMatchObject({
      label: "See downloads",
      href: "#/p/x/get",
    });
    expect(platformsOnlyNote(p, MAC)).toBe("Windows and Linux only");
  });

  it("gives phones no installer", () => {
    const p = product([
      release({
        product: "x",
        version: "1",
        artifacts: [
          artifact({ artifactId: "m", name: "m", platform: "macos" }),
        ],
      }),
    ]);
    expect(quickAction(p, PHONE, ph)).toMatchObject({
      kind: "link",
      label: "See downloads",
    });
  });

  it("opens the license when there is nothing to download", () => {
    expect(quickAction(product([]), MAC, ph)).toMatchObject({
      label: "View details",
      href: "#/p/x/license",
    });
  });
});

describe("the device in hand", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", 0, "macos", false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", 5, "ios", true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5, "ios", true],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0, "windows", false],
    ["Mozilla/5.0 (Linux; Android 15)", 5, "android", true],
    ["Mozilla/5.0 (X11; Linux x86_64)", 0, "linux", false],
  ])("%s → %s", (ua, touch, os, phone) => {
    expect(detectDevice(ua, touch)).toEqual({ os, phone });
  });
});

describe("Needs attention", () => {
  it("lists only items with something to press", () => {
    const lib = buildLibrary(
      [
        license({
          product: "glyphsmith",
          tier: "studio",
          expiresAt: NOW_S + 9 * DAY,
          productBranding: {
            developerName: "Northpaw Type",
            supportUrl: "https://northpaw.example/renew",
          },
        }),
        license({ product: "ember", expiresAt: NOW_S - DAY }),
      ],
      [],
      NOW_S,
    );
    const items = attentionItems(lib);
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toEqual({
      label: "Renew with Northpaw Type",
      href: "https://northpaw.example/renew",
      external: true,
    });
    expect(items[0]!.text).toMatch(
      /^Your Studio license ends on \d+ \w{3}\. Updates stop after that\.$/,
    );
  });
});
