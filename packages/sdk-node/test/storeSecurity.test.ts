// The hostile-filesystem half of the Node persistence layer (B1-04 / B1-07), plus the Linux
// machine-id source ladder that feeds the device file it writes.
//
// `store.test.ts` next door pins the HAPPY path: bytes survive, modes are 0600, the record is
// the v3 shape. This file pins what happens when the path is not the file we wrote.
//
//   * B1-04 — mode 0600 was applied only AT CREATION and the read was a plain `readFileSync`,
//     so a symlink planted at `managed.json` / `token` / `device` redirected the read to a file
//     the attacker chose. The read now opens with `O_NOFOLLOW`.
//   * B1-07 — the same read had no size cap, so a huge file at the path was slurped whole into
//     the process. It is now bounded by `MAX_STATE_FILE_BYTES`.
//
// Every refusal must land as ABSENT — `null` — because that is this codebase's one spelling of
// a failed artifact (§4.1: a missing, unreadable or unparseable cache is "no cache", which Core
// treats as needs-activation). Never a throw, never a partial record, never the attacker's
// bytes. The device file is the deliberate exception: refusing to READ it means minting a fresh
// id, and writing THAT through the same symlink would be the attack from the other side, so the
// write refuses loudly — the failure Swift spells `StoreError.symlink`.
//
// The `node:fs` mock at the top is armed by exactly one describe block, the machine-id ladder,
// which cannot be exercised from a macOS test host otherwise. It lives here rather than in
// `devices.test.ts` because vitest mocks are FILE-scoped, and a mocked `readFileSync` under
// that suite would also sit beneath the hardware fingerprint's `/proc` and `/sys` reads on a
// Linux runner. Unarmed it is a pass-through, so everything below it uses the real filesystem.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import {
  FileStore,
  MAX_STATE_FILE_BYTES,
  SYMLINK_GUARD,
} from "../src/core/store.js";
import {
  LINUX_MACHINE_ID_PATHS,
  deriveDeviceId,
  deviceIdFromRaw,
  linuxMachineId,
} from "../src/devices/deviceId.js";

const machineId = vi.hoisted(() => ({
  /** Off by default: the mock is a pass-through until a test arms it. */
  armed: false,
  /** Path → contents. A path absent from this map reads as `ENOENT`. */
  present: new Map<string, string>(),
  /** The two Linux sources, duplicated here because a `vi.mock` factory is hoisted above
   *  every import. A test below asserts this equals `LINUX_MACHINE_ID_PATHS`, so the
   *  duplication cannot drift. */
  paths: ["/etc/machine-id", "/var/lib/dbus/machine-id"],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = ((path: unknown, ...rest: unknown[]) => {
    const key = String(path);
    if (machineId.armed && machineId.paths.includes(key)) {
      const body = machineId.present.get(key);
      if (body === undefined) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${key}'`),
          { code: "ENOENT", errno: -2, path: key },
        );
      }
      return body;
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    readFileSync: patched,
    default: { ...actual, readFileSync: patched },
  };
});

const PRODUCT = "djdl";
const ETC = "/etc/machine-id";
const DBUS = "/var/lib/dbus/machine-id";

/** A parseable v3 record, optionally padded so a fixture can hit an exact byte length. */
function cacheJson(padding = ""): string {
  const rec: CacheRecordV3 & { pad?: string } = {
    v: 3,
    docs: { license: "a.b.c" },
    etags: { license: '"lic-1"' },
    lastSyncUnauthorized: false,
  };
  if (padding) rec.pad = padding;
  return JSON.stringify(rec);
}

/** All-ASCII JSON of EXACTLY `bytes` bytes, so the cap can be pinned on both sides. */
function cacheJsonOfSize(bytes: number): string {
  const json = cacheJson(
    "x".repeat(bytes - cacheJson().length - ',"pad":""'.length),
  );
  if (Buffer.byteLength(json) !== bytes) {
    throw new Error(
      `fixture is ${Buffer.byteLength(json)} bytes, wanted ${bytes}`,
    );
  }
  return json;
}

function tempStore(prefix: string): { dir: string; product: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // Constructing a store is what creates `<dir>/<product>/`.
  new FileStore(PRODUCT, dir);
  return { dir, product: join(dir, PRODUCT) };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// B1-04 — a redirected read
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("FileStore reads refuse a redirected path (B1-04)", () => {
  let dir: string;
  let product: string;
  let outside: string;

  beforeEach(() => {
    ({ dir, product } = tempStore("pkey-store-sec-"));
    outside = join(dir, "attacker-owned");
  });

  it("declares its symlink guard honestly, and uses the kernel's on POSIX", () => {
    // Mirrors the Python SDK's `SYMLINK_GUARD` (R4-10): the strength of the refusal is a value
    // a host can read, not a comment promising something the platform may not give. Node does
    // not expose `O_NOFOLLOW` on Windows, and `| undefined` would silently OR in a zero.
    expect(["O_NOFOLLOW", "lstat-precheck"]).toContain(SYMLINK_GUARD);
    if (process.platform !== "win32") expect(SYMLINK_GUARD).toBe("O_NOFOLLOW");
  });

  it("reads a symlinked cache path as ABSENT rather than following it", async () => {
    writeFileSync(outside, cacheJson(), { mode: 0o600 });
    symlinkSync(outside, join(product, "managed.json"));

    // The target is a perfectly parseable v3 record — the ONLY reason this is null is the
    // refusal to follow the link.
    expect(JSON.parse(readFileSync(outside, "utf8"))).toMatchObject({ v: 3 });
    expect(await new FileStore(PRODUCT, dir).readCache()).toBeNull();
  });

  it("reads a symlinked token path as ABSENT rather than following it", async () => {
    writeFileSync(outside, "pkeyt_attacker-chose-this\n", { mode: 0o600 });
    symlinkSync(outside, join(product, "token"));
    expect(await new FileStore(PRODUCT, dir).getToken()).toBeNull();
  });

  it("refuses a symlinked device path outright instead of adopting the attacker's id", async () => {
    // The device id is the Device principal's NAME (§6): it rides `X-PKey-Device`, every
    // signed document's `deviceId` claim, and the server's primary key. Reading one through a
    // link would let a local attacker rename this install; writing the freshly-minted
    // replacement through the same link would let them place it. So the read is absent and the
    // write refuses — loudly, and without touching what the link points at.
    writeFileSync(outside, "attacker-chosen-device-id", { mode: 0o600 });
    symlinkSync(outside, join(product, "device"));

    await expect(new FileStore(PRODUCT, dir).getDeviceId()).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("attacker-chosen-device-id");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// B1-07 — an unbounded read
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("FileStore reads are bounded by MAX_STATE_FILE_BYTES (B1-07)", () => {
  let dir: string;
  let product: string;

  beforeEach(() => {
    ({ dir, product } = tempStore("pkey-store-cap-"));
  });

  it("caps at 1 MiB — several times any legitimate record, and named", () => {
    // The record is at most three compact JWSs plus hints; a document payload is capped at
    // 64 KiB and base64url-encodes to ~87 KiB. Same number as Swift's `maxCacheBytes`.
    expect(MAX_STATE_FILE_BYTES).toBe(1024 * 1024);
  });

  it("reads a file EXACTLY at the cap", async () => {
    writeFileSync(
      join(product, "managed.json"),
      cacheJsonOfSize(MAX_STATE_FILE_BYTES),
      {
        mode: 0o600,
      },
    );
    expect((await new FileStore(PRODUCT, dir).readCache())?.docs?.license).toBe(
      "a.b.c",
    );
  });

  it("reads a file ONE byte over the cap as ABSENT", async () => {
    // Byte-for-byte the same shape as the case above; only the size differs.
    writeFileSync(
      join(product, "managed.json"),
      cacheJsonOfSize(MAX_STATE_FILE_BYTES + 1),
      { mode: 0o600 },
    );
    expect(await new FileStore(PRODUCT, dir).readCache()).toBeNull();
  });

  it("reads a directory planted at the cache path as ABSENT", async () => {
    // Not a regular file ⇒ not the file we wrote. `EISDIR` must degrade to "re-fetch", not to
    // a client that cannot boot.
    mkdirSync(join(product, "managed.json"));
    expect(await new FileStore(PRODUCT, dir).readCache()).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// …and the ordinary path is untouched
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("FileStore still round-trips normally under the hardened read", () => {
  it("round-trips token, cache and device id, all still 0600", async () => {
    const { dir, product } = tempStore("pkey-store-ok-");
    const store = new FileStore(PRODUCT, dir);
    const rec = JSON.parse(cacheJson()) as CacheRecordV3;

    await store.setToken("pkeyt_roundtrip");
    await store.writeCache(rec);
    const id = await store.getDeviceId();

    const fresh = new FileStore(PRODUCT, dir);
    expect(await fresh.getToken()).toBe("pkeyt_roundtrip");
    expect(await fresh.readCache()).toEqual(rec);
    expect(await fresh.getDeviceId()).toBe(id);

    for (const name of ["token", "managed.json", "device"]) {
      expect(statSync(join(product, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("repairs a pre-existing loose mode on write (0600 applied at creation only)", async () => {
    const { dir, product } = tempStore("pkey-store-mode-");
    const path = join(product, "managed.json");
    // A record left world-readable by an older build — or by a first write that died between
    // `open` and `chmod` — is tightened by the next write rather than inherited.
    writeFileSync(path, cacheJson());
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    await new FileStore(PRODUCT, dir).writeCache(
      JSON.parse(cacheJson()) as CacheRecordV3,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// The Linux machine-id ladder — the dbus fallback regression
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("the Linux machine-id ladder", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    machineId.armed = true;
    machineId.present.clear();
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
  });

  afterEach(() => {
    machineId.armed = false;
    machineId.present.clear();
    Object.defineProperty(process, "platform", realPlatform);
  });

  it("reads /etc/machine-id first, then /var/lib/dbus/machine-id", () => {
    // The order is Python's (`devices/deviceid.py`). Swift has no Linux branch at all, so
    // Python is the canonical spelling and this is the parity assertion.
    expect([...LINUX_MACHINE_ID_PATHS]).toEqual([ETC, DBUS]);
    expect([...LINUX_MACHINE_ID_PATHS]).toEqual(machineId.paths);

    machineId.present.set(ETC, "systemd-id\n");
    machineId.present.set(DBUS, "dbus-id\n");
    expect(linuxMachineId()).toBe("systemd-id");
    expect(deriveDeviceId(PRODUCT)).toBe(
      deviceIdFromRaw(PRODUCT, "systemd-id"),
    );
  });

  it("falls through to the dbus file when /etc/machine-id is ABSENT — and the id is STABLE", () => {
    // THE REGRESSION. Both reads sat under one `try`, so an absent `/etc/machine-id` threw
    // before the dbus read was ever attempted, `rawDeviceId()` answered null, and
    // `deriveDeviceId` fell through to `randomUUID()` — a FRESH device id on EVERY call,
    // burning a seat per run on exactly the hosts (non-systemd images, some containers) that
    // ship the dbus file and nothing else.
    machineId.present.set(DBUS, "dbus-only-host\n");
    expect(linuxMachineId()).toBe("dbus-only-host");

    const first = deriveDeviceId(PRODUCT);
    expect(deriveDeviceId(PRODUCT)).toBe(first);
    // …and it is derived from the dbus value, not from a random UUID that happened to repeat.
    expect(first).toBe(deviceIdFromRaw(PRODUCT, "dbus-only-host"));
  });

  it("falls through when /etc/machine-id is present but EMPTY (a first-boot marker)", () => {
    machineId.present.set(ETC, "\n");
    machineId.present.set(DBUS, "dbus-id\n");
    expect(linuxMachineId()).toBe("dbus-id");
    expect(deriveDeviceId(PRODUCT)).toBe(deviceIdFromRaw(PRODUCT, "dbus-id"));
  });

  it("uses the last-resort path when BOTH sources are absent", () => {
    expect(linuxMachineId()).toBeNull();
    // The caller's explicit fallback comes first…
    expect(deriveDeviceId(PRODUCT, "host-supplied-seed")).toBe(
      deviceIdFromRaw(PRODUCT, "host-supplied-seed"),
    );
    // …and with nothing at all it is a random UUID — which is exactly why the dbus rung above
    // has to work: two calls do NOT agree, so every run would enrol a new device.
    expect(deriveDeviceId(PRODUCT)).not.toBe(deriveDeviceId(PRODUCT));
  });
});
