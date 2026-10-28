// What the automatic sign-in suites share: a fake browser client whose ladder answers a given
// result, and a consent view.

import { vi } from "vitest";

export function fakeClient(
  result: unknown,
  over: Record<string, unknown> = {},
) {
  const caps = (on: boolean) => ({ enabled: on });
  const state = {
    phase: "ready",
    mode: "bearer",
    gate: { status: "needs-activation" },
    status: "needs-activation",
    activation: null,
    highWaterMark: 0,
    capabilities: {
      license: caps(true),
      config: caps(false),
      release: caps(false),
      update: caps(false),
      identity: caps(true),
    },
    profile: null,
    config: {},
    entitlements: {},
    busy: {},
    error: {},
  };
  const autoSignIn = vi.fn(async () => result);
  const adapter = {
    snapshot: () => state,
    subscribe: () => () => {},
    start: () => {},
    dispose: () => {},
    supports: () => ({ supported: true }),
    presentationSource: () => null,
    signInWithOidc: vi.fn(async () => undefined),
    submitKey: vi.fn(async () => {}),
    checkUpdate: async () => ({ updateAvailable: false }),
    autoSignIn,
    choice: {
      licenses: async () => ({ kind: "ok", view: {} }),
      devices: async () => ({ kind: "ok", view: {} }),
      complete: vi.fn(async () => ({ kind: "ok", licenseId: null })),
      cancel: vi.fn(async () => ({ kind: "ok" })),
    },
    ...over,
  };
  return { adapter, autoSignIn };
}

/** What the ladder's confirm carries: the account, one license line (seat 2 of 3) and the
 *  profile the app also gets. */
export const CONSENT = {
  firstTime: true,
  changed: false,
  scopeHash: "0".repeat(64),
  items: [
    { kind: "profile", claims: ["email", "name"] },
    {
      more: 0,
      kind: "license",
      anchor: {
        seat: { limit: 3, position: 2 },
        term: "perpetual",
        tierName: "Pro",
        name: "Pro",
      },
    },
  ],
  as: { email: "maya@example.com", provider: "google" },
  client: {
    nameVerified: true,
    iconUrl: null,
    developerName: null,
    appName: "Acme",
  },
};
