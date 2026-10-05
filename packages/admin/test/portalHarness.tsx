/**
 * The customer site's test harness: a fetch mock keyed by path, today's API fixtures and a
 * render helper. Fixture names are invented (PORTAL.md's mockup cast).
 */
import { vi } from "vitest";
import { render, type RenderResult } from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import type {
  PortalArtifact,
  PortalCapabilities,
  PortalDevice,
  PortalDownloadFile,
  PortalDownloads,
  PortalLibraryItem,
  PortalStoreLink,
  PortalLicenseDetail,
  PortalStatus,
  PortalLicenseSummary,
  PortalRelease,
} from "../src/portal/api.js";
import { PortalApp } from "../src/portal/App.js";

export type MockRoute =
  | unknown
  | { status: number; body?: unknown }
  | ((init: RequestInit | undefined, url: string) => unknown);

function isMockResponse(
  route: unknown,
): route is { status: number; body?: unknown } {
  return (
    route != null &&
    typeof route === "object" &&
    "status" in route &&
    typeof (route as { status: unknown }).status === "number"
  );
}

/** Routes keyed by `"/path"` (any method) or `"METHOD /path"`. `"/path?query"` matches exactly. */
export function mockFetch(routes: Record<string, MockRoute>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const full = url.replace("http://localhost", "");
      const path = full.split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      let route =
        routes[`${method} ${full}`] ??
        routes[full] ??
        routes[`${method} ${path}`] ??
        routes[path];
      if (route === "network") throw new TypeError("Failed to fetch");
      if (typeof route === "function") route = route(init, full);
      if (route === undefined)
        route = { status: 404, body: { error: "not_found" } };
      const status = isMockResponse(route) ? route.status : 200;
      const body = isMockResponse(route) ? route.body : route;
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** Every request so far, as `"METHOD /path?query"`. */
export function fetchedRequests(): string[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return `${(init?.method ?? "GET").toUpperCase()} ${url.replace("http://localhost", "")}`;
  });
}

export const ACCOUNT = {
  id: "acct_1",
  name: "Mara Fennick",
  email: "mara@fennick.studio",
};

export const NOW_S = Math.floor(Date.now() / 1000);
export const DAY = 86_400;

export function license(
  over: Partial<PortalLicenseSummary> & { product: string },
): PortalLicenseSummary {
  return {
    id: `lic_${over.product}`,
    productName: over.product[0]!.toUpperCase() + over.product.slice(1),
    name: ACCOUNT.name,
    email: ACCOUNT.email,
    status: "active",
    tier: null,
    activatedAt: NOW_S - 30 * DAY,
    expiresAt: null,
    maxOfflineDays: null,
    channels: [],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    usable: true,
    keyCount: 1,
    activeKeyCount: 1,
    deviceCount: 1,
    entitlements: [],
    ...over,
  };
}

export function device(over: Partial<PortalDevice> = {}): PortalDevice {
  return {
    deviceId: "dev_1",
    status: "authorized",
    firstSeen: NOW_S - 20 * DAY,
    lastSeen: NOW_S - 2 * 3600,
    label: "Mara's MacBook Pro",
    platform: "macos",
    arch: "arm64",
    appVersion: "1.4.2",
    sdkName: "polaris-key-godot",
    sdkVersion: "1.0.0",
    ua: null,
    ...over,
  };
}

export function detail(
  summary: PortalLicenseSummary,
  over: Partial<PortalLicenseDetail> = {},
): PortalLicenseDetail {
  return {
    ...summary,
    keys: [
      {
        hash: "h1",
        status: "active",
        label: null,
        createdAt: summary.activatedAt,
        lastUsedAt: null,
      },
    ],
    devices: [device()],
    ...over,
  };
}

export function artifact(
  over: Partial<PortalArtifact> & { artifactId: string; name: string },
): PortalArtifact {
  return {
    kind: "archive",
    platform: null,
    arch: null,
    sizeBytes: 2_100_000_000,
    sha256: "5b0e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8fd913",
    access: "licensed",
    canDownload: true,
    ...over,
  };
}

export function release(
  over: Partial<PortalRelease> & { product: string; version: string },
): PortalRelease {
  return {
    productName: over.product,
    releaseId: `rel_${over.version}`,
    title: null,
    notes: null,
    publishedAt: NOW_S - 5 * DAY,
    sourceUrl: null,
    artifacts: [],
    ...over,
  };
}

/**
 * The Worker's library item for a licence (`GET /api/library`, PX-W1), with the Worker's status
 * precedence (`library.ts` `licenseStatus`): suspended, expired, device limit, expires within 14
 * days, active. `deviceLimit` 0 = the fixture says nothing about seats.
 */
export function libraryItem(
  l: PortalLicenseSummary,
  over: Partial<PortalLibraryItem> & { deviceLimit?: number } = {},
): PortalLibraryItem {
  const { deviceLimit = 0, ...rest } = over;
  const status: PortalStatus =
    l.status !== "active"
      ? "suspended"
      : l.expiresAt !== null && NOW_S > l.expiresAt
        ? "expired"
        : deviceLimit > 0 && l.deviceCount >= deviceLimit
          ? "device_limit"
          : l.expiresAt !== null && l.expiresAt - NOW_S <= 14 * DAY
            ? "expires_soon"
            : "active";
  const b =
    l.productBranding && typeof l.productBranding === "object"
      ? (l.productBranding as Record<string, string | undefined>)
      : {};
  return {
    product: l.product,
    name: l.productName,
    developerName: b.developerName ?? null,
    tintColor: b.tintColor ?? null,
    website: b.website ?? null,
    iconUrl: null,
    headerUrl: null,
    support:
      b.supportUrl || b.supportEmail
        ? { url: b.supportUrl ?? null, email: b.supportEmail ?? null }
        : null,
    status,
    license: {
      id: l.id,
      tier: l.tier,
      status,
      licenseStatus: l.status,
      activatedAt: l.activatedAt,
      expiresAt: l.expiresAt,
      maxOfflineDays: l.maxOfflineDays,
      deviceLimit,
      activeSeatCount: l.deviceCount,
      deviceCount: l.deviceCount,
      dormantCount: 0,
    },
    licenseCount: 1,
    addedAt: l.activatedAt,
    ...rest,
  };
}

/** `GET /api/library` for these licences: one item per product, its newest licence first. */
export function libraryFor(
  licenses: readonly PortalLicenseSummary[],
  discoverCount?: number,
): { products: PortalLibraryItem[]; discoverCount?: number } {
  const best = new Map<string, PortalLicenseSummary>();
  for (const l of licenses) {
    const cur = best.get(l.product);
    if (!cur || l.activatedAt > cur.activatedAt) best.set(l.product, l);
  }
  return {
    products: [...best.values()]
      .sort((a, b) => b.activatedAt - a.activatedAt)
      .map((l) => ({
        ...libraryItem(l),
        licenseCount: licenses.filter((x) => x.product === l.product).length,
      })),
    ...(discoverCount === undefined ? {} : { discoverCount }),
  };
}

/** One file of a downloads view (PX-W2). */
export function dlFile(
  over: Partial<PortalDownloadFile> & {
    artifactId: string;
    platform: string | null;
  },
): PortalDownloadFile {
  return {
    releaseId: "rel_1.4.2",
    version: "1.4.2",
    name: `${over.artifactId}.bin`,
    buildId: null,
    arch: "universal",
    format: null,
    role: over.platform ? "payload" : null,
    sizeBytes: 2_100_000_000,
    sha256: null,
    minOs: null,
    canDownload: true,
    reason: null,
    ...over,
  };
}

export function storeLink(
  over: Partial<PortalStoreLink> & { kind: string; label: string },
): PortalStoreLink {
  return {
    id: `${over.kind}:main`,
    outletId: "main",
    platforms: [],
    url: `https://store.example/${over.kind}`,
    deepLink: null,
    command: null,
    activateUrl: null,
    live: true,
    version: "1.4.2",
    ...over,
  };
}

/** A downloads view for `slug` whose files are `files`, recommending `recommend` (a platform). */
export function downloadsView(
  slug: string,
  files: PortalDownloadFile[],
  opts: {
    recommend?: string | null;
    latest?: boolean;
    stores?: PortalStoreLink[];
  } = {},
): PortalDownloads {
  const platforms = [...new Set(files.map((f) => f.platform))].filter(
    (p): p is string => p !== null,
  );
  const rec = (platform: string) => {
    const own = files.filter((f) => f.platform === platform && f.canDownload);
    if (own.length === 0) return null;
    return {
      platform,
      label: platform,
      releaseId: own[0]!.releaseId,
      version: own[0]!.version,
      universal: own.length === 1 && own[0]!.arch === "universal",
      latest: opts.latest ?? true,
      files: own,
    };
  };
  const recommend = opts.recommend === undefined ? "macos" : opts.recommend;
  return {
    product: { slug, name: slug },
    channel: "stable",
    available: true,
    access: "licensed",
    detected: { platform: recommend, arch: null, touchAmbiguous: false },
    latest: {
      releaseId: "rel_latest",
      version: "2.0",
      title: null,
      publishedAt: NOW_S - DAY,
    },
    recommended: recommend ? rec(recommend) : null,
    platforms: platforms.map((p) => ({
      platform: p,
      label: p,
      recommended: rec(p),
      files: files.filter((f) => f.platform === p),
    })),
    extras: files.filter((f) => f.platform === null),
    stores: opts.stores ?? [],
  };
}

export const CAPS_ALL: PortalCapabilities = {
  auth: { oidc: true, magic: true },
  modules: { licensing: true, claim: true, releases: true },
};

export function signedIn(
  licenses: PortalLicenseSummary[] = [],
  extra: Record<string, MockRoute> = {},
  caps: PortalCapabilities = CAPS_ALL,
): Record<string, MockRoute> {
  return {
    "/api/me": { account: ACCOUNT, csrf: "csrf-token" },
    "/api/capabilities": caps,
    "/api/licenses": { licenses },
    "/api/library": libraryFor(licenses),
    "/api/releases": { releases: [] },
    ...extra,
  };
}

export function renderPortal(): RenderResult {
  return render(<PortalApp />);
}

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

/** axe over the whole document, as "rule: targets" lines (empty when clean). */
export async function axeViolations(): Promise<string[]> {
  const results = await axe(document.body);
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

// jsdom has no ResizeObserver; cmdk and Radix's size hooks need one.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
// cmdk scrolls the selected item into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
