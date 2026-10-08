import { describe, expect, it } from "vitest";
import type { PortalProduct } from "../src/portal/api.js";
import type { QuickAction } from "../src/portal/model/library.js";
import {
  deviceSeats,
  elsewhereFor,
  getItFromDownloads,
  recommendedLabel,
  resolveDevice,
  seatsFor,
  settleAction,
  withSeats,
} from "../src/portal/model/product.js";
import { resolveHash } from "../src/portal/router.js";
import { breakPoints } from "../src/portal/components/product/InstallSources.js";
import {
  detail,
  device,
  dlFile,
  downloadsView,
  installSource,
  license,
  NOW_S,
  DAY,
  storeLink,
} from "./portalHarness.js";

const MAC = { os: "macos", phone: false } as const;

describe("one OS source (§0.6 P3)", () => {
  it("takes the Worker's detection over the browser's guess", () => {
    const d = downloadsView(
      "x",
      [dlFile({ artifactId: "w", platform: "windows" })],
      {
        recommend: "windows",
      },
    );
    expect(resolveDevice(d, MAC)).toEqual({ os: "windows", phone: false });
  });

  it("an iPad behind a Mac user agent stays an iPad", () => {
    const d = downloadsView("x", [
      dlFile({ artifactId: "m", platform: "macos" }),
    ]);
    d.detected.touchAmbiguous = true;
    expect(resolveDevice(d, { os: "ios", phone: true })).toEqual({
      os: "ios",
      phone: true,
    });
    // Without a touch screen, the server's Mac stands.
    expect(resolveDevice(d, MAC)).toEqual(MAC);
  });

  it("UA-CH in the browser refines the answer; without any detection, the browser decides", () => {
    const d = downloadsView("x", [
      dlFile({ artifactId: "m", platform: "macos" }),
    ]);
    expect(resolveDevice(d, MAC, { platform: "Linux", mobile: false })).toEqual(
      {
        os: "linux",
        phone: false,
      },
    );
    expect(
      resolveDevice(d, MAC, { platform: "Android", mobile: true }),
    ).toEqual({
      os: "android",
      phone: true,
    });
    // An unknown hint ("Chrome OS") leaves the server's answer.
    expect(resolveDevice(d, MAC, { platform: "Chrome OS" })).toEqual(MAC);
    expect(resolveDevice(null, MAC)).toEqual(MAC);
    const none = downloadsView("x", [], { recommend: null });
    expect(resolveDevice(none, { os: "linux", phone: false })).toEqual({
      os: "linux",
      phone: false,
    });
  });

  it("Get it recommends only for the OS it is told, so the label and the build agree", () => {
    const d = downloadsView(
      "x",
      [
        dlFile({ artifactId: "m", platform: "macos" }),
        dlFile({ artifactId: "w", platform: "windows", arch: "x86_64" }),
      ],
      { recommend: "windows" },
    );
    const asMac = getItFromDownloads(d, MAC)!;
    expect(asMac.os).toBe("macos");
    expect(asMac.recommended).toEqual([]);
    const here = resolveDevice(d, MAC);
    const m = getItFromDownloads(d, here)!;
    expect(m.os).toBe("windows");
    expect(m.recommended.map((r) => r.platform)).toEqual(["windows"]);
    expect(recommendedLabel(m.os!)).toBe("Recommended for your Windows PC");
    expect(recommendedLabel("macos")).toBe("Recommended for your Mac");
    // A phone gets no recommendation.
    expect(getItFromDownloads(d, { os: "ios", phone: true })!.os).toBeNull();
  });
});

describe("not_hosted reads where to get it (§0.6 P3, §11.2)", () => {
  it("names a live store that carries the platform, then the developer", () => {
    const steam = storeLink({
      kind: "steam",
      label: "Steam",
      platforms: ["windows", "macos"],
    });
    expect(elsewhereFor("windows", { stores: [steam] })).toEqual({
      label: "Get it from Steam",
      href: "https://store.example/steam",
    });
    // An extra (no platform) takes any live store.
    expect(elsewhereFor(null, { stores: [steam] }).label).toBe(
      "Get it from Steam",
    );
    expect(
      elsewhereFor("linux", {
        stores: [steam],
        developer: "Kiln Games",
        website: "https://kiln.example",
      }),
    ).toEqual({
      label: "Get it from Kiln Games",
      href: "https://kiln.example",
    });
    // A store that isn't live, or a non-https link, is never offered.
    expect(
      elsewhereFor("windows", {
        stores: [{ ...steam, live: false }],
        developer: "Kiln Games",
      }),
    ).toEqual({ label: "Get it from Kiln Games", href: null });
    expect(elsewhereFor("windows", { website: "javascript:alert(1)" })).toEqual(
      { label: "Get it from the developer", href: null },
    );
  });

  it("a not_hosted file is never 'Not included' or 'here yet'", () => {
    const d = downloadsView(
      "x",
      [
        dlFile({ artifactId: "m", platform: "macos" }),
        dlFile({
          artifactId: "pack",
          platform: null,
          canDownload: false,
          reason: "not_hosted",
        }),
        dlFile({
          artifactId: "new",
          platform: "macos",
          canDownload: false,
          reason: "not_entitled",
        }),
      ],
      { stores: [storeLink({ kind: "steam", label: "Steam" })] },
    );
    const m = getItFromDownloads(d, MAC, { developer: "Kiln Games" })!;
    const rows = m.groups.flatMap((g) => g.rows);
    const pack = rows.find((r) => r.artifact.artifactId === "pack")!;
    expect(pack.elsewhere).toEqual({
      label: "Get it from Steam",
      href: "https://store.example/steam",
    });
    expect(pack.notIncluded).toBe("Get it from Steam");
    const newer = rows.find((r) => r.artifact.artifactId === "new")!;
    expect(newer.elsewhere).toBeNull();
    expect(newer.notIncluded).toBe("Your license doesn't include this version");
  });

  it("puts each install source under its platform after its files, the device's OS first; stores alone are 'Also yours on' (P0-48)", () => {
    const d = {
      ...downloadsView(
        "x",
        [
          dlFile({
            artifactId: "pack",
            platform: null,
            canDownload: false,
            reason: "not_hosted",
          }),
          dlFile({ artifactId: "m", platform: "macos" }),
          dlFile({ artifactId: "w", platform: "windows", arch: "x86_64" }),
        ],
        {
          stores: [
            storeLink({
              kind: "steam",
              label: "Steam",
              platforms: ["windows", "macos"],
            }),
            // A store with a command and no page is installed like a source.
            storeLink({
              kind: "winget",
              label: "winget",
              url: null,
              command: "winget install --id X.X --exact",
              platforms: ["windows"],
            }),
          ],
        },
      ),
      installSources: [
        installSource({
          kind: "homebrew",
          label: "Homebrew",
          command: "brew install --cask x",
          platforms: ["macos"],
        }),
        installSource({
          kind: "scoop",
          label: "Scoop",
          command: "scoop install https://k.example/x/scoop/stable.json",
          platforms: ["windows"],
        }),
        installSource({
          kind: "altstore",
          label: "Add to AltStore",
          url: "https://k.example/x/altstore/stable/source.json",
          deepLink: "altstore://source?url=x",
          platforms: ["ios"],
        }),
      ],
    };
    const shape = (m: ReturnType<typeof getItFromDownloads>) =>
      m!.groups.map((g) => [
        g.platform,
        g.rows.map((r) => r.artifact.artifactId),
        g.sources.map((s) => s.kind),
      ]);
    const WIN = { os: "windows", phone: false } as const;
    expect(shape(getItFromDownloads(d, WIN))).toEqual([
      ["windows", ["w"], ["scoop", "winget"]],
      ["macos", ["m"], ["homebrew"]],
      // A platform with sources and no files gets a group of its own.
      ["ios", [], ["altstore"]],
      [null, ["pack"], []],
    ]);
    const m = getItFromDownloads(d, MAC)!;
    expect(shape(m).map((g) => g[0])).toEqual([
      "macos",
      "windows",
      "ios",
      null,
    ]);
    expect(m.stores.map((s) => s.label)).toEqual(["Steam"]);
    expect(m.here).toBeNull();
    // Only a store answers "where else"; without one, the developer does.
    const pack = (x: ReturnType<typeof getItFromDownloads>) =>
      x!.groups
        .flatMap((g) => g.rows)
        .find((r) => r.artifact.artifactId === "pack")!.elsewhere!.label;
    expect(pack(m)).toBe("Get it from Steam");
    expect(pack(getItFromDownloads({ ...d, stores: [] }, MAC))).toBe(
      "Get it from the developer",
    );
  });

  it("on a phone, leads with what installs on it; otherwise there is nothing to lead with (P0-48)", () => {
    const appStore = storeLink({
      kind: "app-store",
      label: "App Store",
      platforms: ["ios"],
    });
    const alt = installSource({
      kind: "altstore",
      label: "Add to AltStore",
      url: "https://k.example/x/altstore/stable/source.json",
      deepLink: "altstore://source?url=x",
      platforms: ["ios"],
    });
    const d = {
      ...downloadsView("x", [dlFile({ artifactId: "m", platform: "macos" })], {
        stores: [appStore],
      }),
      installSources: [alt],
    };
    const IPHONE = { os: "ios", phone: true } as const;
    const m = getItFromDownloads(d, IPHONE)!;
    expect(m.here).toEqual({ os: "ios", stores: [appStore], sources: [alt] });
    expect(m.groups[0]!.platform).toBe("ios");
    // An Android phone gets nothing here: the page says to open it on a computer.
    expect(
      getItFromDownloads(d, { os: "android", phone: true } as const)!.here,
    ).toBeNull();
    // On a computer there is no lead of this kind.
    expect(getItFromDownloads(d, MAC)!.here).toBeNull();
  });
});

describe("the quick action never points at the page you are on (§0.6 P3)", () => {
  const details: QuickAction = {
    kind: "link",
    label: "View details",
    href: "#/p/ember/license",
    icon: "details",
  };
  const bare = {
    slug: "ember",
    presentation: {
      developer: "Kiln Games",
      tint: null,
      website: null,
      supportUrl: null,
      supportEmail: null,
      iconUrl: null,
      headerUrl: null,
    },
  };
  const onPage = resolveHash("#/p/ember").route;
  const library = resolveHash("#/").route;

  it("with a website, it is 'Get it from <developer>' everywhere", () => {
    const p = {
      ...bare,
      presentation: { ...bare.presentation, website: "https://kiln.example" },
    };
    const want = {
      kind: "link",
      label: "Get it from Kiln Games",
      href: "https://kiln.example",
      icon: "open",
      external: true,
    };
    expect(settleAction(p, details, library)).toEqual(want);
    expect(settleAction(p, details, onPage)).toEqual(want);
  });

  it("without one, the tile keeps its link to the page, and the page itself shows none", () => {
    expect(settleAction(bare, details, library)).toBe(details);
    expect(settleAction(bare, details, onPage)).toBeNull();
    expect(
      settleAction(bare, details, resolveHash("#/p/ember/devices").route),
    ).toBeNull();
    // Another product's page is not this page.
    expect(
      settleAction(bare, details, resolveHash("#/p/nightfall").route),
    ).toBe(details);
  });

  it("leaves every other action alone", () => {
    const see: QuickAction = {
      kind: "link",
      label: "See downloads",
      href: "#/p/ember/get",
      icon: "downloads",
    };
    expect(settleAction(bare, see, onPage)).toBe(see);
  });
});

describe("one device source (§0.6 P4)", () => {
  const lic = license({ product: "orbit" });
  const seatsLicense = (
    over: Partial<PortalProduct["licenses"][number]> = {},
  ): PortalProduct["licenses"][number] => ({
    id: lic.id,
    tier: null,
    status: "active",
    licenseStatus: "active",
    activatedAt: NOW_S - 30 * DAY,
    expiresAt: null,
    maxOfflineDays: null,
    deviceLimit: 3,
    activeSeatCount: 2,
    deviceCount: 3,
    dormantCount: 1,
    entitlements: [],
    devices: [
      {
        deviceId: "a",
        label: "A",
        platform: "macos",
        arch: null,
        appVersion: null,
        firstSeen: 0,
        lastSeen: NOW_S - DAY,
        dormant: false,
      },
      {
        deviceId: "b",
        label: "B",
        platform: "windows",
        arch: null,
        appVersion: null,
        firstSeen: 0,
        lastSeen: NOW_S - 5 * DAY,
        dormant: false,
      },
      {
        deviceId: "c",
        label: "C",
        platform: "linux",
        arch: null,
        appVersion: null,
        firstSeen: 0,
        lastSeen: NOW_S - 120 * DAY,
        dormant: true,
      },
    ],
    ...over,
  });

  it("counts seats as the Worker does: dormant devices hold none", () => {
    const s = deviceSeats(seatsLicense());
    expect(s.limit).toBe(3);
    expect(s.inUse).toBe(2);
    expect(s.full).toBe(false);
    expect(s.holders.map((d) => d.deviceId)).toEqual(["b", "a"]);
    expect([...s.dormantIds]).toEqual(["c"]);
    expect(deviceSeats(seatsLicense({ activeSeatCount: 3 })).full).toBe(true);
    expect(deviceSeats(seatsLicense({ deviceLimit: 0 }))).toMatchObject({
      limit: null,
      full: false,
    });
  });

  it("the product page's Devices card shows a dormant device as not holding a seat", () => {
    const d = detail(lic, {
      devices: [
        device({ deviceId: "a" }),
        device({ deviceId: "b" }),
        device({ deviceId: "c" }),
      ],
    });
    const product = { licenses: [seatsLicense()] } as unknown as PortalProduct;
    const seats = seatsFor(product, lic.id);
    const shown = withSeats(d, seats);
    expect(
      shown.devices
        .filter((x) => x.status === "authorized")
        .map((x) => x.deviceId),
    ).toEqual(["a", "b"]);
    expect(seatsFor(product, "other")).toBeNull();
    // Without the product view, the detail is unchanged.
    expect(withSeats(d, null)).toBe(d);
  });
});

describe("a long URL or command wraps at its seams (P0-48)", () => {
  it("breaks after a slash (never inside //), before ? and &, after =", () => {
    expect(
      breakPoints(
        "scoop install https://k.example/x/scoop/stable.json?outlet=a&b=c",
      ),
    ).toEqual([
      "scoop install https://",
      "k.example/",
      "x/",
      "scoop/",
      "stable.json",
      "?outlet=",
      "a",
      "&b=",
      "c",
    ]);
    // A fingerprint wraps every 8 characters; a short hex word does not.
    expect(breakPoints("ab".repeat(32))).toEqual(Array(8).fill("abababab"));
    expect(breakPoints("repo?fingerprint=" + "c0ffee12".repeat(2))).toEqual([
      "repo",
      "?fingerprint=",
      "c0ffee12",
      "c0ffee12",
    ]);
    expect(breakPoints("brew install --cask deadbeef")).toEqual([
      "brew install --cask deadbeef",
    ]);
  });
});
