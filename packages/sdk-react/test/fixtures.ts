// One license fixture that drives BOTH adapters in parity.test.tsx, plus the fakes that let
// each transport read it: a fake `PolarisBridge` (desktop) and a fake `fetch` returning the
// browser session shape. The same doc → identical hook outputs is the parity guarantee.

import type { ManagedConfigDoc } from "@polaris-key/protocol";
import type { BridgeState, PolarisBridge } from "../src/desktop/bridge.js";

/** A fixed "now" (seconds) every adapter is pinned to so the gate is deterministic. */
export const NOW_SEC = 2000;

export function makeDoc(over: Partial<ManagedConfigDoc> = {}): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "acme",
    iss: "key.plrs.im",
    licenseId: "lic-1",
    deviceId: "dev-1",
    issuedAt: 1000,
    expiresAt: 1000 + 3600, // valid at NOW_SEC=2000 → "ok"
    graceUntil: 1000 + 30 * 86400,
    profile: { name: "Ada Lovelace", firstName: "Ada", email: "ada@acme.test", enrolledAt: 900 },
    payload: {
      config: { "theme.mode": { state: "managed", value: "dark" } },
      secrets: { "api.token": { state: "managed", value: "s3cr3t" } },
      entitlements: { polarisVpn: { state: "managed", value: true }, beta: { state: "managed", value: false } },
    },
    ...over,
  };
}

/** A fake bridge backed by an in-memory `BridgeState`, with a push channel for hot-reload. */
export function makeFakeBridge(initial: BridgeState): PolarisBridge & { push(s: BridgeState): void } {
  let state = initial;
  const listeners = new Set<(s: BridgeState) => void>();
  return {
    async getState() {
      return state;
    },
    async refresh() {
      return state;
    },
    async beginSignIn() {
      return { flowId: "flow-1", verificationUrl: "https://key.plrs.im/acme/device", userCode: "ABCD-1234" };
    },
    async pollSignIn() {
      return { kind: "ok" } as const;
    },
    async submitKey() {
      return { kind: "ok" } as const;
    },
    async signOut() {
      state = { hasToken: false, doc: null };
      for (const l of listeners) l(state);
    },
    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    push(s: BridgeState) {
      state = s;
      for (const l of listeners) l(state);
    },
  };
}

/** A fake `fetch` that answers the browser adapter's `GET /<product>/session` with the doc. */
export function makeFakeFetch(doc: ManagedConfigDoc | null): typeof fetch {
  const body = JSON.stringify({ authenticated: doc !== null, doc, csrfToken: "csrf-1" });
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/session")) {
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/auth/logout")) {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
