import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adminCredential,
  decode,
  encode,
  keyringStore,
  KeychainRefusedError,
  memoryStore,
  NoStoreError,
  originOf,
  Refusal,
} from "../src/credentials.js";

const PERSONAL = `pkeyp_${"P".repeat(43)}`;
const OTHER = `pkeyp_${"Q".repeat(43)}`;
const ADMIN = `pkeya_${"A".repeat(43)}`;
const A = "https://a.example";

/** The `Refusal` a promise rejects with. */
async function refusalOf(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}
const B = "https://b.example";

describe("origin keying", () => {
  it("a token for A is never offered to B", async () => {
    const store = memoryStore({
      [A]: { token: PERSONAL, expiresAt: null },
    });
    const found = await adminCredential({
      env: {},
      baseUrl: A,
      store: async () => store,
    });
    expect(found.token).toBe(PERSONAL);
    await expect(
      adminCredential({ env: {}, baseUrl: B, store: async () => store }),
    ).rejects.toThrow(/Not signed in to b\.example/);
  });

  it("normalises the origin: path, case and trailing slash do not matter", () => {
    expect(originOf("https://A.Example/x/")).toBe(A);
    expect(originOf("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses plaintext http to a non-loopback host before anything is sent", () => {
    expect(() => originOf("http://a.example")).toThrow(/https/);
  });
});

describe("resolution", () => {
  it("PKEY_ADMIN_TOKEN wins over the store, and the store is not opened", async () => {
    let opened = false;
    const found = await adminCredential({
      env: { PKEY_ADMIN_TOKEN: OTHER },
      baseUrl: A,
      store: async () => {
        opened = true;
        return memoryStore({ [A]: { token: PERSONAL, expiresAt: null } });
      },
    });
    expect(found).toMatchObject({ token: OTHER, source: "env" });
    expect(opened).toBe(false);
  });

  it("accepts a pkeya_ token from the environment", async () => {
    const found = await adminCredential({
      env: { PKEY_ADMIN_TOKEN: ADMIN },
      baseUrl: A,
      store: async () => memoryStore(),
    });
    expect(found.source).toBe("env");
  });

  it("a bad shape names the fix and never quotes the value", async () => {
    const bad = "pkeyp_short-secret-value";
    const err = await refusalOf(
      adminCredential({
        env: { PKEY_ADMIN_TOKEN: bad },
        baseUrl: A,
        store: async () => memoryStore(),
      }),
    );
    expect(err).toBeInstanceOf(Refusal);
    expect(err.message).toMatch(/pkeya_ or pkeyp_/);
    expect(`${err.message} ${err.fix}`).not.toContain("short-secret");
  });

  it("nothing stored: Not signed in, with the fix pkey login", async () => {
    const err = await refusalOf(
      adminCredential({
        env: {},
        baseUrl: A,
        store: async () => memoryStore(),
      }),
    );
    expect(err.message).toBe("Not signed in to a.example.");
    expect(err.fix).toBe("Run pkey login.");
  });
});

describe("the OS store backend", () => {
  const fake = () => {
    const data = new Map<string, string>();
    const made: unknown[] = [];
    return {
      data,
      made,
      mod: {
        Entry: class {
          constructor(
            readonly service: string,
            readonly account: string,
            readonly options?: unknown,
          ) {
            made.push(options);
          }
          getPassword() {
            return data.get(`${this.service}|${this.account}`) ?? null;
          }
          setPassword(v: string) {
            data.set(`${this.service}|${this.account}`, v);
          }
          deletePassword() {
            return data.delete(`${this.service}|${this.account}`);
          }
        },
      },
    };
  };

  it("keys entries by service pkey and the origin, and round-trips", async () => {
    const { data, mod } = fake();
    const store = await keyringStore(async () => mod);
    store.set(A, { token: PERSONAL, expiresAt: 1_900_000_000 });
    expect([...data.keys()]).toEqual([`pkey|${A}`]);
    expect(store.get(A)).toEqual({
      token: PERSONAL,
      expiresAt: 1_900_000_000,
      label: null,
      hint: "PPPP",
    });
    expect(store.get(B)).toBeNull();
    expect(store.delete(A)).toBe(true);
    expect(store.get(A)).toBeNull();
  });

  it("a missing keyring module refuses with the PKEY_ADMIN_TOKEN fix and writes no file", async () => {
    const err = await refusalOf(
      keyringStore(async () => {
        throw new Error(`Cannot find module with ${PERSONAL}`);
      }),
    );
    expect(err).toBeInstanceOf(NoStoreError);
    expect(err.message).toBe("No credential store on this computer.");
    expect(err.fix).toBe(
      "Set PKEY_ADMIN_TOKEN to a personal token (pkeyp_…) instead.",
    );
    expect(err.code).toBe("no-credential-store");
    expect(err.message).not.toContain("pkeyp_");
    // No fallback exists to take: the module imports no file-system API at all.
    const src = readFileSync(
      new URL("../src/credentials.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/node:(fs|child_process)|writeFile|spawn/);
  });

  it("a failing keychain call is a NoStoreError and drops the underlying text", async () => {
    const mod = {
      Entry: class {
        getPassword(): string | null {
          throw new Error(`dbus said ${PERSONAL}`);
        }
        setPassword() {}
        deletePassword() {
          return false;
        }
      },
    };
    const store = await keyringStore(async () => mod);
    let caught: unknown;
    try {
      store.get(A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoStoreError);
    expect(String((caught as Error).message)).not.toContain("pkeyp_");
  });

  it("a denied or locked keychain is KeychainRefusedError, not 'no credential store'", async () => {
    for (const text of [
      "User interaction is required",
      "NoStorageAccess: the keychain is locked",
      "access denied",
    ]) {
      const mod = {
        Entry: class {
          getPassword(): string | null {
            throw new Error(text);
          }
          setPassword() {}
          deletePassword() {
            return false;
          }
        },
      };
      const store = await keyringStore(async () => mod);
      expect(() => store.get(A), text).toThrow(KeychainRefusedError);
    }
    const refused = new KeychainRefusedError();
    expect(refused.code).toBe("keychain-refused");
    expect(refused.message).toBe("The credential store refused access.");
  });

  it("pins every Linux entry to the Secret Service (R4-11), and no other platform", async () => {
    for (const [platform, expected] of [
      ["linux", { linux: { store: "secret-service" } }],
      ["darwin", undefined],
      ["win32", undefined],
    ] as const) {
      const { mod, made } = fake();
      const store = await keyringStore(async () => mod, platform);
      store.set(A, { token: PERSONAL, expiresAt: null });
      store.get(A);
      store.delete(A);
      expect(made, platform).toHaveLength(3);
      for (const o of made) expect(o, platform).toEqual(expected);
    }
  });

  it("the stored encoding is {t, e, l, h}; a bare {t, e} and a bare token still read", () => {
    const raw = encode({
      token: PERSONAL,
      expiresAt: 1_900_000_000,
      label: "pkey on a.example",
      hint: "h7Q2",
    });
    expect(JSON.parse(raw)).toEqual({
      t: PERSONAL,
      e: 1_900_000_000,
      l: "pkey on a.example",
      h: "h7Q2",
    });
    expect(decode(raw)).toEqual({
      token: PERSONAL,
      expiresAt: 1_900_000_000,
      label: "pkey on a.example",
      hint: "h7Q2",
    });
    expect(decode(JSON.stringify({ t: PERSONAL, e: 5 }))).toMatchObject({
      token: PERSONAL,
      expiresAt: 5,
      label: null,
    });
    expect(decode(PERSONAL)).toMatchObject({
      token: PERSONAL,
      expiresAt: null,
    });
    // The hint defaults to the token's last four characters.
    expect(JSON.parse(encode({ token: PERSONAL, expiresAt: null })).h).toBe(
      "PPPP",
    );
  });

  it("the store keeps pkeyp_ only: a pkeya_ is refused on write and ignored on read", async () => {
    const { data, mod } = fake();
    const store = await keyringStore(async () => mod);
    expect(() => store.set(A, { token: ADMIN, expiresAt: null })).toThrow();
    expect(data.size).toBe(0);
    data.set(`pkey|${A}`, JSON.stringify({ t: ADMIN, e: null }));
    expect(store.get(A)).toBeNull();
    data.set(`pkey|${A}`, ADMIN);
    expect(store.get(A)).toBeNull();
    expect(() =>
      memoryStore().set(A, { token: ADMIN, expiresAt: null }),
    ).toThrow();
  });

  it("ignores an entry that is not a token", async () => {
    const { data, mod } = fake();
    data.set(`pkey|${A}`, "not-a-token");
    const store = await keyringStore(async () => mod);
    expect(store.get(A)).toBeNull();
  });
});
