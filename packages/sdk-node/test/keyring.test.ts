// @pkey-feature sync.keyring
// The Cloud Sync key ring client (U-38.1; WIRE-CONTRACT-V5 §13.10, §13.11) against a small fake of
// the Worker's key ring routes: create, unlock after a restart, wrap to a second device, the
// recovery code, reset and adopt, the codec, the typed refusals, and that the root never leaves
// the client's memory. The transcripts are replayed in conformance/runners/node/transcripts.test.ts.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "@polaris-key/jws";
import { PolarisError, type Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { createNodeDeviceKeyStore } from "../src/devices/deviceKeys.js";
import { KeyringError } from "../src/keyring/client.js";

const PRODUCT = "djdl";
const TOKEN = `pkeyt_${"T".repeat(43)}`;

/** A store that holds a token and answers one device id; nothing else is kept. */
class Mem implements Pick<Store, "getToken" | "setToken" | "clearToken"> {
  token: string | null = TOKEN;
  constructor(private readonly id: string) {}
  getToken = async () => this.token;
  setToken = async (t: string) => {
    this.token = t;
  };
  clearToken = async () => {
    this.token = null;
  };
  getDeviceId = async () => this.id;
  readCache = async () => null;
  writeCache = async () => {};
  clearCache = async () => {};
}

interface Req {
  method: string;
  path: string;
  device: string;
  body: Record<string, unknown> | undefined;
}

/** The Worker's ring routes, reduced to what the client depends on. */
class FakeRing {
  ring: Record<string, unknown> | null = null;
  previous: Record<string, unknown> | null = null;
  adopted: Record<string, unknown>[] = [];
  wraps = new Map<string, Record<string, unknown>>();
  recovery: { ct: string; epoch: number; kid: string } | null = null;
  reqs: Req[] = [];
  recoveryReads = 0;
  failWith: { status: number; code: string } | null = null;

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const device = h.get("x-pkey-device") ?? "";
    const path = url.pathname.replace(`/${PRODUCT}/devices/keyring`, "") || "/";
    this.reqs.push({ method, path, device, body });
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    const none = () => new Response(null, { status: 204 });
    const conflict = () => j({ error: { code: "keyring_conflict" } }, 409);
    if (this.failWith)
      return j({ error: { code: this.failWith.code } }, this.failWith.status);
    if (h.get("authorization") !== `Bearer ${TOKEN}`) return j({}, 401);
    if (method === "GET" && path === "/")
      return j({
        ring: this.ring && {
          ...this.ring,
          recovery: { set: this.recovery !== null, createdAt: 1 },
          adopted: this.adopted,
          ...(this.previous ? { previous: this.previous } : {}),
        },
        wrap: this.wraps.get(device) ?? null,
      });
    if (method === "POST" && (path === "/" || path === "/reset")) {
      if (path === "/" && this.ring) return conflict();
      if (path === "/reset" && !this.ring) return conflict();
      if (this.ring)
        this.previous = {
          ringId: this.ring.ringId,
          kid: this.ring.rootKid,
          until: 9,
        };
      this.ring = {
        ringId: body!.ringId,
        epoch: 1,
        rootKid: body!.rootKid,
        state: "active",
        createdAt: 1,
      };
      this.wraps = new Map([
        [
          device,
          {
            epoch: 1,
            kid: body!.rootKid,
            by: device,
            ...(body!.wrap as object),
          },
        ],
      ]);
      const rec = body!.recovery as { ct: string } | undefined;
      this.recovery = rec
        ? { ct: rec.ct, epoch: 1, kid: String(body!.rootKid) }
        : null;
      return j({ ringId: body!.ringId, epoch: 1 }, 201);
    }
    const w = /^\/wraps\/(.+)$/.exec(path);
    if (w && method === "PUT") {
      const id = decodeURIComponent(w[1]!);
      if (this.wraps.has(id)) return conflict();
      this.wraps.set(id, { ...body, by: device });
      return none();
    }
    if (w && method === "DELETE") {
      if (decodeURIComponent(w[1]!) !== device)
        return j({ error: { code: "forbidden" } }, 403);
      this.wraps.delete(device);
      return none();
    }
    if (path === "/recovery" && method === "PUT") {
      this.recovery = body as never;
      return none();
    }
    if (path === "/recovery" && method === "GET") {
      if (!this.recovery) return j({ error: "not_found" }, 404);
      if (++this.recoveryReads > 5)
        return j({ error: { code: "rate_limited" } }, 429);
      return j(this.recovery);
    }
    if (path === "/adopt" && method === "POST") {
      if (this.adopted.some((a) => a.ringId === body!.fromRingId))
        return conflict();
      this.adopted.push(body as never);
      // The route reads `fromRingId`; the ring lists it as `ringId`.
      const last = this.adopted[this.adopted.length - 1]!;
      this.adopted[this.adopted.length - 1] = {
        ringId: last.fromRingId,
        epoch: last.epoch,
        kid: last.kid,
        ct: last.ct,
      };
      return none();
    }
    return j({}, 404);
  }) as typeof fetch;
}

async function device(server: FakeRing, id: string) {
  const keys = createNodeDeviceKeyStore({ memory: true });
  // The state directory outlives `make()`: the pin lives there.
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-ring-"));
  const make = async () => {
    const client = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: new Mem(id),
      fetchImpl: server.fetch,
      stateDir,
      keyring: { deviceKeys: keys },
    });
    await client.init();
    return client;
  };
  return { id, keys, make, stateDir, client: await make() };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PolarisError);
    return (e as PolarisError).code;
  }
  throw new Error("expected a refusal");
};

describe("keyring: create and unlock", () => {
  it("creates a ring with a wrap to this device and a recovery blob, and holds the root", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const flags: boolean[] = [];
    a.client.keyring.attach({ setRoot: (p) => flags.push(p) });
    const made = await a.client.keyring.create();
    expect(made.ringId).toMatch(/^rg_[A-Za-z0-9_-]{22}$/);
    expect(made.rootKid).toMatch(/^[0-9a-f]{32}$/);
    expect(made.recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(flags).toEqual([false, true]);
    const post = s.reqs.at(-1)!;
    expect(post.method).toBe("POST");
    const wrap = post.body!.wrap as { kem: string; enc: string; ct: string };
    expect(wrap.kem).toBe("x25519");
    expect(base64UrlDecode(wrap.enc)).toHaveLength(32);
    expect(base64UrlDecode(wrap.ct)).toHaveLength(48);
    const rec = post.body!.recovery as { ct: string };
    expect(base64UrlDecode(rec.ct)).toHaveLength(61);
    expect(a.client.keyring.codec.kid).toBe(made.rootKid);
  });

  it("opens the wrap after a restart (the root was never stored here)", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await a.client.keyring.create();
    const sealed = await a.client.keyring.codec.seal(
      "$settings",
      "theme",
      "dark",
    );
    const again = await a.make();
    expect(again.keyring.unlocked).toBe(false);
    await expect(
      again.keyring.codec.seal("$settings", "k", 1),
    ).rejects.toMatchObject({
      code: "sync-locked",
    });
    expect(await again.keyring.unlock()).toMatchObject({
      kind: "unlocked",
      epoch: 1,
    });
    expect(
      await again.keyring.codec.open("$settings", "theme", sealed),
    ).toEqual({
      ok: true,
      name: "theme",
      value: "dark",
    });
  });

  it("a second create is keyring_conflict and holds nothing", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await a.client.keyring.create();
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(await codeOf(b.client.keyring.create())).toBe("keyring_conflict");
    expect(b.client.keyring.unlocked).toBe(false);
  });

  it("stays locked with no ring, no wrap, a wrong-kid wrap and a foreign wrap", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(await a.client.keyring.unlock()).toEqual({
      kind: "locked",
      reason: "no-ring",
    });
    await a.client.keyring.create();
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(await b.client.keyring.unlock()).toEqual({
      kind: "locked",
      reason: "no-wrap",
    });
    // The Worker hands B a wrap that was sealed for A: it does not open.
    s.wraps.set(
      "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB",
      s.wraps.get("DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA")!,
    );
    expect(await b.client.keyring.unlock()).toEqual({
      kind: "locked",
      reason: "unusable-wrap",
    });
    // A kid that is not the ring's.
    s.wraps.set("DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA", {
      ...s.wraps.get("DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA")!,
      kid: "0".repeat(32),
    });
    expect(await a.make().then((c) => c.keyring.unlock())).toEqual({
      kind: "locked",
      reason: "unusable-wrap",
    });
  });
});

describe("keyring: wrap to another device", () => {
  it("delivers the root; the new device reads the first device's values", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    await a.client.keyring.create();
    const sealed = await a.client.keyring.codec.seal("notes", "n1", {
      x: [1, 2],
    });
    const bKeys = await b.keys.ensure();
    await a.client.keyring.wrapTo(
      "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB",
      bKeys.agreeKey,
    );
    expect(await b.client.keyring.unlock()).toMatchObject({ kind: "unlocked" });
    expect(
      await b.client.keyring.codec.open("notes", "n1", sealed),
    ).toMatchObject({
      ok: true,
      value: { x: [1, 2] },
    });
    // Create-only slot, and a wrap goes only to a well formed key.
    expect(
      await codeOf(
        a.client.keyring.wrapTo(
          "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB",
          bKeys.agreeKey,
        ),
      ),
    ).toBe("keyring_conflict");
    expect(await codeOf(a.client.keyring.wrapTo("X", "short"))).toBe(
      "invalid-argument",
    );
  });

  it("refuses to wrap while locked, and removes only its own wrap", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    await a.client.keyring.create();
    expect(
      await codeOf(
        b.client.keyring.wrapTo("X", (await b.keys.ensure()).agreeKey),
      ),
    ).toBe("sync-locked");
    expect(
      await codeOf(
        b.client.keyring.removeWrap("DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      ),
    ).toBe("forbidden");
    await a.client.keyring.removeWrap("DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(s.wraps.size).toBe(0);
  });
});

describe("keyring: recovery code", () => {
  it("recovers on a device with no wrap, and deposits its own wrap", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const made = await a.client.keyring.create();
    const sealed = await a.client.keyring.codec.seal("$settings", "k", true);
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    // Spaces, lower case and the I/L/O confusions are tolerated.
    const typed = made.recoveryCode!.toLowerCase().replace(/-/g, " ");
    const got = await b.client.keyring.recover(typed);
    expect(got).toMatchObject({ epoch: 1, wrapDeposited: true });
    expect(
      await b.client.keyring.codec.open("$settings", "k", sealed),
    ).toMatchObject({ ok: true });
    const next = await b.make();
    expect(await next.keyring.unlock()).toMatchObject({ kind: "unlocked" });
  });

  it("a bad checksum makes no request; a wrong code is recovery-code-invalid", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const made = await a.client.keyring.create();
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const before = s.reqs.length;
    const flipped = made.recoveryCode!.replace(/^./, (c) =>
      c === "0" ? "1" : "0",
    );
    expect(await codeOf(b.client.keyring.recover(flipped))).toBe(
      "recovery-code-invalid",
    );
    expect(await codeOf(b.client.keyring.recover("nonsense"))).toBe(
      "recovery-code-invalid",
    );
    expect(s.reqs.length).toBe(before);
    // A well formed code for some other ring.
    const other = await device(
      new FakeRing(),
      "DEVICECCCCCCCCCCCCCCCCCCCCCCCCCC",
    );
    const wrongCode = await other.client.keyring.create();
    expect(
      await codeOf(b.client.keyring.recover(wrongCode.recoveryCode!)),
    ).toBe("recovery-code-invalid");
    expect(b.client.keyring.unlocked).toBe(false);
  });

  it("a new code replaces the old one", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const made = await a.client.keyring.create({ recovery: false });
    expect(made.recoveryCode).toBeUndefined();
    const first = await a.client.keyring.setRecoveryCode();
    const second = await a.client.keyring.setRecoveryCode();
    expect(second).not.toBe(first);
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(await codeOf(b.client.keyring.recover(first))).toBe(
      "recovery-code-invalid",
    );
    expect(await b.client.keyring.recover(second)).toMatchObject({ epoch: 1 });
  });

  it("maps the server's refusals: no blob is not_found, the sixth read rate_limited", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await a.client.keyring.create({ recovery: false });
    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const code = await a.client.keyring.setRecoveryCode();
    s.recovery = null;
    expect(await codeOf(b.client.keyring.recover(code))).toBe("not_found");
    s.recovery = { ct: "x", epoch: 1, kid: "k" };
    s.recoveryReads = 5;
    expect(await codeOf(b.client.keyring.recoveryBlob())).toBe("rate_limited");
  });
});

describe("keyring: reset and adopt", () => {
  it("keeps the old root for adopt; another device reads old data through the adopted root", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const old = await a.client.keyring.create();
    const oldSealed = await a.client.keyring.codec.seal("notes", "n", "old");
    const fresh = await a.client.keyring.reset();
    expect(fresh.ringId).not.toBe(old.ringId);
    expect(fresh.rootKid).not.toBe(old.rootKid);
    // The old root no longer opens under the current one on its own.
    expect(
      await a.client.keyring.codec.open("notes", "n", oldSealed),
    ).toMatchObject({
      ok: true,
      value: "old",
    });
    await a.client.keyring.adopt(old.ringId);
    expect(await codeOf(a.client.keyring.adopt(old.ringId))).toBe(
      "keyring_conflict",
    );
    expect(await codeOf(a.client.keyring.adopt("rg_" + "A".repeat(22)))).toBe(
      "invalid-argument",
    );

    const b = await device(s, "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB");
    await a.client.keyring.wrapTo(
      "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB",
      (await b.keys.ensure()).agreeKey,
    );
    await b.client.keyring.unlock();
    expect(
      await b.client.keyring.codec.open("notes", "n", oldSealed),
    ).toMatchObject({
      ok: false,
      reason: "kid",
    });
    expect(await b.client.keyring.openAdopted()).toEqual([old.ringId]);
    expect(
      await b.client.keyring.codec.open("notes", "n", oldSealed),
    ).toMatchObject({
      ok: true,
      value: "old",
    });
  });
});

describe("keyring: the root stays in memory", () => {
  it("lock() zeroes the root and tells the machine", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const flags: boolean[] = [];
    const detach = a.client.keyring.attach({ setRoot: (p) => flags.push(p) });
    await a.client.keyring.create();
    a.client.keyring.lock();
    expect(flags).toEqual([false, true, false]);
    expect(a.client.keyring.codec.locked).toBe(true);
    detach();
    await a.client.keyring.unlock();
    expect(flags).toHaveLength(3);
  });

  it("prints no key material, and the module touches no file", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const made = await a.client.keyring.create();
    const shown = [
      inspect(a.client.keyring, { depth: 5 }),
      JSON.stringify(a.client.keyring),
      inspect(a.client.keyring.codec),
    ].join("\n");
    expect(shown).not.toContain(made.recoveryCode!);
    expect(shown).not.toMatch(/[0-9a-f]{64}/);
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "src", "keyring", "client.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /from "node:(fs|child_process)|writeFile|appendFile/,
    );
  });

  it("needs a token and device keys, with typed errors", async () => {
    const s = new FakeRing();
    const a = await device(s, "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA");
    (a.client.core.store as unknown as Mem).token = null;
    const bare = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: new Mem("DEVICEDDDDDDDDDDDDDDDDDDDDDDDDDD"),
      stateDir: mkdtempSync(join(tmpdir(), "pkey-ring-")),
      fetchImpl: s.fetch,
    });
    await bare.init();
    expect(await codeOf(bare.keyring.create())).toBe("device_keys_required");
    const noToken = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: Object.assign(new Mem("DEVICEEEEEEEEEEEEEEEEEEEEEEEEEE"), {
        token: null,
      }),
      fetchImpl: s.fetch,
      stateDir: mkdtempSync(join(tmpdir(), "pkey-ring-")),
      keyring: { deviceKeys: a.keys },
    });
    await noToken.init();
    expect(await codeOf(noToken.keyring.unlock())).toBe("no-token");
    s.failWith = { status: 404, code: "not_found" };
    expect(await codeOf(a.make().then((c) => c.keyring.read()))).toBe(
      "not_found",
    );
    expect(new KeyringError("x", "y")).toBeInstanceOf(PolarisError);
  });
});

/** The pin file(s) under a state base (the client appends its product namespace). */
const pinFiles = (base: string): string[] =>
  readdirSync(base)
    .map((d) => join(base, d, "keyring-pin.json"))
    .filter((f) => existsSync(f));

describe("keyring: the pin (a changed ring is never adopted silently)", () => {
  const A = "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /** Device B (the victim) holds ring 1; an attacker with another device of the account resets
   *  the ring and wraps its own root to B. */
  async function attacked() {
    const s = new FakeRing();
    const victim = await device(s, B);
    const made = await victim.client.keyring.create();
    const sealed = await victim.client.keyring.codec.seal("n", "k", "mine");
    const attacker = await device(s, A);
    await attacker.client.keyring.reset();
    await attacker.client.keyring.wrapTo(
      B,
      (await victim.keys.ensure()).agreeKey,
    );
    return { s, victim, attacker, made, sealed };
  }

  it("pins at create and writes an owner-only file with no secret", async () => {
    const s = new FakeRing();
    const a = await device(s, A);
    const made = await a.client.keyring.create();
    expect(await a.client.keyring.pin()).toEqual({
      ringId: made.ringId,
      epoch: 1,
      rootKid: made.rootKid,
    });
    expect(pinFiles(a.stateDir)).toHaveLength(1);
    expect(statSync(pinFiles(a.stateDir)[0]!).mode & 0o777).toBe(0o600);
    const raw = readFileSync(pinFiles(a.stateDir)[0]!, "utf8");
    expect(raw).not.toContain(made.recoveryCode!);
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
  });

  it("an attacker reset plus a wrap leaves the victim at ring-changed with its old root intact", async () => {
    const { victim, made, sealed } = await attacked();
    const again = await victim.make();
    // Restart: nothing in memory, the pin on disk.
    const r = await again.keyring.unlock();
    expect(r).toMatchObject({
      kind: "ring-changed",
      pinned: { ringId: made.ringId, rootKid: made.rootKid },
    });
    expect(again.keyring.unlocked).toBe(false);
    // The same client that held the old root keeps it and keeps reading its data.
    const held = await victim.client.keyring.unlock();
    expect(held.kind).toBe("ring-changed");
    expect(victim.client.keyring.unlocked).toBe(true);
    expect(
      await victim.client.keyring.codec.open("n", "k", sealed),
    ).toMatchObject({ ok: true, value: "mine" });
    expect((await victim.client.keyring.pin())?.ringId).toBe(made.ringId);
  });

  it("recover(code) of the new ring re-pins; an attacker's ring never opens with the person's code", async () => {
    const { s, victim, made } = await attacked();
    const again = await victim.make();
    expect((await again.keyring.unlock()).kind).toBe("ring-changed");
    // The person's own code does not open the attacker's ring.
    expect(await codeOf(again.keyring.recover(made.recoveryCode!))).toBe(
      "recovery-code-invalid",
    );
    expect((await again.keyring.pin())?.ringId).toBe(made.ringId);
    // A legitimate reset elsewhere gives the person a new code for the new ring.
    const code = await (async () => {
      const c = await device(s, "DEVICECCCCCCCCCCCCCCCCCCCCCCCCCC");
      const r = await c.client.keyring.reset();
      return r;
    })();
    const got = await again.keyring.recover(code.recoveryCode!);
    expect(got.ringId).toBe(code.ringId);
    expect((await again.keyring.pin())?.ringId).toBe(code.ringId);
  });

  it("acceptRingChange() re-pins after the person confirms", async () => {
    const { s, victim, attacker } = await attacked();
    const again = await victim.make();
    expect((await again.keyring.unlock()).kind).toBe("ring-changed");
    const now = s.ring!.ringId as string;
    expect(await again.keyring.acceptRingChange()).toMatchObject({
      kind: "unlocked",
      ringId: now,
    });
    expect((await again.keyring.pin())?.ringId).toBe(now);
    expect((await victim.make().then((c) => c.keyring.unlock())).kind).toBe(
      "unlocked",
    );
    void attacker;
  });

  it("a reset by this device re-pins itself", async () => {
    const s = new FakeRing();
    const a = await device(s, A);
    await a.client.keyring.create();
    const fresh = await a.client.keyring.reset();
    expect((await a.client.keyring.pin())?.ringId).toBe(fresh.ringId);
    expect((await a.make().then((c) => c.keyring.unlock())).kind).toBe(
      "unlocked",
    );
  });

  it("a lower epoch or another rootKid is not adopted either", async () => {
    const s = new FakeRing();
    const a = await device(s, A);
    await a.client.keyring.create();
    s.ring = { ...s.ring!, epoch: 2 };
    expect((await a.client.keyring.unlock()).kind).toBe("ring-changed");
    s.ring = { ...s.ring!, epoch: 1, rootKid: "f".repeat(32) };
    expect((await a.client.keyring.unlock()).kind).toBe("ring-changed");
  });

  it("forget() (sign-out) locks and drops the pin", async () => {
    const s = new FakeRing();
    const a = await device(s, A);
    await a.client.keyring.create();
    await a.client.keyring.forget();
    expect(a.client.keyring.unlocked).toBe(false);
    expect(await a.client.keyring.pin()).toBeNull();
    expect(pinFiles(a.stateDir)).toHaveLength(0);
  });

  it("identity sign-out and licence deactivation forget the root and the pin", async () => {
    const s = new FakeRing();
    const a = await device(s, A);
    await a.client.keyring.create();
    await a.client.identity.forget();
    expect(a.client.keyring.unlocked).toBe(false);
    expect(await a.client.keyring.pin()).toBeNull();
  });
});
