import { describe, expect, it } from "vitest";
import {
  attentionItems,
  bestLicense,
  buildLibrary,
  coverageNote,
  detectDevice,
  deviceFamily,
  deviceOsName,
  isDownloadAction,
  isJustAdded,
  JUST_ADDED_SECONDS,
  licenseOrigin,
  licenseStatus,
  mediaUrl,
  shortOrigin,
  platformsOnlyNote,
  quickAction,
  readPresentation,
  type QuickAction,
} from "../src/portal/model/library.js";
import { applyView, justAddedFirst } from "../src/portal/model/libraryView.js";
import {
  artifact,
  DAY,
  dlFile,
  downloadsView,
  libraryFor,
  libraryItem,
  storeLink,
  license,
  NOW_S,
  release,
} from "./portalHarness.js";
import type {
  PortalLibraryItem,
  PortalLicenseSummary,
  PortalRelease,
} from "../src/portal/api.js";

/** The library as the page builds it: the Worker's items (derived from the licences unless given). */
function build(
  licenses: PortalLicenseSummary[],
  releases: PortalRelease[],
  now: number,
  items?: PortalLibraryItem[],
) {
  return buildLibrary(
    items ?? libraryFor(licenses).products,
    licenses,
    releases,
    now,
  );
}

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

  it("an OIDC license with no key reads by its quiet origin, tier first, never a type", () => {
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
      label: "From signing in",
      note: "Standard · From signing in · 1 device",
      tone: "neutral",
      attention: false,
    });
    const pro = licenseStatus(
      license({
        product: "a",
        tier: "pro",
        identityProvider: "oidc",
        keyCount: 0,
        activeKeyCount: 0,
      }),
      NOW_S,
    );
    expect(pro.note).toBe("Pro · From signing in · 1 device");
  });

  it("words a licence's origin in plain words, naming the store with the key", () => {
    const key = license({ product: "a" });
    const signIn = license({
      product: "a",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
    });
    const keyless = license({ product: "a", keyCount: 0, activeKeyCount: 0 });
    const last = [{ last4: "3WPLDA" }];
    expect(licenseOrigin(signIn)).toBe("From signing in");
    expect(licenseOrigin(key)).toBe("Added with a key");
    expect(licenseOrigin(key, { keys: last })).toBe("Key ending 3WPLDA");
    expect(licenseOrigin(key, { store: "steam" })).toBe("Steam key");
    expect(licenseOrigin(key, { store: "steam", keys: last })).toBe(
      "Steam key ending 3WPLDA",
    );
    expect(licenseOrigin(keyless, { store: "steam" })).toBe("From Steam");
    expect(licenseOrigin(signIn, { store: "app-store" })).toBe(
      "From the App Store",
    );
    expect(licenseOrigin(keyless)).toBe("From the developer");
    expect(shortOrigin(signIn)).toBe("Sign-in");
    expect(shortOrigin(key, { keys: last })).toBe("Key …3WPLDA");
    expect(shortOrigin(key, { store: "steam", keys: last })).toBe(
      "Steam key …3WPLDA",
    );
    expect(shortOrigin(keyless, { store: "steam" })).toBe("Steam");
    expect(shortOrigin(keyless)).toBeNull();
    for (const o of [signIn, key, keyless])
      expect(licenseOrigin(o)).not.toMatch(/Account-wide/);
  });

  it("follows the Worker's origin when it sends one (PX-23, S-24 D21)", () => {
    const last = [{ last4: "3WPLDA" }];
    const dev = { developer: "Little Fern" };
    // A licence the developer assigned reads From <Developer>, though it has a key.
    const assigned = license({ product: "a", origin: "developer" });
    expect(licenseOrigin(assigned, { ...dev, keys: last })).toBe(
      "From Little Fern",
    );
    expect(licenseOrigin(assigned)).toBe("From the developer");
    expect(licenseOrigin(assigned, { developer: "  " })).toBe(
      "From the developer",
    );
    expect(shortOrigin(assigned, dev)).toBe("From Little Fern");
    expect(shortOrigin(assigned)).toBeNull();
    // A key the person added.
    const added = license({ product: "a", origin: "key" });
    expect(licenseOrigin(added, { keys: last })).toBe("Key ending 3WPLDA");
    expect(licenseOrigin(added)).toBe("Added with a key");
    // The store comes with the origin; the product view's store is only a fallback.
    const steamKey = license({
      product: "a",
      origin: "store-key",
      originStore: "steam",
    });
    expect(licenseOrigin(steamKey, { keys: last })).toBe(
      "Steam key ending 3WPLDA",
    );
    expect(shortOrigin(steamKey)).toBe("Steam key");
    const appStore = license({
      product: "a",
      keyCount: 0,
      origin: "store",
      originStore: "app-store",
    });
    expect(licenseOrigin(appStore)).toBe("From the App Store");
    const signIn = license({ product: "a", keyCount: 0, origin: "signin" });
    expect(licenseOrigin(signIn, dev)).toBe("From signing in");
    // A store origin with no store named reads by its other facts, never " key" or "From ".
    expect(
      licenseOrigin(license({ product: "a", origin: "store-key" }), {
        keys: last,
      }),
    ).toBe("Key ending 3WPLDA");
    expect(shortOrigin(license({ product: "a", origin: "store-key" }))).toBe(
      "Key",
    );
    expect(
      licenseOrigin(
        license({ product: "a", keyCount: 0, origin: "store" }),
        dev,
      ),
    ).toBe("From Little Fern");
    // An origin this build does not know reads by the older facts.
    expect(licenseOrigin(license({ product: "a", origin: "gift" }))).toBe(
      "Added with a key",
    );
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
    const lib = build(
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
      iconUrl: null,
      headerUrl: null,
    });
    expect(readPresentation(null).developer).toBeNull();
  });
});

describe("quick action (§5.4)", () => {
  const product = (releases: PortalRelease[], over = {}) =>
    build([license({ product: "x", ...over })], releases, NOW_S)[0]!;

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
    const lib = build(
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

describe("the server-side library (PX-W1: G1, G5, G16)", () => {
  const item = (over: Partial<PortalLibraryItem> = {}): PortalLibraryItem => ({
    product: "x",
    name: "Nightfall",
    developerName: "Kiln Games",
    tintColor: "#224466",
    website: "https://kiln.example",
    iconUrl: "/media/x/icon?v=1",
    headerUrl: "/media/x/header?v=1",
    support: { url: "https://kiln.example/help", email: null },
    status: "active",
    license: {
      id: "lic_x_1",
      tier: null,
      status: "active",
      licenseStatus: "active",
      activatedAt: NOW_S,
      expiresAt: null,
      maxOfflineDays: null,
      deviceLimit: 3,
      activeSeatCount: 2,
      deviceCount: 2,
      dormantCount: 0,
    },
    licenseCount: 1,
    addedAt: NOW_S,
    ...over,
  });
  const lic = () => license({ product: "x", id: "lic_x_1", deviceCount: 2 });

  it("takes presentation, same-origin art and the seat limit", () => {
    const [p] = build([lic()], [], NOW_S, [item()]);
    expect(p!.name).toBe("Nightfall");
    expect(p!.presentation).toMatchObject({
      developer: "Kiln Games",
      tint: "#224466",
      supportUrl: "https://kiln.example/help",
      iconUrl: "/media/x/icon?v=1",
      headerUrl: "/media/x/header?v=1",
    });
    expect(p!.seats).toEqual({ limit: 3, inUse: 2 });
    expect(p!.status.note).toBe("2 of 3 devices");
  });

  it("never loads art from another origin", () => {
    const [p] = build([lic()], [], NOW_S, [
      item({ iconUrl: "https://evil.example/i.png", headerUrl: null }),
    ]);
    expect(p!.presentation.iconUrl).toBeNull();
    expect(p!.presentation.headerUrl).toBeNull();
  });

  it("takes a hosted copy on the image host (HA-07): the content-addressed shape only", () => {
    const sha = "a".repeat(64);
    const icon = `https://img.plrs.im/x/a/${sha}/128.webp`;
    const header = `https://img.plrs.im/x/a/${sha}`;
    const [p] = build([lic()], [], NOW_S, [
      item({ iconUrl: icon, headerUrl: header }),
    ]);
    expect(p!.presentation.iconUrl).toBe(icon);
    expect(p!.presentation.headerUrl).toBe(header);
    // A local image host over loopback HTTP, for development.
    expect(mediaUrl(`http://localhost:8788/x/a/${sha}`)).toBe(
      `http://localhost:8788/x/a/${sha}`,
    );
    for (const refused of [
      "https://cdn.example/icon.png",
      `http://img.plrs.im/x/a/${sha}`,
      `https://img.plrs.im:8443/x/a/${sha}`,
      `https://u:p@img.plrs.im/x/a/${sha}`,
      `https://img.plrs.im/x/a/${sha}?v=1`,
      `https://img.plrs.im/x/a/${sha}#f`,
      `https://img.plrs.im/x/a/${sha.toUpperCase()}`,
      `https://img.plrs.im/x/a/${sha}/128.png`,
      `https://img.plrs.im/x/icon`,
      `javascript:alert(1)`,
      `data:image/png;base64,AAAA`,
    ])
      expect(mediaUrl(refused), refused).toBeNull();
  });

  it("a full licence is 'Device limit reached', and its action frees a device", () => {
    const full = item({
      license: { ...item().license, activeSeatCount: 3, deviceCount: 3 },
    });
    const [p] = build([lic()], [], NOW_S, [full]);
    expect(p!.status).toMatchObject({
      kind: "deviceLimit",
      label: "Device limit reached",
      attention: true,
    });
    expect(quickAction(p!, MAC, ph)).toMatchObject({
      label: "Free a device",
      href: "#/p/x/devices",
    });
    const [att] = attentionItems([p!], (s) => `#/p/${s}/devices`);
    expect(att!.action).toEqual({
      label: "Free a device",
      href: "#/p/x/devices",
      external: false,
    });
  });

  it("describes the licence the Worker ranked best, with its seats", () => {
    const newer = license({
      product: "x",
      id: "lic_x_2",
      activatedAt: NOW_S - DAY,
      status: "disabled",
    });
    const [p] = build([lic(), newer], [], NOW_S, [item()]);
    expect(p!.best.id).toBe("lic_x_1");
    expect(p!.licenses.map((l) => l.id)).toEqual(["lic_x_1", "lic_x_2"]);
    expect(p!.seats).toEqual({ limit: 3, inUse: 2 });
  });
});

describe("PX-08: the Worker's status, in words", () => {
  it("words the Worker's device limit, red, with the seat count", () => {
    const l = license({ product: "orbit", deviceCount: 2 });
    const [p] = build([l], [], NOW_S, [libraryItem(l, { deviceLimit: 2 })]);
    expect(p!.status).toMatchObject({
      kind: "deviceLimit",
      tone: "danger",
      note: "2 of 2 devices",
    });
  });

  it("an expired licence that still downloads an older build says where updates ended", () => {
    const l = license({ product: "ember", expiresAt: NOW_S - 20 * DAY });
    const d = downloadsView(
      "ember",
      [dlFile({ artifactId: "e18", platform: "macos", version: "1.8" })],
      { latest: false },
    );
    const [p] = buildLibrary(
      [libraryItem(l)],
      [l],
      [],
      NOW_S,
      new Map([["ember", d]]),
    );
    expect(p!.status).toMatchObject({
      kind: "expired",
      note: "Updates ended at 1.8",
    });
    expect(quickAction(p!, MAC, ph)).toMatchObject({
      kind: "download",
      label: "Download 1.8",
    });
    expect(coverageNote(p!)).toBe("Version 2.0 isn't covered.");
  });

  it("names the developer who suspended a licence", () => {
    const l = license({ product: "x", status: "disabled", usable: false });
    const [p] = build([l], [], NOW_S, [
      libraryItem(l, { developerName: "Kiln Games" }),
    ]);
    expect(p!.status.note).toBe("Suspended by Kiln Games.");
  });

  it("lists only the Worker's products, in its order, even before licences load", () => {
    const a = license({ product: "a", activatedAt: NOW_S - 9 * DAY });
    const b = license({ product: "b", activatedAt: NOW_S - DAY });
    const lib = buildLibrary([libraryItem(a), libraryItem(b)], [], [], NOW_S);
    expect(lib.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(lib[0]!.best.id).toBe(a.id);
  });
});

describe("PX-08: store-aware quick actions (§5.4)", () => {
  const ANDROID = { os: "android" as const, phone: true };
  const WIN = { os: "windows" as const, phone: false };
  const withView = (d: ReturnType<typeof downloadsView>) => {
    const l = license({ product: "x" });
    return buildLibrary(
      [libraryItem(l)],
      [l],
      [],
      NOW_S,
      new Map([["x", d]]),
    )[0]!;
  };
  const appStore = storeLink({
    kind: "app-store",
    label: "App Store",
    platforms: ["ios"],
  });
  const steam = storeLink({
    kind: "steam",
    label: "Steam",
    platforms: ["windows", "macos", "linux"],
  });

  it("downloads the build the Worker picked for this Mac, named honestly", () => {
    const p = withView(
      downloadsView("x", [dlFile({ artifactId: "m", platform: "macos" })]),
    );
    expect(quickAction(p, MAC, ph)).toMatchObject({
      kind: "download",
      label: "Download for macOS",
      detail: "Version 1.4.2 · Universal · 2.1 GB",
      artifact: { artifactId: "m" },
      release: { releaseId: "rel_1.4.2" },
    });
  });

  it("never picks between two Mac builds", () => {
    const p = withView(
      downloadsView("x", [
        dlFile({ artifactId: "a", platform: "macos", arch: "arm64" }),
        dlFile({ artifactId: "i", platform: "macos", arch: "x86_64" }),
      ]),
    );
    expect(quickAction(p, MAC, ph)).toEqual({
      kind: "link",
      label: "Download for macOS",
      href: "#/p/x/get",
      icon: "downloads",
    });
  });

  it("a phone gets its own store's page", () => {
    const p = withView(
      downloadsView("x", [dlFile({ artifactId: "m", platform: "macos" })], {
        stores: [appStore, steam],
      }),
    );
    expect(quickAction(p, PHONE, ph)).toEqual({
      kind: "link",
      label: "Get it on the App Store",
      href: "https://store.example/app-store",
      icon: "store",
      external: true,
    });
    expect(p.stores.map((s) => s.kind)).toEqual(["app-store", "steam"]);
  });

  it("a phone without a store emails itself the desktop download", () => {
    const p = withView(
      downloadsView("x", [dlFile({ artifactId: "w", platform: "windows" })], {
        recommend: null,
        stores: [appStore],
      }),
    );
    expect(quickAction(p, ANDROID, ph)).toEqual({
      kind: "email",
      label: "Email me the download",
      platform: "windows",
    });
  });

  it("a computer with no build for it opens a store that sells one, else the downloads", () => {
    const linuxOnly = [dlFile({ artifactId: "l", platform: "linux" })];
    expect(
      quickAction(
        withView(
          downloadsView("x", linuxOnly, { recommend: null, stores: [steam] }),
        ),
        WIN,
        ph,
      ),
    ).toMatchObject({ label: "Get it on Steam", icon: "store" });
    expect(
      quickAction(
        withView(downloadsView("x", linuxOnly, { recommend: null })),
        WIN,
        ph,
      ),
    ).toMatchObject({ label: "See downloads", href: "#/p/x/get" });
  });

  it("a store that isn't live, or has no page, is never offered", () => {
    const p = withView(
      downloadsView("x", [], {
        recommend: null,
        stores: [
          { ...appStore, live: false },
          { ...appStore, id: "app-store:b", url: null },
        ],
      }),
    );
    expect(p.stores).toEqual([]);
    expect(quickAction(p, PHONE, ph)).toMatchObject({ label: "View details" });
  });
});

describe("deviceFamily and deviceOsName (SP-08)", () => {
  it("keeps the header-only Apple values for the device row, off the download vocabulary", () => {
    expect(deviceFamily("tvos")).toBe("tvos");
    expect(deviceFamily("visionOS")).toBe("visionos");
    expect(deviceFamily("watchos")).toBe("watchos");
    expect(deviceFamily("iPadOS")).toBe("ios");
    expect(deviceFamily("macos")).toBe("macos");
    expect(deviceFamily("freebsd")).toBeNull();
    expect(deviceFamily(null)).toBeNull();
  });

  it("names the OS a device row shows", () => {
    expect(deviceOsName("tvos")).toBe("Apple TV");
    expect(deviceOsName("visionos")).toBe("Apple Vision Pro");
    expect(deviceOsName("watchos")).toBe("Apple Watch");
    expect(deviceOsName("ios")).toBe("iPhone");
    expect(deviceOsName("unknown")).toBeNull();
  });
});

describe("PX-24: Added just now", () => {
  const H = 3600;

  it("is 24 hours from the Worker's first contact, at the edges", () => {
    expect(JUST_ADDED_SECONDS).toBe(24 * H);
    // Just added, a minute ago, one second short of the 24 hours.
    expect(isJustAdded(NOW_S, NOW_S)).toBe(true);
    expect(isJustAdded(NOW_S - 60, NOW_S)).toBe(true);
    expect(isJustAdded(NOW_S - (23 * H + 59 * 60), NOW_S)).toBe(true);
    expect(isJustAdded(NOW_S - (24 * H - 1), NOW_S)).toBe(true);
    // At 24 hours it is ordinary again.
    expect(isJustAdded(NOW_S - 24 * H, NOW_S)).toBe(false);
    expect(isJustAdded(NOW_S - 30 * DAY, NOW_S)).toBe(false);
  });

  it("counts a future addedAt (this clock behind the server's) as now", () => {
    expect(isJustAdded(NOW_S + 90, NOW_S)).toBe(true);
    expect(isJustAdded(NOW_S + 3 * DAY, NOW_S)).toBe(true);
  });

  it("is never just added without the Worker's addedAt", () => {
    expect(isJustAdded(null, NOW_S)).toBe(false);
    expect(isJustAdded(undefined, NOW_S)).toBe(false);
    expect(isJustAdded(Number.NaN, NOW_S)).toBe(false);
  });

  it("reads the Worker's addedAt, never the activation fallback", () => {
    const fresh = license({ product: "fresh", activatedAt: NOW_S - 60 });
    const old = license({ product: "old", activatedAt: NOW_S - 60 });
    const [a, b] = buildLibrary(
      [
        libraryItem(fresh, { addedAt: NOW_S - 60 }),
        // A licence just attached to a product the account met long ago (a re-add after Remove
        // from my library): first contact is old, so it is not just added.
        libraryItem(old, { addedAt: NOW_S - 40 * DAY }),
      ],
      [fresh, old],
      [],
      NOW_S,
    );
    expect([a!.justAdded, b!.justAdded]).toEqual([true, false]);
    // No addedAt from the Worker: the activation still sorts it, but it is not just added.
    const [c] = buildLibrary(
      [libraryItem(fresh, { addedAt: null })],
      [fresh],
      [],
      NOW_S,
    );
    expect(c!.addedAt).toBe(NOW_S - 60);
    expect(c!.justAdded).toBe(false);
    // 24 hours later the same item is ordinary.
    const [d] = buildLibrary(
      [libraryItem(fresh, { addedAt: NOW_S - 60 })],
      [fresh],
      [],
      NOW_S - 60 + 24 * H,
    );
    expect(d!.justAdded).toBe(false);
  });

  describe("comes first under the default sort, and keeps its place by name", () => {
    const items = [
      license({ product: "alpha", productName: "Alpha" }),
      license({ product: "zinnia", productName: "Zinnia" }),
      // No first contact from the Worker, and a newer activation than Zinnia's: still behind it.
      license({ product: "mid", productName: "Mid", activatedAt: NOW_S - 10 }),
    ];
    const at: Record<string, number | null> = {
      alpha: NOW_S - 3 * DAY,
      zinnia: NOW_S - 60,
      mid: null,
    };
    const lib = buildLibrary(
      items.map((l) => libraryItem(l, { addedAt: at[l.product] })),
      items,
      [],
      NOW_S,
    );
    const view = { q: "", filter: "all" as const };

    it("recent (the default): the just-added product first", () => {
      expect(
        applyView(lib, { ...view, sort: "recent" }).map((p) => p.slug),
      ).toEqual(["zinnia", "mid", "alpha"]);
    });

    it("by name: in its place", () => {
      expect(
        applyView(lib, { ...view, sort: "name" }).map((p) => p.slug),
      ).toEqual(["alpha", "mid", "zinnia"]);
    });

    it("the 2–7 grid (no sort): the just-added product first, the rest in the Worker's order", () => {
      expect(justAddedFirst(lib).map((p) => p.slug)).toEqual([
        "zinnia",
        "alpha",
        "mid",
      ]);
      // Nothing just added: the Worker's order, untouched.
      const none = lib.filter((p) => !p.justAdded);
      expect(justAddedFirst(none)).toEqual(none);
    });
  });

  it("leads with the product's download, never with See downloads or another action", () => {
    const link = (
      label: string,
      icon: "downloads" | "open" | "details" | "store" | "device",
    ): QuickAction => ({ kind: "link", label, href: "#/p/x", icon });
    const l = license({ product: "x" });
    const r = release({
      product: "x",
      version: "1.0",
      artifacts: [
        artifact({ artifactId: "m", name: "X.dmg", platform: "macos" }),
      ],
    });
    const p = build([l], [r], NOW_S)[0]!;
    const download = quickAction(p, MAC, ph);
    expect(download.kind).toBe("download");
    expect(isDownloadAction(download)).toBe(true);
    expect(
      isDownloadAction({
        kind: "email",
        label: "Email me the download",
        platform: "macos",
      }),
    ).toBe(true);
    // Two Mac builds: "Download for macOS" opens both on the product page.
    expect(isDownloadAction(link("Download for macOS", "downloads"))).toBe(
      true,
    );
    expect(isDownloadAction(link("Get it on the App Store", "store"))).toBe(
      true,
    );
    expect(isDownloadAction(link("See downloads", "downloads"))).toBe(false);
    expect(isDownloadAction(link("View details", "details"))).toBe(false);
    expect(isDownloadAction(link("Free a device", "device"))).toBe(false);
    expect(isDownloadAction(link("Open Quill", "open"))).toBe(false);
  });
});
