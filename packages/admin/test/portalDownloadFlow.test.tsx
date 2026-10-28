import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalDownloadFile,
  PortalDownloads,
  PortalProduct,
} from "../src/portal/api.js";
import { browser } from "../src/portal/browser.js";
import { installHint } from "../src/portal/copy/getIt.js";
import { formatDay } from "../src/portal/model/library.js";
import { fileFormat, fileSource } from "../src/portal/model/product.js";
import { flowPlatform } from "../src/portal/pages/DownloadFlowPage.js";
import {
  axeViolations,
  DAY,
  dlFile,
  downloadsView,
  fetchedRequests,
  installSource,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
  storeLink,
  type MockRoute,
} from "./portalHarness.js";

/**
 * The focused download (PORTAL.md §4.25 item 4, PX-29): `#/p/<product>/download?platform=` in the
 * task frame. The title leads with the version; the build (OS, architecture, file type, size) is
 * named before the one primary; the channel, SHA-256 and install hint follow; every other build
 * is one disclosure away. On a phone the primary is "Email me the download", never a desktop
 * Download.
 */

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function asUA(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  asUA(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const orbit = license({
  product: "orbit-survey",
  productName: "Orbit Survey",
  deviceCount: 1,
});

function product(over: Partial<PortalProduct> = {}): PortalProduct {
  return {
    product: "orbit-survey",
    name: "Orbit Survey",
    developerName: "Parallax Nine",
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: { url: "https://parallax.example/help", email: null },
    services: { license: true },
    status: "active",
    addedAt: NOW_S - 30 * DAY,
    returnTo: { origins: ["https://orbit.example"], schemes: ["orbitsurvey"] },
    licenses: [
      {
        id: orbit.id,
        tier: null,
        status: "active",
        licenseStatus: "active",
        activatedAt: NOW_S - 30 * DAY,
        expiresAt: null,
        maxOfflineDays: null,
        deviceLimit: 2,
        activeSeatCount: 1,
        deviceCount: 1,
        dormantCount: 0,
        entitlements: [],
        devices: [],
      },
    ],
    ...over,
  };
}

const SHA = "5be0c2a91f4e7d3388c0b1a5e9d2f6047c3b8a1e2d9f5c6b7a8e9d0c1f2a1f9a";
const PUBLISHED = Math.floor(Date.UTC(2026, 8, 22, 12) / 1000);

const mac = dlFile({
  artifactId: "mac",
  platform: "macos",
  name: "Orbit-Survey-1.4.2.dmg",
  sizeBytes: 84_000_000,
  sha256: SHA,
});
const macIntel = dlFile({
  artifactId: "mac-x64",
  platform: "macos",
  arch: "x86_64",
  name: "Orbit-Survey-1.4.2-intel.dmg",
  sizeBytes: 80_000_000,
  sha256: SHA,
});
const win = dlFile({
  artifactId: "win",
  platform: "windows",
  arch: "x86_64",
  name: "Orbit-Survey-1.4.2-setup.exe",
  sizeBytes: 70_000_000,
  sha256: SHA,
});
const winArm = dlFile({
  artifactId: "win-arm",
  platform: "windows",
  arch: "arm64",
  name: "Orbit-Survey-1.4.2-arm64-setup.exe",
  sizeBytes: 68_000_000,
  canDownload: false,
  reason: "not_entitled",
});
const linux = dlFile({
  artifactId: "lin",
  platform: "linux",
  arch: "x86_64",
  name: "Orbit-Survey-1.4.2.AppImage",
  sizeBytes: 90_000_000,
  sha256: SHA,
});
const apk = dlFile({
  artifactId: "apk",
  platform: "android",
  name: "Orbit-Survey-1.4.2.apk",
  sizeBytes: 40_000_000,
  sha256: SHA,
});

/** A downloads view whose newest release is 1.4.2, published on `PUBLISHED`. */
function view(
  files: PortalDownloadFile[],
  opts: Parameters<typeof downloadsView>[2] = {},
  over: Partial<PortalDownloads> = {},
): PortalDownloads {
  return {
    ...downloadsView("orbit-survey", files, opts),
    latest: {
      releaseId: "rel_1.4.2",
      version: "1.4.2",
      title: null,
      publishedAt: PUBLISHED,
    },
    ...over,
  };
}

function routes(
  downloads: PortalDownloads,
  extra: Record<string, MockRoute> = {},
): Record<string, MockRoute> {
  return signedIn([orbit], {
    "/api/products/orbit-survey": product(),
    "/api/products/orbit-survey/downloads": downloads,
    ...extra,
  });
}

function go(hash: string): void {
  window.history.replaceState(null, "", `/${hash}`);
}

/** Opens the page and waits for its title. */
async function open(
  hash: string,
  title = "Download Orbit Survey 1.4.2",
): Promise<HTMLElement> {
  go(hash);
  renderPortal();
  return screen.findByRole("heading", { level: 1, name: title });
}

const follows = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** The build line's text, with its no-break spaces read as spaces. */
function buildLine(): string {
  const line = document.querySelector("[data-build]");
  expect(line).not.toBeNull();
  return line!.textContent!.replace(/\u00a0/g, " ");
}

const toggle = (): HTMLElement =>
  screen.getByRole("button", { name: /^Other platforms and architectures/ });

const builds = (): HTMLElement =>
  screen.getByRole("list", { name: "Other platforms and architectures" });

const names = (list: HTMLElement): string[] =>
  [...list.querySelectorAll("[data-build-name]")].map((n) => n.textContent!);

describe("a download that fails after the click (HA-09F)", () => {
  it("lands on the product page with the message and drops the parameter", async () => {
    mockFetch(routes(view([mac])));
    go("#/p/orbit-survey?download=failed");
    renderPortal();
    expect(await screen.findByText("The download didn't start")).toBeTruthy();
    expect(
      screen.getByText(
        "The link expired or was already used. Choose Download again.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/p/orbit-survey"));
  });
});

describe("the focused download on a computer", () => {
  it("names the build before the one primary, then the details and the folded rest", async () => {
    const assign = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(
      routes(view([mac, macIntel, win, linux]), {
        "POST /api/releases/orbit-survey/rel_1.4.2/artifacts/mac/token": {
          status: 201,
          body: { url: "/download/tok" },
        },
      }),
    );
    const h1 = await open("#/p/orbit-survey/download");
    // One h1, the frame's, and focus lands on it once the page has loaded (§4.25 item 5).
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(h1));

    // The frame: breadcrumb, title, then the identity row that says who it is from, once.
    const crumb = screen.getByText(
      (_, el) => el?.textContent === "Orbit Survey / Download",
      { selector: "p" },
    );
    expect(follows(crumb, h1)).toBe(true);
    const identity = document.querySelector("[data-identity]") as HTMLElement;
    expect(follows(h1, identity)).toBe(true);
    expect(identity.textContent).toContain("From Parallax Nine");
    expect(identity.textContent).not.toContain("From Parallax Nine ·");
    expect(document.querySelector("[data-art][class*='h-24']")).toBeNull();

    // The build is named before the action: OS, architecture, file type and size.
    expect(buildLine()).toBe("macOS, Universal · .dmg · 84 MB");
    const primary = screen.getByRole("button", {
      name: "Download for macOS: Orbit Survey 1.4.2, Universal",
    });
    // The visible label is inside the accessible name (label in name), and it is 48 px tall.
    expect(primary.textContent).toBe("Download for macOS");
    expect(primary.className).toMatch(/\bh-12\b/);
    expect(follows(document.querySelector("[data-build]")!, primary)).toBe(
      true,
    );
    // One filled primary, and no desktop line: this is a computer.
    expect(
      document.querySelectorAll('button[data-variant="primary"]'),
    ).toHaveLength(1);
    expect(screen.queryByText("You're viewing desktop builds.")).toBeNull();

    // The details card: channel and day, the SHA-256 with its copy button, the install hint.
    const facts = document.querySelector("dl") as HTMLElement;
    expect(follows(primary, facts)).toBe(true);
    expect(
      within(facts).getByText("Channel").nextElementSibling?.textContent,
    ).toBe(`Stable · ${formatDay(PUBLISHED)}`);
    expect(within(facts).getByText("SHA-256")).toBeTruthy();
    expect(
      within(facts).getByRole("button", {
        name: "SHA-256 5be0c2…1f9a, show full value",
      }),
    ).toBeTruthy();
    const copy = within(facts).getByRole("button", { name: "Copy SHA-256" });
    expect(copy.textContent).toBe("Copy");
    expect(copy.className).toMatch(/\bh-9\b/);
    const hint = screen.getByText(
      "Open the .dmg and drag Orbit Survey to Applications.",
    );
    expect(facts.parentElement!.contains(hint)).toBe(true);
    expect(follows(facts, hint)).toBe(true);

    // The rest is folded, below the card, and says what is in it.
    const more = toggle();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(follows(facts, more)).toBe(true);
    expect(more.textContent).toContain("macOS Intel, Windows, Linux");
    expect(
      document.getElementById(more.getAttribute("aria-controls")!),
    ).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "Other platforms and architectures" }),
    ).toBeNull();

    // What the page used to say twice is gone: no fresh-links line, no bottom link.
    expect(screen.queryByText(/made fresh when you click/)).toBeNull();
    expect(
      screen.queryByRole("link", { name: /^Other platforms:/ }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /Everything about/ })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(primary);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/download/tok?p=orbit-survey"),
    );
  });

  it("opens the other builds: the platform's own first, then the others, each with its action", async () => {
    const assign = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    const lin = { ...linux, canDownload: false, reason: "not_hosted" as const };
    mockFetch(
      routes(
        view([mac, macIntel, win, winArm, lin], {
          stores: [
            storeLink({
              kind: "steam",
              label: "Steam",
              platforms: ["linux", "windows"],
            }),
          ],
        }),
        {
          "POST /api/releases/orbit-survey/rel_1.4.2/artifacts/win/token": {
            status: 201,
            body: { url: "/download/win" },
          },
        },
      ),
    );
    await open("#/p/orbit-survey/download?platform=macos");
    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const list = builds();
    expect(names(list)).toEqual([
      "macOS Intel",
      "Windows x64",
      "Windows Arm64",
      "Linux x86_64",
    ]);
    const rows = within(list).getAllByRole("listitem");
    // Each row: the platform glyph, the name, the muted file type and size, its action.
    expect(rows[0]!.querySelector("svg")).not.toBeNull();
    expect(rows[1]!.textContent).toContain(".exe · 70 MB");
    expect(
      within(rows[0]!).getByRole("button", {
        name: "Download Orbit Survey 1.4.2 for macOS Intel",
      }),
    ).toBeTruthy();
    const winDownload = within(rows[1]!).getByRole("button", {
      name: "Download Orbit Survey 1.4.2 for Windows x64",
    });
    expect(winDownload.textContent).toBe("Download");
    // A build the license doesn't cover says why, in words, and has no Download.
    expect(
      within(rows[2]!).getByText("Your license doesn't include this version"),
    ).toBeTruthy();
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    // A file this site doesn't host says where to get it, as Get it does.
    const steam = within(rows[3]!).getByRole("link", {
      name: /^Get it from Steam/,
    });
    expect(steam.getAttribute("href")).toBe("https://store.example/steam");
    expect(steam.getAttribute("target")).toBe("_blank");
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(winDownload);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/download/win?p=orbit-survey"),
    );

    // Closing it again hides the rows.
    await userEvent.click(toggle());
    await waitFor(() =>
      expect(
        screen.queryByRole("list", {
          name: "Other platforms and architectures",
        }),
      ).toBeNull(),
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("tells two builds that read alike apart by their file type", async () => {
    const deb = dlFile({
      artifactId: "deb",
      platform: "linux",
      arch: "x86_64",
      name: "orbit-survey_1.4.2_amd64.deb",
      sizeBytes: 71_000_000,
    });
    const rpm = {
      ...deb,
      artifactId: "rpm",
      name: "orbit-survey-1.4.2.x86_64.rpm",
      sizeBytes: 72_000_000,
    };
    mockFetch(routes(view([mac, deb, rpm])));
    await open("#/p/orbit-survey/download?platform=macos");
    await userEvent.click(toggle());
    expect(
      within(builds()).getByRole("button", {
        name: "Download Orbit Survey 1.4.2 for Linux x86_64 .deb",
      }),
    ).toBeTruthy();
    expect(
      within(builds()).getByRole("button", {
        name: "Download Orbit Survey 1.4.2 for Linux x86_64 .rpm",
      }),
    ).toBeTruthy();
  });

  it("keeps the stores and the other ways to install after the disclosure", async () => {
    mockFetch(
      routes({
        ...view([mac, win], {
          stores: [
            storeLink({ kind: "steam", label: "Steam", platforms: ["macos"] }),
          ],
        }),
        installSources: [
          installSource({
            kind: "homebrew",
            label: "Homebrew",
            command: "brew install --cask orbit-survey",
            platforms: ["macos"],
          }),
        ],
      }),
    );
    await open("#/p/orbit-survey/download?platform=macos");
    const more = toggle();
    const alsoOn = screen.getByText("Also on");
    const ways = screen.getByRole("heading", {
      level: 2,
      name: "Other ways to install",
    });
    expect(follows(more, alsoOn)).toBe(true);
    expect(follows(alsoOn, ways)).toBe(true);
    expect(screen.getByRole("link", { name: /Steam/ })).toBeTruthy();
    expect(
      within(
        screen.getByRole("list", { name: "Other ways to install on macOS" }),
      ).getByRole("button", { name: "Copy Homebrew command" }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("offers the asked platform's build, its stores and the other platforms", async () => {
    mockFetch(
      routes(
        view([linux, mac], {
          stores: [
            storeLink({
              kind: "steam",
              label: "Steam",
              platforms: ["linux", "windows"],
            }),
          ],
        }),
      ),
    );
    await open("#/p/orbit-survey/download?platform=linux");
    expect(buildLine()).toBe("Linux, x86_64 · .appimage · 90 MB");
    expect(
      screen.getByRole("button", {
        name: "Download for Linux: Orbit Survey 1.4.2, x86_64",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Steam/ })).toBeTruthy();
    expect(screen.getByText("Make it executable, then run it.")).toBeTruthy();
    expect(toggle().textContent).toContain("macOS");
    expect(await axeViolations()).toEqual([]);
  });

  it("starts from the OS in hand, whatever the Worker guessed", async () => {
    mockFetch(routes(view([win, mac], { recommend: "windows" })));
    await open("#/p/orbit-survey/download");
    expect(buildLine()).toContain("macOS, Universal");
  });
});

describe("the build line", () => {
  it.each([
    [
      "every part",
      { sizeBytes: 84_000_000, name: "Orbit.dmg" },
      "macOS, Universal · .dmg · 84 MB",
    ],
    [
      "no size",
      { sizeBytes: null, name: "Orbit.dmg" },
      "macOS, Universal · .dmg",
    ],
    [
      "no file type",
      { sizeBytes: 84_000_000, name: "Orbit" },
      "macOS, Universal · 84 MB",
    ],
    ["neither", { sizeBytes: null, name: "Orbit" }, "macOS, Universal"],
  ])("%s: never starts with a separator", async (_, file, expected) => {
    mockFetch(
      routes(view([dlFile({ artifactId: "mac", platform: "macos", ...file })])),
    );
    await open("#/p/orbit-survey/download");
    const line = buildLine();
    expect(line).toBe(expected);
    expect(line.startsWith("·")).toBe(false);
    expect(line.endsWith("·")).toBe(false);
    // The first separator rides on the label before it (a no-break space), so a wrap never
    // starts a line with one; what follows it is one no-wrap run.
    const raw = document.querySelector("[data-build]")!.textContent!;
    if (expected.includes("·")) expect(raw).toContain("Universal\u00a0· ");
    else expect(raw).not.toContain("\u00a0");
    for (const run of document.querySelectorAll(
      "[data-build] .whitespace-nowrap",
    ))
      expect(run.textContent).not.toMatch(/^\s*·/);
  });

  it("names the architecture the model names", async () => {
    mockFetch(
      routes(
        view([
          dlFile({
            artifactId: "mac-arm",
            platform: "macos",
            arch: "arm64",
            name: "Orbit-arm64.dmg",
            sizeBytes: 80_000_000,
          }),
          macIntel,
        ]),
      ),
    );
    await open("#/p/orbit-survey/download");
    expect(buildLine()).toBe("macOS, Apple silicon · .dmg · 80 MB");
  });
});

describe("the details card", () => {
  it("middle-truncates the SHA-256, shows it whole on request and copies it", async () => {
    mockFetch(routes(view([mac])));
    await open("#/p/orbit-survey/download");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const facts = document.querySelector("dl") as HTMLElement;
      // The row shows the truncated value only; the whole value waits in a popover.
      expect(facts.textContent).toContain("5be0c2…1f9a");
      expect(facts.textContent).not.toContain(SHA);
      await userEvent.click(
        within(facts).getByRole("button", {
          name: "SHA-256 5be0c2…1f9a, show full value",
        }),
      );
      expect(await screen.findByText(SHA)).toBeTruthy();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(
        within(facts).getByRole("button", { name: "Copy SHA-256" }),
      );
      expect(writeText).toHaveBeenCalledWith(SHA);
      await within(facts).findByText("Copied");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("capitalises the channel and gives no day for a release that isn't the newest", async () => {
    // The build is 1.4.0, an older release than the newest (1.4.2): the channel alone.
    const old = dlFile({
      artifactId: "mac-old",
      platform: "macos",
      releaseId: "rel_1.4.0",
      version: "1.4.0",
      name: "Orbit-Survey-1.4.0.dmg",
      sha256: SHA,
    });
    mockFetch(routes(view([old], { latest: false }, { channel: "beta" })));
    await open("#/p/orbit-survey/download", "Download Orbit Survey 1.4.0");
    expect(
      within(document.querySelector("dl") as HTMLElement).getByText("Channel")
        .nextElementSibling?.textContent,
    ).toBe("Beta");
  });

  it("leaves out the rows the view doesn't give, and the card when nothing is left", async () => {
    // No channel: no row for it; the SHA-256 stays.
    mockFetch(routes(view([mac], {}, { channel: "" })));
    await open("#/p/orbit-survey/download");
    expect(screen.queryByText("Channel")).toBeNull();
    expect(screen.getByText("SHA-256")).toBeTruthy();
    cleanup();

    // No SHA-256: no row, no copy button; the channel stays.
    mockFetch(routes(view([{ ...mac, sha256: null }])));
    go("#/p/orbit-survey/download");
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Download Orbit Survey 1.4.2",
    });
    expect(screen.getByText("Channel")).toBeTruthy();
    expect(screen.queryByText("SHA-256")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy SHA-256" })).toBeNull();
    cleanup();

    // Nothing to say: no channel, no SHA-256, a format with no hint (.bin): no card at all.
    mockFetch(
      routes(
        view(
          [dlFile({ artifactId: "mac", platform: "macos" })],
          {},
          { channel: "" },
        ),
      ),
    );
    go("#/p/orbit-survey/download");
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Download Orbit Survey 1.4.2",
    });
    expect(document.querySelector("dl")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Download for macOS/ }),
    ).toBeTruthy();
  });

  it("wraps long names instead of scrolling sideways", async () => {
    const long = "Orbit Survey Professional Edition for Field Teams";
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": product({ name: long }),
        "/api/products/orbit-survey/downloads": view([mac]),
      }),
    );
    await open("#/p/orbit-survey/download", `Download ${long} 1.4.2`);
    const hint = screen.getByText(
      `Open the .dmg and drag ${long} to Applications.`,
    );
    expect(hint.className).toMatch(/\[overflow-wrap:anywhere\]/);
    expect(document.querySelector("[data-build] span")!.className).toMatch(
      /\[overflow-wrap:anywhere\]/,
    );
  });
});

describe("the focused download on a phone", () => {
  it("says it is showing desktop builds and offers to email the download, never to download it", async () => {
    asUA(IPHONE_UA);
    const posted: unknown[] = [];
    mockFetch(
      routes(view([mac, win, linux]), {
        "POST /api/products/orbit-survey/email-download": (
          init: RequestInit | undefined,
        ) => {
          posted.push(JSON.parse(String(init?.body)));
          return { ok: true };
        },
      }),
    );
    // The phone has nothing of its own: the first desktop platform with a covered file.
    await open("#/p/orbit-survey/download");
    const line = screen.getByText("You're viewing desktop builds.");
    expect(line.querySelector("svg")).not.toBeNull();
    expect(follows(screen.getByRole("heading", { level: 1 }), line)).toBe(true);
    expect(follows(line, document.querySelector("[data-build]")!)).toBe(true);
    expect(buildLine()).toBe("macOS, Universal · .dmg · 84 MB");

    const email = screen.getByRole("button", {
      name: "Email me the download: Orbit Survey for macOS",
    });
    expect(email.textContent).toBe("Email me the download");
    expect(email.className).toMatch(/\bh-12\b/);
    expect(email.querySelector("svg")).not.toBeNull();
    // The only primary, and no Download for a desktop build anywhere.
    expect(
      document.querySelectorAll('button[data-variant="primary"]'),
    ).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /^Download/ })).toEqual([]);
    // The details card is there all the same.
    expect(screen.getByText("SHA-256")).toBeTruthy();
    expect(screen.getByText("Channel")).toBeTruthy();
    await userEvent.click(toggle());
    expect(screen.queryAllByRole("button", { name: /^Download/ })).toEqual([]);
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(email);
    await waitFor(() => expect(posted).toEqual([{ platform: "macos" }]));
    expect(fetchedRequests()).toContain(
      "POST /api/products/orbit-survey/email-download",
    );
    expect(
      await screen.findByText(
        "We sent you the link to download Orbit Survey for macOS.",
      ),
    ).toBeTruthy();
  });

  it("says when the email didn't go out", async () => {
    asUA(IPHONE_UA);
    mockFetch(
      routes(view([win]), {
        "POST /api/products/orbit-survey/email-download": {
          status: 500,
          body: { error: "internal" },
        },
      }),
    );
    await open("#/p/orbit-survey/download?platform=windows");
    expect(
      screen.getByRole("button", {
        name: "Email me the download: Orbit Survey for Windows",
      }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /^Email me the download/ }),
    );
    expect(await screen.findByText("The email didn't go out")).toBeTruthy();
  });

  it("lists the other platforms as links that show that platform in place, keeping return=", async () => {
    asUA(IPHONE_UA);
    const posted: unknown[] = [];
    mockFetch(
      routes(view([mac, macIntel, win, winArm, linux]), {
        "POST /api/products/orbit-survey/email-download": (
          init: RequestInit | undefined,
        ) => {
          posted.push(JSON.parse(String(init?.body)));
          return { ok: true };
        },
      }),
    );
    await open(
      "#/p/orbit-survey/download?platform=macos&return=orbitsurvey%3A%2F%2Fretry",
    );
    // A phone can't pick an architecture: no other macOS build, each other platform once.
    expect(toggle().textContent).toContain("Windows, Linux");
    await userEvent.click(toggle());
    const list = builds();
    expect(names(list)).toEqual(["Windows x64", "Linux x86_64"]);
    expect(within(list).queryAllByRole("button")).toEqual([]);
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/p/orbit-survey/download?platform=windows&return=orbitsurvey%3A%2F%2Fretry",
      "#/p/orbit-survey/download?platform=linux&return=orbitsurvey%3A%2F%2Fretry",
    ]);
    expect(links[0]!.textContent).toContain(".exe · 70 MB");
    expect(screen.queryAllByRole("button", { name: /^Download/ })).toEqual([]);

    // Following one shows that platform in place: the same page, now about Windows.
    await userEvent.click(links[0]!);
    expect(
      await screen.findByRole("button", {
        name: "Email me the download: Orbit Survey for Windows",
      }),
    ).toBeTruthy();
    expect(buildLine()).toBe("Windows, x64 · .exe · 70 MB");
    expect(screen.getByText("You're viewing desktop builds.")).toBeTruthy();
    expect(window.location.hash).toBe(
      "#/p/orbit-survey/download?platform=windows&return=orbitsurvey%3A%2F%2Fretry",
    );
    // The disclosure folds again, and focus goes to the build line, the next stop the primary.
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector("[data-build]"),
      ),
    );
    // The back link still goes to the app the product declared.
    expect(
      screen
        .getByRole("link", { name: "Back to Orbit Survey" })
        .getAttribute("href"),
    ).toBe("orbitsurvey://retry");
    await userEvent.click(
      screen.getByRole("button", { name: /^Email me the download/ }),
    );
    await waitFor(() => expect(posted).toEqual([{ platform: "windows" }]));
    expect(screen.queryAllByRole("button", { name: /^Download/ })).toEqual([]);
  });

  it("drops an undeclared return= from the links as well", async () => {
    asUA(IPHONE_UA);
    mockFetch(routes(view([mac, win])));
    await open(
      "#/p/orbit-survey/download?platform=macos&return=https%3A%2F%2Fevil.example%2Fsteal",
    );
    await userEvent.click(toggle());
    expect(within(builds()).getByRole("link").getAttribute("href")).toBe(
      "#/p/orbit-survey/download?platform=windows",
    );
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("a phone with a build of its own gets its Download, and no desktop line", async () => {
    asUA(ANDROID_UA);
    const assign = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(
      routes(view([apk, mac, win]), {
        "POST /api/releases/orbit-survey/rel_1.4.2/artifacts/apk/token": {
          status: 201,
          body: { url: "/download/apk" },
        },
      }),
    );
    await open("#/p/orbit-survey/download");
    expect(buildLine()).toBe("Android, Universal · .apk · 40 MB");
    const primary = screen.getByRole("button", {
      name: "Download for Android: Orbit Survey 1.4.2, Universal",
    });
    expect(primary.className).toMatch(/\bh-12\b/);
    expect(screen.queryByText("You're viewing desktop builds.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Email me/ })).toBeNull();
    expect(
      screen.getByText("Open the .apk on your Android device to install it."),
    ).toBeTruthy();
    // The desktop builds are not downloaded from here.
    await userEvent.click(toggle());
    expect(names(builds())).toEqual(["Windows x64", "macOS Universal"]);
    expect(within(builds()).queryAllByRole("button")).toEqual([]);
    expect(
      screen
        .queryAllByRole("button", { name: /^Download/ })
        .map((b) => b.textContent),
    ).toEqual(["Download for Android"]);
    await userEvent.click(primary);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/download/apk?p=orbit-survey"),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("a phone lists the other builds of its own OS in full, each with its Download", async () => {
    asUA(ANDROID_UA);
    const apkX86 = dlFile({
      artifactId: "apk-x86",
      platform: "android",
      arch: "x86_64",
      name: "Orbit-Survey-1.4.2-x86_64.apk",
      sizeBytes: 42_000_000,
    });
    const apkArm = dlFile({
      artifactId: "apk-arm",
      platform: "android",
      arch: "arm64",
      name: "Orbit-Survey-1.4.2-arm64.apk",
      sizeBytes: 38_000_000,
    });
    mockFetch(routes(view([apkArm, apkX86, win])));
    await open("#/p/orbit-survey/download");
    expect(buildLine()).toBe("Android, ARM64 · .apk · 38 MB");
    await userEvent.click(toggle());
    // Its own OS's other build is a Download; the desktop build is a link to show it.
    expect(names(builds())).toEqual(["Android x86_64", "Windows x64"]);
    expect(
      within(builds()).getByRole("button", {
        name: "Download Orbit Survey 1.4.2 for Android x86_64",
      }),
    ).toBeTruthy();
    expect(within(builds()).getAllByRole("link")).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /for Windows/ })).toEqual(
      [],
    );
  });

  it("a phone asked for a desktop build whose license doesn't cover it has no action", async () => {
    asUA(IPHONE_UA);
    mockFetch(
      routes(
        view([{ ...win, canDownload: false, reason: "not_entitled" }, mac]),
      ),
    );
    await open(
      "#/p/orbit-survey/download?platform=windows",
      "Download Orbit Survey",
    );
    expect(
      screen.getByText("Your license doesn't include this version."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^(Email|Download)/ }),
    ).toBeNull();
    expect(screen.queryByText("You're viewing desktop builds.")).toBeNull();
  });
});

describe("when the license doesn't cover the platform", () => {
  it("says why when the platform has nothing covered", async () => {
    mockFetch(
      routes(
        view([
          dlFile({
            artifactId: "win",
            platform: "windows",
            canDownload: false,
            reason: "not_entitled",
          }),
          mac,
        ]),
      ),
    );
    await open(
      "#/p/orbit-survey/download?platform=windows",
      "Download Orbit Survey",
    );
    expect(
      screen.getByText("Your license doesn't include this version."),
    ).toBeTruthy();
    // No build line, no primary, no details card.
    expect(document.querySelector("[data-build]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(document.querySelector('button[data-variant="primary"]')).toBeNull();
    expect(document.querySelector("dl")).toBeNull();
    // The other platforms are still one disclosure away.
    expect(toggle().textContent).toContain("macOS");
    await userEvent.click(toggle());
    expect(names(builds())).toEqual(["macOS Universal"]);
    expect(
      within(builds()).getByRole("button", {
        name: "Download Orbit Survey 1.4.2 for macOS Universal",
      }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("lists the asked platform's other ways to install, and points to them when it has no file (P0-48)", async () => {
    const withSources: PortalDownloads = {
      ...view([mac, linux]),
      installSources: [
        installSource({
          kind: "homebrew",
          label: "Homebrew",
          command: "brew install --cask orbit-survey",
          platforms: ["macos"],
        }),
        installSource({
          kind: "fdroid",
          label: "Add to F-Droid",
          url: "https://k.example/orbit-survey/distribution/fdroid/stable/repo",
          deepLink:
            "fdroidrepos://k.example/orbit-survey/distribution/fdroid/stable/repo",
          platforms: ["android"],
        }),
      ],
    };
    mockFetch(routes(withSources));
    await open("#/p/orbit-survey/download?platform=macos");
    const macList = screen.getByRole("list", {
      name: "Other ways to install on macOS",
    });
    expect(
      within(macList).getByRole("button", { name: "Copy Homebrew command" }),
    ).toBeTruthy();
    expect(screen.queryByText("F-Droid")).toBeNull();
    expect(await axeViolations()).toEqual([]);
    cleanup();

    go("#/p/orbit-survey/download?platform=android");
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Download Orbit Survey",
    });
    expect(
      screen.getByText(
        /has no download for Android here\. Other ways to install it are below\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Add to F-Droid" }).getAttribute("href"),
    ).toBe(
      "fdroidrepos://k.example/orbit-survey/distribution/fdroid/stable/repo",
    );
    expect(document.querySelector("[data-build]")).toBeNull();
    expect(document.querySelector("dl")).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("points to a store when the platform is only there", async () => {
    mockFetch(
      routes(
        view([mac], {
          stores: [
            storeLink({
              kind: "steam",
              label: "Steam",
              platforms: ["windows"],
            }),
          ],
        }),
      ),
    );
    await open(
      "#/p/orbit-survey/download?platform=windows",
      "Download Orbit Survey",
    );
    expect(
      screen.getByText(
        /has no download for Windows here\. It's available in a store below\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Steam/ })).toBeTruthy();
  });

  it("says the license's last covered version is not the newest one", async () => {
    // The Worker lists a platform's files from the newest release (not covered here) and keeps
    // the older covered release's files in the recommendation.
    const newest = {
      ...mac,
      canDownload: false,
      reason: "not_entitled" as const,
    };
    const older = dlFile({
      artifactId: "mac-old",
      platform: "macos",
      releaseId: "rel_1.3.9",
      version: "1.3.9",
      name: "Orbit-Survey-1.3.9.dmg",
      sizeBytes: 82_000_000,
      sha256: SHA,
    });
    const v = view([older], { latest: false });
    v.platforms[0]!.files = [newest];
    const assign = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(
      routes(v, {
        "POST /api/releases/orbit-survey/rel_1.3.9/artifacts/mac-old/token": {
          status: 201,
          body: { url: "/download/old" },
        },
      }),
    );
    await open("#/p/orbit-survey/download", "Download Orbit Survey 1.3.9");
    const note = screen.getByText(
      "This is the last version your license covers. Version 1.4.2 isn't included.",
    );
    // Right under the title, before the build.
    expect(follows(screen.getByRole("heading", { level: 1 }), note)).toBe(true);
    expect(follows(note, document.querySelector("[data-build]")!)).toBe(true);
    expect(buildLine()).toBe("macOS, Universal · .dmg · 82 MB");
    // The older release's own build, not the newest's; and no day, it isn't the channel's newest.
    expect(
      within(document.querySelector("dl") as HTMLElement).getByText("Channel")
        .nextElementSibling?.textContent,
    ).toBe("Stable");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Download for macOS: Orbit Survey 1.3.9, Universal",
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/download/old?p=orbit-survey"),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps only the covered release's rows when the files of two releases are listed", async () => {
    const newest = {
      ...mac,
      artifactId: "mac-new",
      canDownload: false,
      reason: "not_entitled" as const,
    };
    const older = dlFile({
      artifactId: "mac-old",
      platform: "macos",
      releaseId: "rel_1.3.9",
      version: "1.3.9",
      name: "Orbit-Survey-1.3.9.dmg",
    });
    mockFetch(routes(view([newest, older], { latest: false })));
    await open("#/p/orbit-survey/download", "Download Orbit Survey 1.3.9");
    expect(
      screen.getByText(/This is the last version your license covers/),
    ).toBeTruthy();
    // The newest release's refused build is history: it is not offered as a row.
    expect(
      screen.queryByText(/Your license doesn't include this version/),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Other platforms/ }),
    ).toBeNull();
  });

  it("has no last-covered note when the newest release is covered", async () => {
    mockFetch(routes(view([mac])));
    await open("#/p/orbit-survey/download");
    expect(screen.queryByText(/last version your license covers/)).toBeNull();
  });
});

describe("the return link", () => {
  it("never follows an undeclared return URL: the way back is the product page", async () => {
    mockFetch(routes(view([mac])));
    await open(
      "#/p/orbit-survey/download?platform=macos&return=https%3A%2F%2Fevil.example%2Fsteal",
    );
    const back = screen.getByRole("link", {
      name: "See Orbit Survey in your library",
    });
    expect(back.getAttribute("href")).toBe("#/p/orbit-survey");
    expect(
      screen.queryByRole("link", { name: /Back to Orbit Survey/ }),
    ).toBeNull();
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it.each([
    ["https://orbit.example/play", "https%3A%2F%2Forbit.example%2Fplay"],
    ["orbitsurvey://retry", "orbitsurvey%3A%2F%2Fretry"],
  ])(
    "goes back to the app when the product declares the return URL (%s)",
    async (url, encoded) => {
      mockFetch(routes(view([mac])));
      await open(`#/p/orbit-survey/download?platform=macos&return=${encoded}`);
      expect(
        screen
          .getByRole("link", { name: "Back to Orbit Survey" })
          .getAttribute("href"),
      ).toBe(url);
    },
  );
});

describe("loading, not found and errors", () => {
  it("holds the frame's place while the downloads load", async () => {
    mockFetch(
      routes(view([mac]), {
        // A request that never answers (`Promise.withResolvers` is outside this package's `lib`).
        "/api/products/orbit-survey/downloads": () =>
          new Promise(() => undefined),
      }),
    );
    go("#/p/orbit-survey/download");
    renderPortal();
    const loading = await screen.findByRole("heading", {
      level: 1,
      name: "Loading…",
    });
    expect(loading.closest("[aria-busy]")).not.toBeNull();
    // The placeholder's h1 is the only one, and focus waits for the real heading.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.activeElement).not.toBe(loading);
  });

  it("a product not in the library is the not-found page, inside the flow", async () => {
    mockFetch(signedIn([orbit]));
    go("#/p/nope/download");
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "That product isn't in your library",
      }),
    ).toBeTruthy();
  });

  it("a failed load is an error page with Try again", async () => {
    mockFetch(
      routes(view([mac]), {
        "/api/products/orbit-survey/downloads": {
          status: 500,
          body: { error: "internal" },
        },
      }),
    );
    go("#/p/orbit-survey/download");
    renderPortal();
    const alert = await screen.findByRole("alert");
    // The product's name stays the h1, and the panel says what failed, once.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "Orbit Survey" }),
    ).toBeTruthy();
    expect(within(alert).getByText("Couldn't load Orbit Survey.")).toBeTruthy();
    expect(alert.textContent).not.toMatch(/Something went wrong/);
    expect(
      within(alert).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    expect(
      within(alert).getByRole("link", { name: "Orbit Survey" }),
    ).toBeTruthy();
  });

  it("a Worker with no downloads view says the product has no download here", async () => {
    mockFetch(
      routes(view([mac]), {
        "/api/products/orbit-survey/downloads": { status: 404, body: {} },
      }),
    );
    await open("#/p/orbit-survey/download", "Download Orbit Survey");
    expect(screen.getByText("Orbit Survey has no download here.")).toBeTruthy();
    expect(document.querySelector("[data-build]")).toBeNull();
  });
});

describe("the platform the page is about", () => {
  const files = (...f: PortalDownloadFile[]): PortalDownloads =>
    view(f, { recommend: null });

  it("follows ?platform= over everything", () => {
    asUA(MAC_UA);
    expect(flowPlatform("windows", files(mac))).toBe("windows");
    asUA(IPHONE_UA);
    expect(flowPlatform("linux", files(mac))).toBe("linux");
  });

  it("is the OS in hand on a computer, else the Worker's guess", () => {
    asUA(MAC_UA);
    expect(flowPlatform(null, view([win], { recommend: "windows" }))).toBe(
      "macos",
    );
    asUA("");
    expect(flowPlatform(null, view([win], { recommend: "windows" }))).toBe(
      "windows",
    );
    expect(
      flowPlatform("nonsense", view([win], { recommend: "windows" })),
    ).toBe("windows");
    expect(flowPlatform(null, files(win))).toBeNull();
  });

  it("on a phone is its own OS when it has a covered file or a live store for it", () => {
    asUA(ANDROID_UA);
    expect(flowPlatform(null, files(win, apk, mac))).toBe("android");
    // A store with a page counts; a store that isn't live, or has no page, does not.
    const play = { kind: "play", label: "Google Play", platforms: ["android"] };
    for (const [store, expected] of [
      [storeLink(play), "android"],
      [storeLink({ ...play, live: false }), "macos"],
      [storeLink({ ...play, url: null }), "macos"],
    ] as const)
      expect(flowPlatform(null, view([mac], { stores: [store] }))).toBe(
        expected,
      );
    asUA(IPHONE_UA);
    const appStore = storeLink({
      kind: "apple",
      label: "App Store",
      platforms: ["ios"],
    });
    expect(flowPlatform(null, view([mac], { stores: [appStore] }))).toBe("ios");
  });

  it("on a phone with nothing of its own is the first desktop platform with a covered file", () => {
    asUA(IPHONE_UA);
    expect(flowPlatform(null, files(linux, win, mac))).toBe("macos");
    expect(flowPlatform(null, files(linux, win))).toBe("windows");
    expect(flowPlatform(null, files(linux))).toBe("linux");
    // A file the license doesn't cover is not a covered file.
    expect(
      flowPlatform(
        null,
        files({ ...mac, canDownload: false, reason: "not_entitled" }, linux),
      ),
    ).toBe("linux");
    // Nothing covered at all: the Worker's guess.
    expect(
      flowPlatform(
        null,
        view([{ ...mac, canDownload: false, reason: "not_entitled" }], {
          recommend: "linux",
        }),
      ),
    ).toBe("linux");
  });
});

describe("the install hint", () => {
  it.each([
    ["dmg", "Open the .dmg and drag Orbit Survey to Applications."],
    [".dmg", "Open the .dmg and drag Orbit Survey to Applications."],
    ["DMG", "Open the .dmg and drag Orbit Survey to Applications."],
    ["pkg", "Open the .pkg and follow the installer."],
    ["exe", "Run the installer and follow the steps."],
    ["msi", "Run the installer and follow the steps."],
    ["msix", "Run the installer and follow the steps."],
    ["zip", "Unzip it and open Orbit Survey."],
    ["tar.gz", "Unzip it and open Orbit Survey."],
    ["appimage", "Make it executable, then run it."],
    ["AppImage", "Make it executable, then run it."],
    ["deb", "Install it with your package manager."],
    ["rpm", "Install it with your package manager."],
    ["apk", "Open the .apk on your Android device to install it."],
    ["flatpak", "Install it with Flatpak."],
    ["ipa", null],
    ["bin", null],
    ["", null],
    [null, null],
  ])("%s → %s", (format, hint) => {
    expect(installHint(format, "Orbit Survey")).toBe(hint);
  });

  it("reads the format from the file name", () => {
    expect(fileFormat("Orbit-Survey-1.4.2.dmg")).toBe("dmg");
    expect(fileFormat("Orbit-Survey-1.4.2.AppImage")).toBe("appimage");
    expect(fileFormat("orbit-1.4.2.tar.gz")).toBe("tar.gz");
    expect(fileFormat("orbit_1.4.2_amd64.deb")).toBe("deb");
    // A version after a dot is not a file type.
    expect(fileFormat("orbit-1.4.2")).toBeNull();
    expect(fileFormat("Orbit Survey")).toBeNull();
    expect(fileSource({ name: "a.dmg", sizeBytes: 84_000_000 })).toBe(
      ".dmg · 84 MB",
    );
    expect(fileSource({ name: "a.dmg", sizeBytes: null })).toBe(".dmg");
    expect(fileSource({ name: "a", sizeBytes: 3_100_000_000 })).toBe("3.1 GB");
    expect(fileSource({ name: "a", sizeBytes: null })).toBeNull();
  });
});
