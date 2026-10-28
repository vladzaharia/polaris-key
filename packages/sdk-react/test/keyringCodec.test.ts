// @vitest-environment node
//
// @pkey-feature sync.keyring
//
// U-20.1: the browser host codec over the ring's derived keys. Real WebCrypto; the root is a
// non-extractable handle in a memory vault, and the codec's output is checked against client-core's
// own functions run on the raw root bytes (which only this test holds).

import { describe, expect, it } from "vitest";
import {
  SETTINGS_COLLECTION,
  blind,
  deriveKid,
  memberEnvelopeName,
  openPull,
  openValue,
  openValueAnyName,
  sealPush,
  sealValue,
  webCryptoSyncPort as P,
} from "@polaris-key/client-core/sync";
import { ringCodec } from "../src/browser/ring/codec.js";
import {
  importRootHandle,
  memoryRootVault,
  ringKeysOf,
} from "../src/browser/ring/rootVault.js";

const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const hexOf = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function rig(root: Uint8Array = RAW) {
  const vault = memoryRootVault();
  await vault.put({
    v: 1,
    ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
    epoch: 1,
    kid: hexOf(await deriveKid(P, root)),
    key: await importRootHandle(root),
  });
  let held = true;
  const codec = ringCodec({
    hasRoot: () => held,
    ringKeys: async () => {
      const rec = await vault.get();
      return rec ? ringKeysOf(rec, P) : null;
    },
  });
  return {
    codec,
    vault,
    lock: async () => {
      held = false;
      await vault.clear();
    },
  };
}

describe("ring codec", () => {
  it("seals what client-core opens with the raw root, and the reverse", async () => {
    const { codec } = await rig();
    const env = await codec.seal(SETTINGS_COLLECTION, "volume", { a: [1, 2] });
    expect(await openValue(P, RAW, SETTINGS_COLLECTION, "volume", env)).toEqual(
      { ok: true, name: "volume", value: { a: [1, 2] } },
    );
    const theirs = await sealValue(P, RAW, SETTINGS_COLLECTION, "k", "v");
    expect(await codec.open(SETTINGS_COLLECTION, "k", theirs)).toEqual({
      ok: true,
      name: "k",
      value: "v",
    });
    expect(await codec.openAny(SETTINGS_COLLECTION, theirs)).toEqual({
      ok: true,
      name: "k",
      value: "v",
    });
    expect(
      await openValueAnyName(P, RAW, SETTINGS_COLLECTION, env),
    ).toMatchObject({ ok: true, name: "volume" });
  });

  it("opens an alias source and refuses a wrong name, collection or root", async () => {
    const { codec } = await rig();
    const env = await codec.seal(SETTINGS_COLLECTION, "old", 1);
    expect(await codec.open(SETTINGS_COLLECTION, "new", env, ["old"])).toEqual({
      ok: true,
      name: "old",
      value: 1,
    });
    expect(await codec.open(SETTINGS_COLLECTION, "new", env)).toEqual({
      ok: false,
      reason: "name",
    });
    expect(await codec.open("$other", "old", env)).toMatchObject({
      ok: false,
      reason: "auth",
    });
    const foreign = await rig(OTHER);
    expect(await foreign.codec.open(SETTINGS_COLLECTION, "old", env)).toEqual({
      ok: false,
      reason: "kid",
    });
  });

  it("blinds exactly as client-core does for every kind", async () => {
    const { codec } = await rig();
    for (const kind of [
      "setting",
      "member",
      "record",
      "field",
      "element",
    ] as const)
      expect(await codec.blind(kind, "ctx", "name")).toBe(
        await blind(P, RAW, kind, "ctx", "name"),
      );
  });

  it("a member's envelope name is setting, U+0000, member", async () => {
    const { codec } = await rig();
    const name = memberEnvelopeName("tags", "red");
    expect(name).toBe("tags\0red");
    const env = await codec.seal(SETTINGS_COLLECTION, name, true);
    expect(await codec.openAny(SETTINGS_COLLECTION, env)).toEqual({
      ok: true,
      name: "tags\0red",
      value: true,
    });
  });

  it("refuses U+0000 anywhere else", async () => {
    const { codec } = await rig();
    await expect(
      codec.seal(SETTINGS_COLLECTION, "a\0b\0c", 1),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(codec.blind("setting", "ctx", "a\0b")).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect(codec.blind("member", "c\0x", "m")).rejects.toMatchObject({
      code: "invalid-options",
    });
  });

  it("is locked with sync-locked once the vault is cleared, and seals nothing", async () => {
    const r = await rig();
    expect(r.codec.locked).toBe(false);
    await r.lock();
    expect(r.codec.locked).toBe(true);
    for (const f of [
      () => r.codec.seal(SETTINGS_COLLECTION, "k", 1),
      () => r.codec.open(SETTINGS_COLLECTION, "k", new Uint8Array(113)),
      () => r.codec.openAny(SETTINGS_COLLECTION, new Uint8Array(113)),
      () => r.codec.blind("setting", SETTINGS_COLLECTION, "k"),
    ])
      await expect(f()).rejects.toMatchObject({ code: "sync-locked" });
    await expect(
      sealPush({ mutations: [] }, r.codec, []),
    ).rejects.toMatchObject({ code: "sync-locked" });
  });

  it("never exposes the root: the handle is not extractable and the keys carry no root bytes", async () => {
    const r = await rig();
    const rec = (await r.vault.get())!;
    expect(rec.key.extractable).toBe(false);
    await expect(
      globalThis.crypto.subtle.exportKey("raw", rec.key),
    ).rejects.toThrow();
    const keys = ringKeysOf(rec, P);
    // The placeholder handed to `withRoot` is not the root.
    const seen = await keys.withRoot(async (_p, root) => root);
    expect(seen).not.toEqual(RAW);
    expect(hexOf(seen)).toBe("00".repeat(32));
  });

  it("drives the host boundary: sealPush and openPull round-trip through it", async () => {
    const { codec } = await rig();
    const sent = (await sealPush(
      {
        mutations: [
          {
            mutationId: 1,
            op: "set",
            target: { setting: "theme" },
            value: "dark",
          },
          {
            mutationId: 2,
            op: "set",
            target: { setting: "open.key" },
            value: 7,
          },
          {
            mutationId: 3,
            op: "setMember",
            target: { setting: "tags" },
            member: "red",
            value: 1,
          },
        ],
      },
      codec,
      [{ key: "theme" }, { key: "tags" }] as never,
    )) as { mutations: Array<Record<string, unknown>> };
    const [a, b, c] = sent.mutations;
    expect(a!.target).toEqual({ setting: "theme" });
    expect(a!.ct).toEqual(expect.any(String));
    expect(a).not.toHaveProperty("value");
    expect(b!.target).toEqual({
      setting: await blind(P, RAW, "setting", SETTINGS_COLLECTION, "open.key"),
    });
    expect(c!.member).toBe(await blind(P, RAW, "member", "tags", "red"));

    const { body, opened } = await openPull(
      {
        changes: [
          { setting: "theme", ct: a!.ct, version: 4 },
          { setting: (b!.target as { setting: string }).setting, ct: b!.ct },
          { setting: "tags", members: [{ member: c!.member, ct: c!.ct }] },
        ],
      } as never,
      codec,
    );
    const ch = (body as { changes: Array<Record<string, unknown>> }).changes;
    expect(ch[0]).toMatchObject({ setting: "theme", value: "dark" });
    expect(ch[1]).toMatchObject({ setting: "open.key", value: 7 });
    expect(ch[2]).toMatchObject({ setting: "tags", value: { red: 1 } });
    expect(opened.changes).toEqual([
      { sealed: true },
      { sealed: true },
      { sealed: true },
    ]);
  });

  it("a blinded name that does not re-blind to the served one reads as invalid", async () => {
    const { codec } = await rig();
    const env = await codec.seal(SETTINGS_COLLECTION, "real", 1);
    const wrong = await blind(P, RAW, "setting", SETTINGS_COLLECTION, "other");
    const { opened } = await openPull(
      {
        changes: [
          { setting: wrong, ct: Buffer.from(env).toString("base64url") },
        ],
      },
      codec,
    );
    expect(opened.changes).toEqual([{ invalid: true }]);
  });
});
