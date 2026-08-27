import { describe, expect, it, vi } from "vitest";
import {
  configSource,
  flattenEntries,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
  resolveConfig,
  resolveConfigValue,
} from "../src/core/adapter.js";
import { createStore } from "../src/core/store.js";
import { initialState, PolarisError } from "../src/core/types.js";
import {
  defaultServices,
  noBusy,
  noErrors,
  servicesFromList,
} from "../src/core/services.js";
import { entry, makeConfig, makeDoc, NOW_SEC } from "./fixtures.js";

// The shared projection helpers (core/adapter.ts) are what guarantee mode-parity: both
// adapters flow the same document pair through `projectState`, so the *shape* is
// transport-independent. These unit-test the projection in isolation (no React, no transport).
//
// The PRECEDENCE itself is `@plrs/client-core`'s and is proven by its own suite plus the
// conformance corpus; what these rows pin is that React feeds it the right context — an EMPTY
// environment layer above all, because a renderer must never inherit the privileged process's.

const licensed = servicesFromList(["license", "config"]);
const gateOk = { activation: "token" as const, now: NOW_SEC };
const gateNone = { activation: null, now: NOW_SEC };

describe("flattenEntries", () => {
  it("flattens a ManagedEntry record to key→value", () => {
    expect(flattenEntries({ a: { value: 1 }, b: { value: "two" } })).toEqual({
      a: 1,
      b: "two",
    });
  });

  it("returns an empty object for undefined input", () => {
    expect(flattenEntries(undefined)).toEqual({});
  });

  it("preserves falsy values (false / 0 / empty string)", () => {
    expect(
      flattenEntries({
        a: { value: false },
        b: { value: 0 },
        c: { value: "" },
      }),
    ).toEqual({ a: false, b: 0, c: "" });
  });
});

describe("projectState", () => {
  it("flips phase to ready and projects config + entitlements from the document pair", () => {
    const state = projectState(
      "desktop",
      { license: makeDoc(), config: makeConfig() },
      gateOk,
      { capabilities: licensed },
    );
    expect(state.phase).toBe("ready");
    expect(state.mode).toBe("desktop");
    expect(state.status).toBe("ok");
    expect(state.gate.status).toBe("ok");
    expect(state.config).toEqual({ "theme.mode": "dark" });
    expect(state.entitlements).toEqual({ polarisVpn: true, beta: false });
    expect(state.profile?.email).toBe("ada@acme.test");
    expect(state.activation).toBe("token");
  });

  it("a null license document yields empty entitlements and a null profile", () => {
    const state = projectState(
      "browser",
      { license: null, config: {} },
      gateNone,
      { capabilities: licensed },
    );
    expect(state.config).toEqual({});
    expect(state.entitlements).toEqual({});
    expect(state.profile).toBeNull();
    expect(state.status).toBe("needs-activation");
  });

  it("config survives a null license document (D-08: the services are independent)", () => {
    const state = projectState(
      "browser",
      { license: null, config: makeConfig() },
      gateNone,
      { capabilities: servicesFromList(["config"]) },
    );
    expect(state.config["theme.mode"]).toBe("dark");
    expect(state.status).toBe("not-applicable");
  });

  it("threads the per-service busy + error maps through", () => {
    const err = new PolarisError("network", "boom");
    const busy = { ...noBusy(), config: true };
    const error = { ...noErrors(), identity: err };
    const state = projectState(
      "browser",
      { license: null, config: {} },
      gateNone,
      { busy, error, capabilities: licensed },
    );
    expect(state.busy.config).toBe(true);
    expect(state.busy.license).toBe(false);
    expect(state.error.identity).toBe(err);
    expect(state.error.config).toBeNull();
  });

  it("defaults to no busy and no errors when no flags are given", () => {
    const state = projectState(
      "browser",
      { license: makeDoc(), config: {} },
      gateOk,
      { capabilities: licensed },
    );
    expect(state.busy).toEqual(noBusy());
    expect(state.error).toEqual(noErrors());
  });

  it("carries the clock floor onto the snapshot", () => {
    const state = projectState(
      "desktop",
      { license: makeDoc(), config: {} },
      { ...gateOk, highWaterMark: 1700 },
      { capabilities: licensed },
    );
    expect(state.highWaterMark).toBe(1700);
  });

  it("does NOT expose secrets in the projected config map", () => {
    // Secrets never reach `PolarisDocs.config` — the transports strip them at their edge —
    // so a projected snapshot has nowhere to leak one from.
    const state = projectState(
      "desktop",
      { license: makeDoc(), config: makeConfig() },
      gateOk,
      { capabilities: licensed },
    );
    expect(state.config).not.toHaveProperty("api.token");
  });
});

describe("readConfig / readEntitled", () => {
  const state = projectState(
    "desktop",
    { license: makeDoc(), config: makeConfig() },
    gateOk,
    { capabilities: licensed },
  );

  it("readConfig returns the value when present", () => {
    expect(readConfig(state, "theme.mode", "light")).toBe("dark");
  });

  it("readConfig returns the fallback when absent", () => {
    expect(readConfig(state, "missing.key", "fallback")).toBe("fallback");
  });

  it("readEntitled is true only for a literal true entry", () => {
    expect(readEntitled(state, "polarisVpn")).toBe(true);
    expect(readEntitled(state, "beta")).toBe(false);
    expect(readEntitled(state, "unknown")).toBe(false);
  });
});

// ── Config semantics: state honoring + local overrides ─────────────────────────
// Precedence per key: enforced|hidden (remote, locked) > local override > remote-default >
// fallback. The `env` layer `@plrs/client-core` also supports is deliberately starved here.

describe("resolveConfigValue (precedence)", () => {
  const entries = {
    locked: entry("enforced", "server"),
    secretLocked: entry("hidden", "server-hidden"),
    soft: entry("default", "remote-default"),
  };

  it("enforced → remote value wins even with a local override present", () => {
    expect(resolveConfigValue(entries, { locked: "mine" }, "locked")).toBe(
      "server",
    );
  });

  it("hidden → remote value wins even with a local override present", () => {
    expect(
      resolveConfigValue(entries, { secretLocked: "mine" }, "secretLocked"),
    ).toBe("server-hidden");
  });

  it("default → local override beats the remote default", () => {
    expect(resolveConfigValue(entries, { soft: "mine" }, "soft")).toBe("mine");
  });

  it("default → remote default when no local override", () => {
    expect(resolveConfigValue(entries, {}, "soft")).toBe("remote-default");
  });

  it("an override for a key the server never sent surfaces (override-only key)", () => {
    expect(resolveConfigValue(entries, { extra: 42 }, "extra")).toBe(42);
  });

  it("unknown + unoverridden key resolves to undefined (caller applies fallback)", () => {
    expect(resolveConfigValue(entries, {}, "nope")).toBeUndefined();
  });
});

describe("resolveConfig (effective map)", () => {
  it("merges document keys + override-only keys through the precedence", () => {
    const entries = {
      locked: entry("enforced", "srv"),
      soft: entry("default", "def"),
    };
    expect(resolveConfig(entries, { soft: "ovr", extra: true })).toEqual({
      locked: "srv",
      soft: "ovr",
      extra: true,
    });
  });
});

describe("projectState honors local overrides", () => {
  const config = {
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  };
  const local = {
    enforcedKey: "tryToWin",
    defaultKey: "localWin",
    onlyLocal: "x",
  };
  const state = projectState(
    "desktop",
    { license: makeDoc(), config },
    gateOk,
    { localOverrides: local, capabilities: licensed },
  );

  it("enforced beats a local override", () => {
    expect(state.config.enforcedKey).toBe("srv");
    expect(readConfig(state, "enforcedKey", "fb")).toBe("srv");
  });

  it("default is overridden by local, then remote-default, then fallback", () => {
    expect(readConfig(state, "defaultKey", "fb")).toBe("localWin");
    const noOverride = projectState(
      "desktop",
      { license: makeDoc(), config },
      gateOk,
      { capabilities: licensed },
    );
    expect(readConfig(noOverride, "defaultKey", "fb")).toBe("remote");
    expect(readConfig(noOverride, "absentKey", "fb")).toBe("fb");
  });

  it("carries the raw entries + overrides onto the snapshot", () => {
    expect(state.configEntries.enforcedKey?.updatedAt).toBe(950);
    expect(state.localOverrides).toEqual(local);
  });
});

describe("getConfigSource (provenance)", () => {
  const config = {
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv"),
    defaultKey: entry("default", "remote"),
    overriddenDefault: entry("default", "remote"),
  };
  const state = projectState(
    "browser",
    { license: makeDoc(), config },
    gateOk,
    {
      localOverrides: { overriddenDefault: "local", onlyLocal: "x" },
      capabilities: licensed,
    },
  );

  it("classifies every provenance bucket", () => {
    expect(configSource(state, "enforcedKey")).toBe("enforced");
    expect(configSource(state, "hiddenKey")).toBe("hidden");
    expect(configSource(state, "overriddenDefault")).toBe("local");
    expect(configSource(state, "onlyLocal")).toBe("local");
    expect(configSource(state, "defaultKey")).toBe("remote-default");
    expect(configSource(state, "absentKey")).toBe("fallback");
  });
});

describe("listUserConfig (settings-UI enumeration)", () => {
  const config = {
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  };
  const state = projectState(
    "desktop",
    { license: makeDoc(), config },
    gateOk,
    {
      localOverrides: { defaultKey: "local", onlyLocal: "y" },
      capabilities: licensed,
    },
  );

  it("excludes hidden keys and flags enforced rows read-only", () => {
    const rows = listUserConfig(state);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.hiddenKey).toBeUndefined();
    expect(byKey.enforcedKey).toEqual({
      key: "enforcedKey",
      value: "srv",
      enforced: true,
    });
    expect(byKey.defaultKey).toEqual({
      key: "defaultKey",
      value: "local",
      enforced: false,
    });
    // Override-only rows are included — which is why this is NOT client-core's
    // `listUserEntries`, which enumerates the remote catalog alone.
    expect(byKey.onlyLocal).toEqual({
      key: "onlyLocal",
      value: "y",
      enforced: false,
    });
  });
});

describe("initialState", () => {
  it("seeds a loading, needs-activation snapshot for a licensed product", () => {
    const s = initialState("browser", defaultServices());
    expect(s.phase).toBe("loading");
    expect(s.mode).toBe("browser");
    expect(s.status).toBe("needs-activation");
    expect(s.busy).toEqual(noBusy());
    expect(s.error).toEqual(noErrors());
    expect(s.activation).toBeNull();
    expect(s.highWaterMark).toBe(0);
  });

  it("seeds `not-applicable` for a product with no license service", () => {
    // Without this a config-only product flashes a sign-in screen on its first frame — the
    // one it can never satisfy.
    const s = initialState("browser", servicesFromList(["config"]));
    expect(s.status).toBe("not-applicable");
    expect(s.gate.status).toBe("not-applicable");
  });
});

describe("createStore", () => {
  it("get returns the seed; set replaces and notifies subscribers", () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    store.subscribe((v) => seen.push(v.n));
    store.set({ n: 1 });
    store.set((prev) => ({ n: prev.n + 1 }));
    expect(store.get()).toEqual({ n: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it("skips the notify when the next value is identity-equal", () => {
    const seed = { n: 0 };
    const store = createStore(seed);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(seed); // same reference ⇒ no churn
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const store = createStore(0);
    const cb = vi.fn();
    const off = store.subscribe(cb);
    store.set(1);
    off();
    store.set(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("PolarisError", () => {
  it("carries a stable code and defaults its message to the code", () => {
    const e = new PolarisError("bridge-missing");
    expect(e.code).toBe("bridge-missing");
    expect(e.message).toBe("bridge-missing");
    expect(e.name).toBe("PolarisError");
    expect(e).toBeInstanceOf(Error);
  });
});
