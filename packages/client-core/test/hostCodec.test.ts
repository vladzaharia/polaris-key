// The host codec boundary (U-06.1; WIRE-CONTRACT-V5 §13.10, §13.10.7): what `sealPush` sends,
// what `openPull` proves, and that the machine only ever trusts the host's own open result.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  type CloudSyncOptions,
  type Json,
  type OpenedBody,
  type SettingRoute,
  type SyncRequest,
  type WireMutation,
} from "../src/cloud-sync.js";
import {
  SETTINGS_COLLECTION,
  blind,
  isBlindedName,
  memberEnvelopeName,
  openPull,
  openValue,
  openValueAnyName,
  sealPush,
  sealValue,
  webCryptoSyncPort as port,
  type HostCodec,
  type SyncJson,
} from "../src/sync/index.js";

const root = Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 7);
const otherRoot = Uint8Array.from({ length: 32 }, (_, i) => 250 - 5 * i);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

function codecOf(r: Uint8Array, state = { locked: false }): HostCodec {
  return {
    get locked() {
      return state.locked;
    },
    seal: (c, n, v) => sealValue(port, r, c, n, v),
    open: (c, n, e, a) => openValue(port, r, c, n, e, a),
    openAny: (c, e) => openValueAnyName(port, r, c, e),
    blind: (k, ctx, n) => blind(port, r, k, ctx, n),
  };
}
const codec = codecOf(root);

const VOL = "audio.volume";
const BIND = "input.bindings";
const OPEN = "my.private.key";
const routes: SettingRoute[] = [
  { key: VOL, route: "synced", scope: "user", policy: "lastWrite" },
  { key: BIND, route: "synced", scope: "user", policy: "merge" },
];
const sealedCt = async (name: string, v: SyncJson, r = root) =>
  b64(await sealValue(port, r, SETTINGS_COLLECTION, name, v));
const bl = (kind: "setting" | "member", ctx: string, n: string) =>
  blind(port, root, kind, ctx, n);

const push = (mutations: Json[]): Json => ({
  clientId: "c_x",
  cursor: 0,
  atomic: false,
  mutations,
});
const set = (id: number, setting: string, value: Json): Json => ({
  mutationId: id,
  target: { setting, scope: "user" },
  op: "set",
  value,
});

describe("sealPush", () => {
  it("seals a declared key in place, blinds an open key and a member, and sends no plaintext", async () => {
    const out = (await sealPush(
      push([
        set(1, VOL, 0.5),
        set(2, OPEN, "secret-value"),
        {
          mutationId: 3,
          target: { setting: BIND, scope: "user" },
          op: "setMember",
          member: "jump",
          value: "space",
        },
        {
          mutationId: 4,
          target: { setting: BIND, scope: "user" },
          op: "removeMember",
          member: "run",
        },
        { mutationId: 5, target: { setting: VOL, scope: "user" }, op: "clear" },
      ]),
      codec,
      routes,
    )) as { mutations: Array<Record<string, any>> };
    const [a, b, c, d, e] = out.mutations as Array<Record<string, any>>;
    // declared: key clear, value -> ct opening under the key
    expect(a!.target.setting).toBe(VOL);
    expect("value" in a!).toBe(false);
    const ra = await openValue(port, root, "$settings", VOL, unb64(a!.ct));
    expect(ra).toEqual({ ok: true, name: VOL, value: 0.5 });
    // open key: blinded name, envelope names the key
    expect(b!.target.setting).toBe(await bl("setting", "$settings", OPEN));
    expect(isBlindedName(b!.target.setting)).toBe(true);
    expect(
      await openValue(port, root, "$settings", OPEN, unb64(b!.ct)),
    ).toEqual({ ok: true, name: OPEN, value: "secret-value" });
    // member: blind("member", setting, m); value sealed under setting NUL member (D-2)
    expect(c!.target.setting).toBe(BIND);
    expect(c!.member).toBe(await bl("member", BIND, "jump"));
    expect(
      await openValue(
        port,
        root,
        "$settings",
        memberEnvelopeName(BIND, "jump"),
        unb64(c!.ct),
      ),
    ).toEqual({
      ok: true,
      name: memberEnvelopeName(BIND, "jump"),
      value: "space",
    });
    expect(d!.member).toBe(await bl("member", BIND, "run"));
    expect(e).toEqual({
      mutationId: 5,
      target: { setting: VOL, scope: "user" },
      op: "clear",
    });
    const wire = JSON.stringify(out);
    for (const plain of ["secret-value", "space", OPEN, '"jump"', '"run"'])
      expect(wire).not.toContain(plain);
  });

  it("does not change the body it was given", async () => {
    const body = push([set(1, VOL, 0.5)]);
    const before = JSON.stringify(body);
    await sealPush(body, codec, routes);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("a locked codec refuses with sync-locked and seals nothing", async () => {
    let sealed = 0;
    const c: HostCodec = {
      ...codecOf(root),
      locked: true,
      seal: async () => {
        sealed++;
        return new Uint8Array(0);
      },
    };
    await expect(
      sealPush(push([set(1, VOL, 1)]), c, routes),
    ).rejects.toMatchObject({ code: "sync-locked" });
    expect(sealed).toBe(0);
  });

  it("refuses a record mutation of no record operation and a half-valid batch before returning anything", async () => {
    await expect(
      sealPush(
        push([
          set(1, VOL, 1),
          {
            mutationId: 2,
            target: { record: ["slots", "a"] },
            op: "setMember",
            member: "m",
            value: 1,
          },
        ]),
        codec,
        routes,
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      sealPush(push([set(1, VOL, Number.NaN)]), codec, routes),
    ).rejects.toThrow(RangeError);
  });

  it("refuses a member op on an open key", async () => {
    await expect(
      sealPush(
        push([
          {
            mutationId: 1,
            target: { setting: OPEN, scope: "user" },
            op: "setMember",
            member: "m",
            value: 1,
          },
        ]),
        codec,
        routes,
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("round-trips through openPull's reading of the same names", async () => {
    const out = (await sealPush(
      push([set(1, OPEN, { a: 1 })]),
      codec,
      routes,
    )) as { mutations: Array<Record<string, any>> };
    const m = out.mutations[0]!;
    const pulled = await openPull(
      {
        changes: [
          { setting: m.target.setting, scope: "user", ct: m.ct, version: 4 },
        ],
      },
      codec,
    );
    expect((pulled.body as any).changes[0]).toMatchObject({
      setting: OPEN,
      value: { a: 1 },
    });
    expect(pulled.opened.changes).toEqual([{ sealed: true }]);
  });
});

describe("openPull", () => {
  it("opens a declared key, takes seq from version only on plaintext rows, and strips ct", async () => {
    const r = await openPull(
      {
        changes: [
          {
            setting: VOL,
            scope: "user",
            ct: await sealedCt(VOL, 0.3),
            version: 9,
            editedHlc: "h",
          },
          { setting: "legacy", scope: "user", value: 1, version: 2 },
        ],
      },
      codec,
    );
    const ch = (r.body as any).changes;
    expect(ch[0]).toEqual({
      setting: VOL,
      scope: "user",
      value: 0.3,
      version: 9,
      editedHlc: "h",
    });
    expect(ch[1]).toEqual({
      setting: "legacy",
      scope: "user",
      value: 1,
      version: 2,
    });
    expect(r.opened.changes).toEqual([{ sealed: true }, { seq: 2 }]);
  });

  it("strips sealed, invalid and seq the body claims, at every level it reads", async () => {
    const r = await openPull(
      {
        sealed: true,
        changes: [
          {
            setting: "p",
            scope: "user",
            value: 666,
            version: 50,
            sealed: true,
            invalid: false,
            seq: 1,
          },
        ],
        results: [
          { mutationId: 1, status: "ok", version: 1, sealed: true, seq: 1 },
        ],
      },
      codec,
    );
    const b = r.body as any;
    expect(b.sealed).toBeUndefined();
    expect(b.changes[0]).toEqual({
      setting: "p",
      scope: "user",
      value: 666,
      version: 50,
    });
    expect(b.results[0]).toEqual({ mutationId: 1, status: "ok", version: 1 });
    expect(r.opened.changes).toEqual([{ seq: 50 }]);
  });

  it("an unopenable ct is invalid and has no value: wrong root, tampered, wrong name, bad base64", async () => {
    const good = await sealedCt(VOL, 1);
    const tampered = unb64(good);
    tampered[tampered.length - 1]! ^= 1;
    const cases = [
      await sealedCt(VOL, 1, otherRoot),
      b64(tampered),
      await sealedCt("other.key", 1),
      "not base64 !",
      good + "=",
      "",
    ];
    for (const ct of cases) {
      const r = await openPull(
        {
          changes: [{ setting: VOL, scope: "user", ct, value: 7, version: 3 }],
        },
        codec,
      );
      expect((r.body as any).changes[0].value).toBeUndefined();
      expect((r.body as any).changes[0].ct).toBeUndefined();
      expect(r.opened.changes).toEqual([{ invalid: true }]);
    }
  });

  it("a blinded name is accepted only when the opened k re-blinds to it", async () => {
    const honest = await bl("setting", "$settings", OPEN);
    const ct = await sealedCt(OPEN, "v");
    const ok = await openPull(
      { changes: [{ setting: honest, scope: "user", ct, version: 1 }] },
      codec,
    );
    expect((ok.body as any).changes[0].setting).toBe(OPEN);
    // the server moves the envelope under another blinded name
    const other = await bl("setting", "$settings", "another.key");
    const moved = await openPull(
      { changes: [{ setting: other, scope: "user", ct, version: 1 }] },
      codec,
    );
    expect((moved.body as any).changes[0].setting).toBe(other);
    expect((moved.body as any).changes[0].value).toBeUndefined();
    expect(moved.opened.changes).toEqual([{ invalid: true }]);
    // a blinded name with no ct is never plaintext
    const bare = await openPull(
      { changes: [{ setting: honest, scope: "user", value: 1, version: 1 }] },
      codec,
    );
    expect(bare.opened.changes).toEqual([{ seq: 1 }]);
  });

  it("opens a merge setting's members into one value and checks each blinded member", async () => {
    const mk = async (member: string, v: SyncJson) => ({
      member: await bl("member", BIND, member),
      ct: await sealedCt(memberEnvelopeName(BIND, member), v),
      editedHlc: "h",
    });
    const members = [await mk("jump", "space"), await mk("run", "shift")];
    const r = await openPull(
      { changes: [{ setting: BIND, scope: "user", members, version: 5 }] },
      codec,
    );
    expect((r.body as any).changes[0].value).toEqual({
      jump: "space",
      run: "shift",
    });
    expect((r.body as any).changes[0].members).toBeUndefined();
    expect(r.opened.changes).toEqual([{ sealed: true }]);
    // a member moved under another member's blinded name is refused
    const swapped = [
      { ...members[0]!, member: members[1]!.member },
      members[1]!,
    ];
    const bad = await openPull(
      {
        changes: [
          { setting: BIND, scope: "user", members: swapped, version: 5 },
        ],
      },
      codec,
    );
    expect(bad.opened.changes).toEqual([{ invalid: true }]);
    // a member of another merge setting is refused (the D-2 name binds the setting)
    const foreign = {
      member: await bl("member", BIND, "jump"),
      ct: await sealedCt(memberEnvelopeName("other.merge", "jump"), 1),
    };
    const f = await openPull(
      {
        changes: [
          { setting: BIND, scope: "user", members: [foreign], version: 5 },
        ],
      },
      codec,
    );
    expect(f.opened.changes).toEqual([{ invalid: true }]);
  });

  it("opens a conflict's server copy against the mutation's own setting", async () => {
    const mutations = [
      {
        mutationId: 7,
        target: { setting: VOL, scope: "user" },
        op: "set",
        value: 1,
      },
      {
        mutationId: 8,
        target: { setting: OPEN, scope: "user" },
        op: "set",
        value: 1,
      },
    ] as WireMutation[];
    const body: Json = {
      results: [
        {
          mutationId: 7,
          status: "conflict",
          server: { ct: await sealedCt(VOL, 0.9), version: 40, sealed: true },
        },
        {
          mutationId: 8,
          status: "conflict",
          server: { ct: await sealedCt("wrong.name", 1), version: 41 },
        },
        {
          mutationId: 9,
          status: "conflict",
          server: { ct: await sealedCt(VOL, 1), version: 42 },
        },
        {
          mutationId: 10,
          status: "conflict",
          server: { value: 3, version: 3, seq: 0 },
        },
      ],
    };
    const r = await openPull(body, codec, { mutations });
    const res = (r.body as any).results;
    expect(res[0].server).toEqual({ value: 0.9, version: 40 });
    expect(r.opened.conflicts).toEqual({
      7: { sealed: true },
      8: { invalid: true },
      9: { invalid: true }, // no mutation to place it against
      10: { seq: 3 },
    });
  });

  it("maps tombstones of known open keys back to their names", async () => {
    const r = await openPull(
      {
        tombstones: [
          { setting: await bl("setting", "$settings", OPEN), editedHlc: "h" },
          { setting: VOL, editedHlc: "h" },
        ],
      },
      codec,
      { openKeys: [OPEN] },
    );
    expect((r.body as any).tombstones.map((t: any) => t.setting)).toEqual([
      OPEN,
      VOL,
    ]);
  });

  it("renames come from the app, never from the served body", async () => {
    const ct = await sealedCt("old.name", 1);
    const served = {
      changes: [{ setting: "new.name", scope: "user", ct, version: 1 }],
      aliases: { "old.name": "new.name" },
    };
    expect((await openPull(served, codec)).opened.changes).toEqual([
      { invalid: true },
    ]);
    expect(
      (await openPull(served, codec, { aliases: { "old.name": "new.name" } }))
        .opened.changes,
    ).toEqual([{ sealed: true }]);
  });

  it("a locked codec delivers nothing (the host drops the answer)", async () => {
    await expect(
      openPull({ changes: [] }, { ...codecOf(root), locked: true }),
    ).rejects.toMatchObject({ code: "sync-locked" });
  });
});

describe("openPull hardening (security review)", () => {
  it("a repeated mutationId fails the whole answer closed", async () => {
    const mutations = [
      {
        mutationId: 1,
        target: { setting: VOL, scope: "user" },
        op: "set",
        value: 1,
      },
    ] as WireMutation[];
    const body: Json = {
      results: [
        {
          mutationId: 1,
          status: "conflict",
          server: { value: "FORGED", version: 90 },
        },
        {
          mutationId: 1,
          status: "conflict",
          server: { ct: await sealedCt(VOL, 0.9), version: 91 },
        },
      ],
    };
    await expect(openPull(body, codec, { mutations })).rejects.toMatchObject({
      code: "sync-failed",
    });
  });

  it("serves no alias or rename the app did not declare", async () => {
    const mutations = [
      {
        mutationId: 1,
        target: { setting: "old.k", scope: "user" },
        op: "set",
        value: 1,
      },
      {
        mutationId: 2,
        target: { setting: "x.k", scope: "user" },
        op: "set",
        value: 1,
      },
    ] as WireMutation[];
    const body: Json = {
      aliases: { foo: "bar" },
      results: [
        { mutationId: 1, status: "ok", version: 1, renamedTo: "new.k" },
        { mutationId: 2, status: "ok", version: 2, renamedTo: "evil" },
      ],
    };
    const r = await openPull(body, codec, {
      mutations,
      aliases: { "old.k": "new.k" },
    });
    const b = r.body as any;
    expect(b.aliases).toEqual({ "old.k": "new.k" });
    expect(b.results[0].renamedTo).toBe("new.k");
    expect("renamedTo" in b.results[1]).toBe(false);
    expect((await openPull(body, codec)).body).toMatchObject({ aliases: {} });
  });

  it("refuses U+0000 in a setting or member name, on push and on pull", async () => {
    await expect(
      sealPush(push([set(1, "a\0b", 1)]), codec, routes),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      sealPush(
        push([
          {
            mutationId: 1,
            target: { setting: BIND, scope: "user" },
            op: "setMember",
            member: "j\0k",
            value: 1,
          },
        ]),
        codec,
        routes,
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
    // an open key sealed with a NUL by a hostile peer: the name is refused on open
    const nul = "a\0b";
    const r = await openPull(
      {
        changes: [
          {
            setting: await bl("setting", "$settings", nul),
            scope: "user",
            ct: await sealedCt(nul, 1),
            version: 1,
          },
        ],
      },
      codec,
    );
    expect(r.opened.changes).toEqual([{ invalid: true }]);
    // a member name with a NUL, sealed under the setting prefix
    const member = "j\0k";
    const mr = await openPull(
      {
        changes: [
          {
            setting: BIND,
            scope: "user",
            members: [
              {
                member: await bl("member", BIND, member),
                ct: await sealedCt(memberEnvelopeName(BIND, member), 1),
              },
            ],
            version: 1,
          },
        ],
      },
      codec,
    );
    expect(mr.opened.changes).toEqual([{ invalid: true }]);
  });
});

describe("openPull into CloudSyncMachine.receive", () => {
  const T0 = 1_760_000_000_000;
  const ALICE = "sub_alice";
  const opts = (): CloudSyncOptions => ({
    product: "demo",
    catalog: { settings: routes },
    document: { values: { [VOL]: 0.8 }, locked: [] },
    now: T0,
    offsetMs: 0,
    contacted: false,
    subject: ALICE,
    network: "online",
    newClientId: () => `c_${"client1".padStart(22, "0")}`,
    encryption: "e2e",
    hasRoot: true,
  });
  const reply = (over: Record<string, Json>): Json => ({
    encryption: "e2e",
    subject: ALICE,
    cursor: 1,
    more: false,
    serverNow: T0,
    catalogVersion: 1,
    lastMutationId: 0,
    changes: [],
    tombstones: [],
    aliases: {},
    usage: { bytes: 0, settings: 0, records: 0, files: 0 },
    quota: { bytes: 1 << 28, files: true },
    ...over,
  });
  const machineWith = async (
    over: Record<string, Json>,
  ): Promise<CloudSyncMachine> => {
    const m = new CloudSyncMachine(opts());
    const req = m.takeRequests()[0] as SyncRequest;
    expect(req.method).toBe("GET");
    const r = await openPull(reply(over), codec);
    m.receive({ status: 200, body: r.body }, r.opened as OpenedBody);
    return m;
  };

  it("reads a legacy plaintext row below encryptionSince and a sealed row", async () => {
    const m = await machineWith({
      encryptionSince: 10,
      changes: [
        { setting: VOL, scope: "user", value: 0.1, version: 3 },
        {
          setting: BIND,
          scope: "user",
          ct: await sealedCt(BIND, { jump: "space" }),
          version: 11,
        },
      ],
    });
    expect(m.get(VOL)).toEqual({ value: 0.1, from: "cloud" });
    expect(m.settingState(VOL).invalid).toBe(false);
    expect(m.get(BIND)).toEqual({ value: { jump: "space" }, from: "cloud" });
  });

  const documentOnly = (m: CloudSyncMachine): void => {
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.get(VOL)).toEqual({ value: 0.8, from: "document" });
  };

  it("refuses a forged plaintext row at or above encryptionSince, even marked sealed", async () => {
    const forged = {
      setting: VOL,
      scope: "user",
      value: 666,
      version: 50,
      sealed: true,
      seq: 1,
    };
    documentOnly(await machineWith({ encryptionSince: 10, changes: [forged] }));
  });

  it("an unopenable ct falls through to the document", async () => {
    const ct = await sealedCt(VOL, 0.1, otherRoot);
    const row = { setting: VOL, scope: "user", ct, value: 666, version: 4 };
    documentOnly(await machineWith({ encryptionSince: 0, changes: [row] }));
  });

  it("a served aliases map does not make one setting read another", async () => {
    const m = await machineWith({
      encryptionSince: 0,
      aliases: { "audio.alt": VOL },
      changes: [
        {
          setting: VOL,
          scope: "user",
          ct: await sealedCt(VOL, 0.1),
          version: 4,
        },
      ],
    });
    expect(m.get(VOL)).toEqual({ value: 0.1, from: "cloud" });
    expect(m.get("audio.alt").value).not.toBe(0.1);
  });
});

// The merge member's envelope name (D-2, U-06.V): `setting U+0000 member`, pinned by the corpus's
// `envelopeCases` rows, not only by the round trip above.
interface VectorCase {
  id: string;
  rootHex: string;
  name: string;
  envelopeHex: string;
  expect: { result: string; name?: string; reason?: string };
}
const VECTORS = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "sync-vectors.json",
    ),
    "utf8",
  ),
) as { envelopeCases: VectorCase[] };
const row = (id: string): VectorCase => {
  const c = VECTORS.envelopeCases.find((x) => x.id === id);
  if (!c) throw new Error(`no envelope case ${id}`);
  return c;
};
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("merge member envelope names (envelopeCases)", () => {
  const sealMember = row("seal-member");
  const vRoot = unhex(sealMember.rootHex);
  const vCodec = codecOf(vRoot);

  it("memberEnvelopeName is the name the seal-member row carries", () => {
    expect(memberEnvelopeName("inventory", "gold")).toBe(sealMember.name);
    expect(sealMember.name).toBe("inventory\u0000gold");
  });

  const served = async (setting: string, member: string, envHex: string) =>
    ({
      setting,
      scope: "user",
      version: 4,
      members: [
        {
          member: await blind(port, vRoot, "member", setting, member),
          ct: b64(unhex(envHex)),
          editedHlc: "0199c82cc000:0000",
        },
      ],
    }) as Json;
  const pullOf = (change: Json): Json => ({ changes: [change] });

  it("opens the corpus member envelope as that member of that setting", async () => {
    const out = await openPull(
      pullOf(await served("inventory", "gold", sealMember.envelopeHex)),
      vCodec,
    );
    expect((out.body as any).changes[0].value).toEqual({ gold: 3 });
    expect(out.opened.changes).toEqual([{ sealed: true }]);
  });

  it("member-swapped: the envelope of another member under this blinded name is invalid", async () => {
    const c = row("member-swapped");
    expect(c.expect.reason).toBe("name");
    const out = await openPull(
      pullOf(await served("inventory", "silver", c.envelopeHex)),
      vCodec,
    );
    expect(out.opened.changes).toEqual([{ invalid: true }]);
  });

  it("member-wrong-setting: the member moved to another merge setting is invalid", async () => {
    const c = row("member-wrong-setting");
    expect(c.expect.reason).toBe("name");
    const out = await openPull(
      pullOf(await served("equipment", "gold", c.envelopeHex)),
      vCodec,
    );
    expect(out.opened.changes).toEqual([{ invalid: true }]);
  });

  it("member-name-only: a reader that binds the bare member name refuses the envelope", async () => {
    const c = row("member-name-only");
    expect(c.name).toBe("gold");
    expect(
      await openValue(port, vRoot, "$settings", c.name, unhex(c.envelopeHex)),
    ).toEqual({ ok: false, reason: "name" });
  });
});
