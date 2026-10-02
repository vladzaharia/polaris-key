// Unit proofs for P4-19's client side (plans/P4-19.md §2.3–§2.7): the pack engine's delegated
// surface (a feed target installs through its delegation; a stamp pin never does), the data-only
// rule before any payload byte is fetched and while files are written, `PackInstall.delegation`
// and its reload, delegation revocations (`pack-revoked`, detail `delegation`), and
// `runUpdateCheck`'s step 11 relevance and decision-input expansion. The corpus pins every
// verdict across SDKs (`delegationCases`, `dataOnlyCases`); these pin the I/O around them.
//
// @pkey-feature packs.delegation

import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import type { ChannelFeedDoc } from "@polaris-key/protocol/update";
import { MAX_DELEGATIONS_PER_CHECK } from "@polaris-key/protocol/core";
import {
  PackEngine,
  PackError,
  dataOnlyFileRefusal,
  memoryPackStateStore,
  memoryPackStorage,
  runUpdateCheck,
  verifyRevocation,
  type PackEngineOptions,
  type PackStateStore,
  type ZstdPort,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  byteServer,
  contentKeyPair,
  delegationFor,
  delegationRevocationFor,
  revocationFor,
  sha,
  signFeedDoc,
  signReleaseDoc,
  treePack,
  type TreePack,
} from "./packFixtures.js";

const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

let plans = 0;
function engine(
  o: Partial<PackEngineOptions> & {
    server: ReturnType<typeof byteServer>;
    delegations: Map<string, string>;
  },
): PackEngine {
  const { server, delegations, ...rest } = o;
  return new PackEngine({
    product: PRODUCT,
    releaseKeys: RELEASE_KEYS,
    productTrust: () => PRODUCT_TRUST,
    stamp: { contentApi: 1, pins: [], expects: [] },
    prefs: { engine: null, axes: {} },
    zstd,
    sha256: () => {
      const chunks: Uint8Array[] = [];
      return {
        update: (b) => void chunks.push(b),
        digest: () => sha(Buffer.concat(chunks)),
      };
    },
    patchMethods: [],
    memBudget: 1 << 30,
    storage: memoryPackStorage(),
    state: memoryPackStateStore(),
    fetchRecord: async (h) => {
      const d = delegations.get(h);
      return d !== undefined ? { ok: true, body: d } : server.fetchRecord(h);
    },
    fetchObject: (r) => server.fetchObject(r),
    now: () => 1759400000,
    newPlanId: () => `plan-${++plans}`,
    ...rest,
  });
}

const target = (p: TreePack) => ({
  pack: p.packId,
  release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
});

async function fixture(files: Record<string, string> = { "a.json": "{}" }) {
  const ck = contentKeyPair();
  const d = await delegationFor({
    deliverable: "djdl.events",
    publicKey: ck.pub,
  });
  const pack = await treePack({
    packId: "djdl.events.halloween",
    version: "1.0.0",
    seq: 1,
    files,
    issuedAt: 1759250000,
    signer: { pem: ck.pem, kid: d.kid },
  });
  const delegations = new Map([[d.sha256, d.jws]]);
  return { ck, d, pack, delegations, server: byteServer(pack) };
}

describe("PackEngine and delegated releases (plans/P4-19.md §2.4, §2.5)", () => {
  it("installs a delegated feed target, stores its delegation, and reloads it", async () => {
    const { d, pack, delegations, server } = await fixture({
      "lore/a.json": '{"spooky": true}',
      "img/banner.png": "\u0089PNG\r\n\u001a\nbanner",
    });
    const state = memoryPackStateStore();
    const storage = memoryPackStorage();
    const e = engine({ server, delegations, state, storage });
    await e.load();
    const [install] = await e.ensureReleases([target(pack)]);
    expect(install!.delegation).toBe(d.jws);
    expect(e.delegatedReleases()).toEqual({
      [pack.recordSha256]: { pack: pack.packId, delegation: d.sha256 },
    });
    // A fresh engine over the same state re-verifies the install through its delegation, with
    // no network (an installed release stays valid after its window).
    const again = engine({
      server: byteServer(),
      delegations: new Map(),
      state,
      storage,
    });
    await again.load();
    expect(again.state().active[pack.packId]?.recordSha256).toBe(
      pack.recordSha256,
    );
    expect(again.state().running[pack.packId]).toBeDefined();
  });

  it("never takes the delegated path for the stamp's pin (a release-key surface)", async () => {
    const { pack, delegations, server } = await fixture();
    const e = engine({
      server,
      delegations,
      stamp: {
        contentApi: 1,
        pins: [target(pack)],
        expects: [{ pack: pack.packId, required: true, delivery: "essential" }],
      },
    });
    await e.load();
    await expect(e.ensure([pack.packId])).rejects.toMatchObject({
      code: "record-rejected",
      detail: "jws",
    });
  });

  it("refuses a file off the extension allow-list before any payload object is fetched", async () => {
    const { pack, delegations, server } = await fixture({
      "a.json": "{}",
      "scene.tres": "[gd_resource]",
    });
    const e = engine({ server, delegations });
    await e.load();
    const err = await e.ensureReleases([target(pack)]).catch((x) => x);
    expect(err).toBeInstanceOf(PackError);
    expect(err).toMatchObject({
      code: "pack-not-data-only",
      detail: "extension",
      path: "scene.tres",
    });
    // Only the files index was fetched.
    expect(server.calls.map((c) => c.sha256)).toEqual([pack.indexSha256]);
    // `estimate` reports the same refusal.
    const est = await e.estimateReleases([target(pack)]);
    expect(est.refused).toEqual([
      { packId: pack.packId, code: "pack-not-data-only" },
    ]);
  });

  it("refuses an allowed extension carrying a Godot resource head while writing, and discards the plan", async () => {
    const { pack, delegations, server } = await fixture({
      "a.json": "{}",
      "b.json": "RSRC\u0000\u0000\u0000\u0000",
    });
    const state = memoryPackStateStore();
    const e = engine({ server, delegations, state });
    await e.load();
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "pack-not-data-only",
      detail: "content",
      path: "b.json",
    });
    expect(e.state().active[pack.packId]).toBeUndefined();
    expect(e.state().inflight[pack.packId]).toBeUndefined();
    expect(dataOnlyFileRefusal("b.json", pack.files["b.json"]!)).toBe(
      "content",
    );
  });

  it("refuses a release under a revoked delegation (pack-revoked, detail delegation) and unmounts it", async () => {
    const { d, pack, delegations, server } = await fixture();
    const e = engine({ server, delegations });
    await e.load();
    await e.ensureReleases([target(pack)]);
    expect(e.state().running[pack.packId]).toBeDefined();
    const rev = await delegationRevocationFor(d, "djdl.events");
    const v = await verifyRevocation(rev.jws, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
      entry: rev.entry,
    });
    if (!v.ok) throw new Error(v.step);
    await e.recordRevocations([{ revocation: v.revocation, jws: rev.jws }]);
    expect(e.state().running[pack.packId]).toBeUndefined();
    expect(e.revokedBy(pack.recordSha256, d.sha256)).toBe("delegation");
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "pack-revoked",
      detail: "delegation",
    });
  });

  it("re-sniffs a reused install on a noop plan: same payload, release-signed first (Amendment A1)", async () => {
    const files = {
      "cfg.txt": 'x = Object(GDScript,"script/source":"extends Node")\n',
    };
    const released = await treePack({
      packId: "djdl.events.halloween",
      version: "0.9.0",
      seq: 1,
      files,
    });
    const ck = contentKeyPair();
    const d = await delegationFor({
      deliverable: "djdl.events",
      publicKey: ck.pub,
    });
    const delegated = await treePack({
      packId: "djdl.events.halloween",
      version: "1.0.0",
      seq: 2,
      files,
      issuedAt: 1759250000,
      signer: { pem: ck.pem, kid: d.kid },
    });
    expect(delegated.treeDigest).toBe(released.treeDigest);
    const server = byteServer(released, delegated);
    const e = engine({
      server,
      delegations: new Map([[d.sha256, d.jws]]),
    });
    await e.load();
    await e.ensureReleases([target(released)]);
    const before = server.calls.length;
    await expect(e.ensureReleases([target(delegated)])).rejects.toMatchObject({
      code: "pack-not-data-only",
      detail: "content",
      path: "cfg.txt",
    });
    expect(e.state().active[released.packId]?.recordSha256).toBe(
      released.recordSha256,
    );
    // A noop plan: no payload object was fetched for the delegated release.
    expect(
      server.calls.slice(before).some((c) => c.sha256 === delegated.fullSha256),
    ).toBe(false);
  });

  it("never takes the delegated path for the stamp's hold for the pack (a release-key surface)", async () => {
    const { pack, delegations, server } = await fixture();
    const e = engine({
      server,
      delegations,
      stamp: {
        contentApi: 1,
        pins: [],
        expects: [],
        holds: [{ ...target(pack), reason: "held" }],
      } as unknown as PackEngineOptions["stamp"],
    });
    await e.load();
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "record-rejected",
      detail: "jws",
    });
  });

  it("never takes the delegated path for a stored revocation's replacement", async () => {
    const { pack, delegations } = await fixture();
    const old = await treePack({
      packId: pack.packId,
      version: "0.9.0",
      seq: 1,
      files: { "a.json": "[]" },
    });
    const rev = await revocationFor(old, { replacement: pack });
    const v = await verifyRevocation(rev.jws, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
      entry: rev.entry,
    });
    if (!v.ok) throw new Error(v.step);
    const e = engine({ server: byteServer(old, pack), delegations });
    await e.load();
    await e.recordRevocations([{ revocation: v.revocation, jws: rev.jws }]);
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "record-rejected",
      detail: "jws",
    });
  });

  it(`fetches at most MAX_DELEGATIONS_PER_CHECK (${MAX_DELEGATIONS_PER_CHECK}) distinct delegations per call`, async () => {
    const ck = contentKeyPair();
    const delegations = new Map<string, string>();
    const packs: TreePack[] = [];
    for (let k = 0; k <= MAX_DELEGATIONS_PER_CHECK; k++) {
      const d = await delegationFor({
        deliverable: "djdl.events",
        publicKey: ck.pub,
        seq: k + 1,
      });
      delegations.set(d.sha256, d.jws);
      packs.push(
        await treePack({
          packId: `djdl.events.p${k}`,
          version: "1.0.0",
          seq: 1,
          files: { "a.json": `[${k}]` },
          issuedAt: 1759250000,
          signer: { pem: ck.pem, kid: d.kid },
        }),
      );
    }
    const e = engine({ server: byteServer(...packs), delegations });
    await e.load();
    const est = await e.estimateReleases(packs.map(target));
    expect(est.packs).toHaveLength(MAX_DELEGATIONS_PER_CHECK);
    expect(est.refused).toEqual([
      {
        packId: `djdl.events.p${MAX_DELEGATIONS_PER_CHECK}`,
        code: "network-error",
      },
    ]);
    // The next call has a fresh bound, and the fetched delegations are kept in the process.
    const again = await e.estimateReleases([target(packs.at(-1)!)]);
    expect(again.refused).toEqual([]);
  });

  it("at boot, a stored delegation revocation keeps the delegated install from running (pack-revoked, detail delegation)", async () => {
    const { d, pack, delegations, server } = await fixture();
    const state = memoryPackStateStore();
    const storage = memoryPackStorage();
    const revocations = memoryPackStateStore();
    const e = engine({ server, delegations, state, storage, revocations });
    await e.load();
    await e.ensureReleases([target(pack)]);
    const rev = await delegationRevocationFor(d, "djdl.events");
    const v = await verifyRevocation(rev.jws, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
      entry: rev.entry,
    });
    if (!v.ok) throw new Error(v.step);
    await e.recordRevocations([{ revocation: v.revocation, jws: rev.jws }]);
    const boot = engine({
      server: byteServer(),
      delegations: new Map(),
      state,
      storage,
      revocations,
    });
    await boot.load();
    expect(boot.state().active[pack.packId]?.recordSha256).toBe(
      pack.recordSha256,
    );
    expect(boot.state().running[pack.packId]).toBeUndefined();
    await expect(boot.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "pack-revoked",
      detail: "delegation",
    });
  });

  it("a delegated variant carrying a chunk index still passes every written file through the data-only sink", async () => {
    // P4-22 lets a variant carry `chunks`; whatever strategy installs it, the engine's applier
    // writes through the wrapped tree sink, so the head sniff still sees the file.
    const ck = contentKeyPair();
    const d = await delegationFor({
      deliverable: "djdl.events",
      publicKey: ck.pub,
    });
    const pack = await treePack({
      packId: "djdl.events.halloween",
      version: "1.0.0",
      seq: 1,
      files: { "a.json": "{}", "b.json": "[gd_resource]" },
      issuedAt: 1759250000,
      signer: { pem: ck.pem, kid: d.kid },
      variantExtra: {
        chunks: {
          format: "pkey-chunks/1",
          sha256: sha("chunk index"),
          bytes: 64,
          size: 64,
          codec: "none",
        },
      },
    });
    const e = engine({
      server: byteServer(pack),
      delegations: new Map([[d.sha256, d.jws]]),
      strategies: ["chunk", "delta", "file", "full"],
    });
    await e.load();
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "pack-not-data-only",
      detail: "content",
      path: "b.json",
    });
  });

  it("refuses a delegated record whose delegation cannot be fetched, with the fetch's code", async () => {
    const { pack, server } = await fixture();
    const e = engine({ server, delegations: new Map() });
    await e.load();
    await expect(e.ensureReleases([target(pack)])).rejects.toMatchObject({
      code: "not_found",
      detail: "delegation",
    });
  });

  it("drops a stored delegated install whose delegation was tampered with", async () => {
    const { pack, delegations, server } = await fixture();
    const state = memoryPackStateStore();
    const storage = memoryPackStorage();
    const e = engine({ server, delegations, state, storage });
    await e.load();
    await e.ensureReleases([target(pack)]);
    const doc = JSON.parse((await state.read())!) as {
      active: Record<string, { delegation?: string }>;
    };
    const other = await delegationFor({
      deliverable: "djdl.events",
      publicKey: contentKeyPair().pub,
    });
    doc.active[pack.packId]!.delegation = other.jws;
    const tampered: PackStateStore = memoryPackStateStore();
    await tampered.replace(JSON.stringify(doc));
    const again = engine({
      server: byteServer(),
      delegations: new Map(),
      state: tampered,
      storage,
    });
    await again.load();
    expect(again.state().active[pack.packId]).toBeUndefined();
  });
});

describe("runUpdateCheck and delegation revocations (plans/P4-19.md §2.7)", () => {
  const NOW = 1_759_400_100;
  async function setup(o: { kind?: "delegation" } = { kind: "delegation" }) {
    const { d, pack } = await fixture();
    const appJws = await signReleaseDoc({
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: "app",
      kind: "app",
      version: "1.5.0",
      seq: 15,
      issuedAt: 1_759_000_000,
      builds: [
        {
          id: "macos-dmg",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          artifacts: [
            { name: "a.dmg", role: "payload", sha256: sha("a"), size: 1 },
          ],
        },
      ],
    });
    const rev = await delegationRevocationFor(d, "djdl.events");
    const { kind: _k, ...plain } = rev.entry;
    const feed: ChannelFeedDoc = {
      schemaVersion: 1,
      iss: "key.plrs.im",
      aud: PRODUCT,
      channel: "stable",
      selector: {},
      seq: 7,
      issuedAt: NOW - 100,
      expiresAt: NOW + 800,
      app: {
        deliverable: "app",
        versionScheme: "semver",
        targets: [
          {
            platform: "macos",
            release: { sha256: sha(appJws), seq: 15, version: "1.5.0" },
            floor: null,
            critical: false,
            outlets: {
              direct: {
                kind: "direct",
                live: { version: "1.5.0", seq: 15 },
                halted: false,
              },
            },
          },
        ],
      },
      revocations: [o.kind ? rev.entry : plain],
    };
    const feedJws = await signFeedDoc(feed);
    const records = new Map<string, string>([
      [sha(appJws), appJws],
      [rev.record, rev.jws],
    ]);
    const fetched: string[] = [];
    const opts = {
      channel: "stable",
      expectedAud: PRODUCT,
      trust: PRODUCT_TRUST,
      releaseKeys: RELEASE_KEYS,
      now: NOW,
      installId: "dev_1",
      installed: {
        version: "1.5.0",
        buildNumber: null,
        platform: "macos",
        arch: "arm64",
        format: null,
        engine: null,
      },
      outlet: { id: "direct", kind: "direct" as const },
      subkind: null,
      methods: ["download" as const],
      cache: {},
      fetchFeed: async () => ({ ok: true as const, body: feedJws }),
      fetchRecord: async (h: string) => {
        fetched.push(h);
        const b = records.get(h);
        return b
          ? { ok: true as const, body: b }
          : { ok: false as const, code: "network-error" };
      },
      content: {
        stamp: {
          contentApi: 1,
          pins: [],
          expects: [
            { pack: pack.packId, required: true, delivery: "essential" },
          ],
        },
        holds: [],
        active: { [pack.packId]: target(pack).release },
        engine: null,
        axes: {},
        revoked: {},
        relearn: [],
        delegated: {
          [pack.recordSha256]: { pack: pack.packId, delegation: d.sha256 },
        },
      },
    };
    return { d, pack, rev, opts, fetched };
  }

  it("learns a delegation revocation for an active delegated install and revokes the release for the decision", async () => {
    const { rev, opts } = await setup();
    const r = await runUpdateCheck(opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.revocations?.learned.map((l) => l.revocation.record)).toEqual([
      rev.record,
    ]);
    expect(r.check.decision).toMatchObject({
      action: "blocked",
      reason: "revoked-content",
    });
  });

  it("treats a delegation entry as relevant by scope even with no known delegated release", async () => {
    const { rev, opts } = await setup();
    const r = await runUpdateCheck({
      ...opts,
      content: { ...opts.content, delegated: {} },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // djdl.events covers djdl.events.halloween (an expected, active pack): fetched and stored,
    // but with no known delegated release nothing is revoked for the decision.
    expect(r.revocations?.learned.map((l) => l.revocation.record)).toEqual([
      rev.record,
    ]);
    expect(r.check.decision).not.toMatchObject({ reason: "revoked-content" });
  });

  it("does not consider an entry without kind whose target is a delegation (not in H)", async () => {
    const { opts, fetched, rev } = await setup({});
    const r = await runUpdateCheck(opts);
    expect(r.ok).toBe(true);
    expect(fetched).not.toContain(rev.record);
  });
});
