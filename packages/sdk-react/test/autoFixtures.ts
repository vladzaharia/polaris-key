// What the automatic sign-in suites share: a consent view, license lists and small browser stubs.

export const CONSENT = {
  client: {
    appName: "Tidewater Studio",
    developerName: null,
    iconUrl: null,
    nameVerified: true,
  },
  as: { provider: "google", email: "maya@example.com" },
  items: [
    {
      kind: "license",
      anchor: {
        name: "Pro",
        tierName: "Pro",
        term: "perpetual",
        seat: { position: 2, limit: 3 },
      },
      more: 0,
    },
    { kind: "profile", claims: ["email", "name"] },
  ],
  scopeHash: "0".repeat(64),
  firstTime: true,
  changed: false,
} as never;

export const VIEW_FULL = {
  state: "all-full",
  preselected: null,
  choices: [
    {
      id: "lic_pro",
      tierName: "Pro",
      origin: "signin",
      state: "full",
      expiresAt: null,
      seats: { used: 3, limit: 3 },
    },
  ],
} as never;

export const VIEW_FREE = {
  state: "many",
  preselected: "lic_pro",
  choices: [
    {
      id: "lic_pro",
      tierName: "Pro",
      origin: "signin",
      state: "free",
      expiresAt: null,
      seats: { used: 1, limit: 3 },
    },
  ],
} as never;

import { vi } from "vitest";
import type { AutoSignInResult } from "../src/core/index.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Draws `node` in a fresh host on the page and returns the host. */
export function renderInto(node: ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(node);
  return host;
}

/** The function that removes what `renderInto` drew. */
export function hostCleanup(): () => void {
  return () => {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  };
}

export const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));

/** Loads the brand fonts and waits for them (the browser scenes draw with them). */
export async function loadFonts(): Promise<void> {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../brand/fonts/fonts.css", import.meta.url).href;
  document.head.append(link);
  await new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
}

/** A ResizeObserver that observes nothing (jsdom has none). */
export function stubResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
}

/** A desktop adapter whose ladder answers `result` and whose license list is the full one. */
export function fakeAdapter(result: AutoSignInResult) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(emptyBridgeState()),
    now: () => NOW_SEC,
  });
  Object.assign(adapter, {
    autoSignIn: vi.fn(async () => result),
    choice: {
      licenses: async () => ({ kind: "ok", view: VIEW_FULL }),
      devices: async () => ({ kind: "ok", view: {} }),
      complete: async () => ({ kind: "ok", licenseId: null }),
      cancel: async () => ({ kind: "ok" }),
    },
  });
  return adapter;
}
