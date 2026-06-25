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
import { entry, makeConfigDoc, makeDoc, NOW_SEC } from "./fixtures.js";

// The shared projection helpers (core/adapter.ts) are what guarantee mode-parity: both
// adapters flow a doc through `projectState` so the *shape* is transport-independent. These
// unit-test the projection in isolation (no React, no transport).

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
    ).toEqual({
      a: false,
      b: 0,
      c: "",
    });
  });
});

describe("projectState", () => {
  it("flips phase to ready and projects config + entitlements from the doc", () => {
    const state = projectState("desktop", makeDoc(), {
      hasToken: true,
      now: NOW_SEC,
    });
    expect(state.phase).toBe("ready");
    expect(state.mode).toBe("desktop");
    expect(state.status).toBe("ok");
    expect(state.gate.status).toBe("ok");
    expect(state.config).toEqual({ "theme.mode": "dark" });
    expect(state.entitlements).toEqual({ polarisVpn: true, beta: false });
    expect(state.profile?.email).toBe("ada@acme.test");
  });

  it("a null doc yields empty config/entitlements and a null profile", () => {
    const state = projectState("browser", null, {
      hasToken: false,
      now: NOW_SEC,
    });
    expect(state.config).toEqual({});
    expect(state.entitlements).toEqual({});
    expect(state.profile).toBeNull();
    expect(state.status).toBe("needs-enroll");
  });

  it("threads busy + error flags through", () => {
    const err = new PolarisError("network", "boom");
    const state = projectState(
      "browser",
      null,
      { hasToken: false, now: NOW_SEC },
      { busy: true, error: err },
    );
    expect(state.busy).toBe(true);
    expect(state.error).toBe(err);
  });

  it("defaults busy=false and error=null when no flags given", () => {
    const state = projectState("browser", makeDoc(), {
      hasToken: true,
      now: NOW_SEC,
    });
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });

  it("does NOT expose secrets in the projected config map", () => {
    const state = projectState("desktop", makeDoc(), {
      hasToken: true,
      now: NOW_SEC,
    });
    expect(state.config).not.toHaveProperty("api.token");
  });
});

describe("readConfig / readEntitled", () => {
  const state = projectState("desktop", makeDoc(), {
    hasToken: true,
    now: NOW_SEC,
  });

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

// ── v2 config semantics: state honoring + local overrides ──────────────────────
// Precedence per key: enforced|hidden (remote, locked) > local override > remote-default >
// fallback. (Environment layering is a node/python/swift concern, never present here.)

describe("resolveConfigValue (v2 precedence)", () => {
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
  it("merges doc keys + override-only keys through the precedence", () => {
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
  const doc = makeConfigDoc({
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  });
  const local = {
    enforcedKey: "tryToWin",
    defaultKey: "localWin",
    onlyLocal: "x",
  };
  const state = projectState(
    "desktop",
    doc,
    { hasToken: true, now: NOW_SEC },
    { localOverrides: local },
  );

  it("enforced beats a local override", () => {
    expect(state.config.enforcedKey).toBe("srv");
    expect(readConfig(state, "enforcedKey", "fb")).toBe("srv");
  });

  it("default is overridden by local, then remote-default, then fallback", () => {
    expect(readConfig(state, "defaultKey", "fb")).toBe("localWin");
    const noOverride = projectState("desktop", doc, {
      hasToken: true,
      now: NOW_SEC,
    });
    expect(readConfig(noOverride, "defaultKey", "fb")).toBe("remote");
    expect(readConfig(noOverride, "absentKey", "fb")).toBe("fb");
  });

  it("carries the raw entries + overrides onto the snapshot", () => {
    expect(state.configEntries.enforcedKey?.updatedAt).toBe(950);
    expect(state.localOverrides).toEqual(local);
  });
});

describe("getConfigSource (provenance)", () => {
  const doc = makeConfigDoc({
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv"),
    defaultKey: entry("default", "remote"),
    overriddenDefault: entry("default", "remote"),
  });
  const state = projectState(
    "browser",
    doc,
    { hasToken: true, now: NOW_SEC },
    { localOverrides: { overriddenDefault: "local", onlyLocal: "x" } },
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
  const doc = makeConfigDoc({
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  });
  const state = projectState(
    "desktop",
    doc,
    { hasToken: true, now: NOW_SEC },
    { localOverrides: { defaultKey: "local", onlyLocal: "y" } },
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
    expect(byKey.onlyLocal).toEqual({
      key: "onlyLocal",
      value: "y",
      enforced: false,
    });
  });
});

describe("initialState", () => {
  it("seeds a loading, needs-enroll snapshot for the given mode", () => {
    const s = initialState("browser");
    expect(s.phase).toBe("loading");
    expect(s.mode).toBe("browser");
    expect(s.status).toBe("needs-enroll");
    expect(s.busy).toBe(false);
    expect(s.error).toBeNull();
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
