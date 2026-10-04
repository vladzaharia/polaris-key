/**
 * P5-08 — `pkey transport …` against golden files and a fake App Store Connect:
 *
 *   - apple-ba package: Manifest.json (asset pack `<pack>-c<contentApi>`, the delivery's download
 *     policy, the file selector), the payload and its marker under `pkey/<assetPackId>/`, the
 *     inputs record, `xcrun ba-package` through the exec seam (and refused off macOS), the
 *     `pending` report;
 *   - apple-ba upload: the exact App Store Connect sequence (find or create, version, manifest and
 *     archive upload files, their parts, commits), the lock file, the refusals — colliding pack ids
 *     (`x.foes`/`x-foes`), a double hyphen (`x-.foes`), a 62-character pack id — each a typed error
 *     BEFORE any request, and an asset pack whose resource is not the recorded one refused;
 *   - play-pad modules: the asset-pack module (fast-follow), `pkey/` and `pkey#tcf_astc/`, and
 *     Godot 4.7.2's Gradle template patched idempotently;
 *   - steam-depot vdf: the app and depot build VDFs, SetLive only on a named branch;
 *   - the data-only gate and the payload re-hash before any transport writes.
 */

import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { TransportIdError } from "@polaris-key/manifest";
import {
  AscUploadError,
  baPackage,
  baUpload,
  padModules,
  patchAppGradle,
  patchSettingsGradle,
  publishPack,
  runPkey,
  steamVdf,
  type TransportCommon,
} from "../src/index.js";
import { runAction } from "../src/action.js";
import { capture, cleanup, instant, json } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  kaykitUnstripped,
  kaykitForbidden,
  kaykitV2,
  packRepo,
  packServer,
  sha,
  SLUG,
  testReleaseKey,
  writeTestPck,
  type PackRepoOptions,
} from "./packFixtures.js";

afterEach(cleanup);

const key = testReleaseKey();
const GOLDEN = path.join(import.meta.dirname, "fixtures/transport");
const GODOT_ANDROID = path.join(GOLDEN, "godot-android-4.7.2");
const CI_TOKEN = `pkeyci_${"C".repeat(43)}`;

const DISTRIBUTION_YAML = `outlets:
  app-store:
    appleId: "1234567890"
    bundleId: gg.vlad.diceroll
  testflight:
    appleId: "1234567890"
    bundleId: gg.vlad.diceroll
  play:
    packageName: gg.vlad.diceroll
  steam:
    appId: 480
    branches: { beta: beta }
  web: {}
transports:
  packs:
    app-store: apple-ba
    testflight: apple-ba
    play: play-pad
    steam: steam-depot
`;

/** Compare with a golden file; `PKEY_UPDATE_GOLDEN=1` rewrites it. */
async function golden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN, name);
  if (process.env.PKEY_UPDATE_GOLDEN === "1") {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, actual);
  }
  expect(actual).toBe(await readFile(file, "utf8"));
}

interface Reported {
  outlet: string;
  state: string;
  deliverable: string;
  version: string;
  platformRef: Record<string, unknown>;
}

/** A product with core3d published to `cache/`, plus a fake Polaris Key that records reports. */
async function published(
  o: PackRepoOptions & {
    files?: Record<string, Uint8Array>;
    distribution?: string;
    variants?: boolean;
  } = {},
) {
  const files = o.files ?? {
    ...(o.variants
      ? {
          "texture=astc/diceroll.core3d.pck": writeTestPck(kaykitUnstripped()),
          "texture=etc2/diceroll.core3d.pck": writeTestPck([
            ...kaykitUnstripped(),
            ["assets/kaykit/etc2.txt", new TextEncoder().encode("etc2")],
          ]),
        }
      : { "default/diceroll.core3d.pck": writeTestPck(kaykitUnstripped()) }),
  };
  const cwd = await packRepo(key, files, {
    ...o,
    ...(o.variants
      ? { core3dVariants: "      variants:\n        texture: [astc, etc2]\n" }
      : {}),
  });
  await writeFile(
    path.join(cwd, ".pkey/distribution.yaml"),
    o.distribution ?? DISTRIBUTION_YAML,
  );
  const server = packServer();
  const io = capture();
  await publishPack({
    cwd,
    product: SLUG,
    deliverable: "diceroll.core3d",
    version: "1.0.0",
    dir: "dist",
    out: "cache",
    baseUrl: BASE,
    env: actionsEnv(),
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: server.fetchImpl,
    sleep: instant,
    releaseKeyPem: key.pem,
    now: 1_759_300_000,
  });
  const jws = (
    await readFile(
      path.join(cwd, "cache/diceroll.core3d/1.0.0/record.jws"),
      "utf8",
    )
  ).trim();
  const reports: Reported[] = [];
  const pk = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/${SLUG}/distribution/report`) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      reports.push({
        outlet: body.outlet as string,
        state: body.state as string,
        deliverable: body.deliverable as string,
        version: body.version as string,
        platformRef: body.platformRef as Record<string, unknown>,
      });
      return json({
        ok: true,
        availability: {
          releaseId: `${String(body.deliverable)}@${String(body.version)}`,
          outletId: body.outlet,
          state: body.state,
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { cwd, jws, reports, pk };
}

function common(
  w: { cwd: string; pk: typeof fetch },
  over: Partial<TransportCommon> = {},
) {
  const io = capture();
  return {
    io,
    c: {
      cwd: w.cwd,
      deliverable: "diceroll.core3d",
      version: "1.0.0",
      product: SLUG,
      baseUrl: BASE,
      env: { PKEY_CI_TOKEN: CI_TOKEN } as Record<string, string | undefined>,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: w.pk,
      sleep: instant,
      ...over,
    } satisfies TransportCommon,
  };
}

const markerOf = (jws: string) =>
  `${JSON.stringify(
    {
      format: "pkey-marker/1",
      packId: "diceroll.core3d",
      version: "1.0.0",
      release: jws,
    },
    null,
    2,
  )}\n`;

// ── apple-ba package ─────────────────────────────────────────────────────────────────────────

describe("pkey transport apple-ba package", () => {
  it("writes Manifest.json, the payload and its marker, the inputs, archives and reports pending", async () => {
    const w = await published();
    const { c, io } = common(w);
    const execs: [string, string[], string][] = [];
    const r = await baPackage({
      ...c,
      from: "cache",
      platform: "darwin",
      exec: (cmd, args, cwd) => execs.push([cmd, args, cwd]),
    });
    expect(io.err()).toBe("");
    expect(r.assetPackId).toBe("diceroll-core3d-c4");
    const dir = path.join(w.cwd, "build/pkey-transport/apple-ba");
    await golden(
      "apple-ba/Manifest.essential.json",
      await readFile(
        path.join(dir, "diceroll-core3d-c4/Manifest.json"),
        "utf8",
      ),
    );
    const content = path.join(
      dir,
      "diceroll-core3d-c4/pkey/diceroll-core3d-c4",
    );
    expect((await readdir(content)).sort()).toEqual([
      "diceroll-core3d-c4.pck",
      "diceroll-core3d-c4.pck.pkey.json",
    ]);
    const pck = await readFile(path.join(content, "diceroll-core3d-c4.pck"));
    expect(
      await readFile(
        path.join(content, "diceroll-core3d-c4.pck.pkey.json"),
        "utf8",
      ),
    ).toBe(markerOf(w.jws));
    const inputs = JSON.parse(
      await readFile(path.join(dir, "diceroll-core3d-c4.inputs.json"), "utf8"),
    );
    expect(inputs).toMatchObject({
      format: "pkey-ba-inputs/1",
      assetPackId: "diceroll-core3d-c4",
      packId: "diceroll.core3d",
      version: "1.0.0",
      contentApi: 4,
      recordSha256: sha(w.jws),
      payloadSha256: sha(pck),
    });
    expect(execs).toEqual([
      [
        "xcrun",
        [
          "ba-package",
          "package",
          "Manifest.json",
          "-o",
          path.join(dir, "diceroll-core3d-c4.aar"),
        ],
        path.join(dir, "diceroll-core3d-c4"),
      ],
    ]);
    expect(w.reports).toEqual(
      ["app-store", "testflight"].map((outlet) => ({
        outlet,
        state: "pending",
        deliverable: "diceroll.core3d",
        version: "1.0.0",
        platformRef: {
          assetPackIdentifier: "diceroll-core3d-c4",
          contentApi: 4,
        },
      })),
    );
  });

  it("maps on-demand delivery and a chosen level; refuses ba-package off macOS", async () => {
    const w = await published({
      extraPacks: `    diceroll.extra:\n      kind: pack\n      type: files.tree\n      delivery: on-demand\n`,
    });
    const { c } = common(w, { report: false });
    await expect(
      baPackage({ ...c, from: "cache", platform: "linux" }),
    ).rejects.toThrow(/xcrun ba-package runs on macOS/);
    const r = await baPackage({
      ...c,
      from: "cache",
      archive: false,
      contentApi: "7",
      platforms: ["iOS", "macOS"],
    });
    expect(r.assetPackId).toBe("diceroll-core3d-c7");
    expect(r.manifest).toEqual({
      assetPackID: "diceroll-core3d-c7",
      downloadPolicy: {
        essential: {
          installationEventTypes: ["firstInstallation", "subsequentUpdate"],
        },
      },
      fileSelectors: [{ directory: "pkey/diceroll-core3d-c7" }],
      platforms: ["iOS", "macOS"],
    });
    expect(r.aar).toBeNull();
  });

  it("packages a texture variant chosen with --variant, and refuses an ambiguous pack", async () => {
    const w = await published({ variants: true });
    const { c } = common(w, { report: false });
    await expect(
      baPackage({ ...c, from: "cache", archive: false }),
    ).rejects.toThrow(/varies by texture.*--variant/);
    const r = await baPackage({
      ...c,
      from: "cache",
      archive: false,
      variant: "texture=astc",
    });
    expect(r.inputs.variant).toBe("texture=astc");
  });

  it("refuses a payload that is not the one the record pins, and a pack with scripts", async () => {
    const w = await published();
    const { c } = common(w, { report: false });
    const file = path.join(
      w.cwd,
      "cache/diceroll.core3d/1.0.0/default/diceroll.core3d.pck",
    );
    // A clean pack, but not the bytes the record pins.
    await writeFile(file, writeTestPck(kaykitV2()));
    await expect(
      baPackage({ ...c, from: "cache", archive: false }),
    ).rejects.toThrow(
      /is not the payload diceroll\.core3d@1\.0\.0's record pins/,
    );

    // A script smuggled into the cached payload: the lint runs again before any transport.
    await writeFile(file, writeTestPck(kaykitForbidden()));
    await expect(
      baPackage({ ...c, from: "cache", archive: false }),
    ).rejects.toThrow(
      /fails the data-only lint, so it never reaches a store transport/,
    );
  });

  it("refuses a pack the distribution does not route through apple-ba", async () => {
    const w = await published({
      distribution: "outlets:\n  web: {}\n",
    });
    const { c } = common(w, { report: false });
    await expect(
      baPackage({ ...c, from: "cache", archive: false }),
    ).rejects.toThrow(/not bound to apple-ba on any outlet/);
  });
});

// The real tool, where CI has it: the apple job (macos-26, Xcode 26.6) sets PKEY_REAL_BA_PACKAGE=1.
describe.runIf(process.env.PKEY_REAL_BA_PACKAGE === "1")(
  "xcrun ba-package (real)",
  () => {
    it("archives the generated manifest and files", async () => {
      const w = await published();
      const { c } = common(w, { report: false });
      const r = await baPackage({ ...c, from: "cache" });
      const st = await readFile(r.aar!);
      expect(st.byteLength).toBeGreaterThan(0);
    });
  },
);

// ── apple-ba upload: a fake App Store Connect ────────────────────────────────────────────────

interface AscCall {
  method: string;
  path: string;
  auth: string | null;
  body?: unknown;
  bytes?: number;
}

function fakeAsc(
  opts: { existing?: { id: string; identifier: string }[] } = {},
) {
  const calls: AscCall[] = [];
  const assets = [...(opts.existing ?? [])];
  const uploads = new Map<string, number>();
  let n = 0;
  const handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? null;
    if (u.hostname === "upload.asc.example") {
      const body = init?.body as Uint8Array;
      calls.push({ method, path: u.pathname, auth, bytes: body.byteLength });
      return new Response(null, { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      path: `${u.pathname}${u.search}`,
      auth,
      ...(body ? { body } : {}),
    });
    if (
      method === "GET" &&
      /\/v1\/apps\/[^/]+\/backgroundAssets$/.test(u.pathname)
    ) {
      const want = u.searchParams.get("filter[assetPackIdentifier]");
      return json({
        data: assets
          .filter((a) => a.identifier === want)
          .map((a) => ({
            type: "backgroundAssets",
            id: a.id,
            attributes: { assetPackIdentifier: a.identifier },
          })),
      });
    }
    if (method === "POST" && u.pathname === "/v1/backgroundAssets") {
      const id = `ba-${++n}`;
      assets.push({ id, identifier: body.data.attributes.assetPackIdentifier });
      return json({ data: { type: "backgroundAssets", id } }, 201);
    }
    if (method === "POST" && u.pathname === "/v1/backgroundAssetVersions")
      return json(
        {
          data: {
            type: "backgroundAssetVersions",
            id: `bav-${++n}`,
            attributes: { version: 3, state: "AWAITING_UPLOAD" },
          },
        },
        201,
      );
    if (method === "POST" && u.pathname === "/v1/backgroundAssetUploadFiles") {
      const id = `bauf-${++n}`;
      const size = body.data.attributes.fileSize as number;
      uploads.set(id, size);
      const half = Math.ceil(size / 2);
      const ops = [
        {
          method: "PUT",
          url: `https://upload.asc.example/${id}/1`,
          offset: 0,
          length: half,
          requestHeaders: [
            { name: "Content-Type", value: "application/octet-stream" },
          ],
        },
        ...(size > half
          ? [
              {
                method: "PUT",
                url: `https://upload.asc.example/${id}/2`,
                offset: half,
                length: size - half,
                requestHeaders: [],
              },
            ]
          : []),
      ];
      return json(
        {
          data: {
            type: "backgroundAssetUploadFiles",
            id,
            attributes: { uploadOperations: ops },
          },
        },
        201,
      );
    }
    if (
      method === "PATCH" &&
      u.pathname.startsWith("/v1/backgroundAssetUploadFiles/")
    )
      return json({
        data: {
          type: "backgroundAssetUploadFiles",
          id: u.pathname.split("/").pop(),
        },
      });
    if (
      method === "GET" &&
      u.pathname.startsWith("/v1/backgroundAssetVersions/")
    )
      return json({
        data: {
          type: "backgroundAssetVersions",
          id: u.pathname.split("/").pop(),
          attributes: { state: "COMPLETE" },
        },
      });
    return json({ errors: [{ status: "404" }] }, 404);
  };
  return { calls, assets, handle };
}

function ascEnv(): Record<string, string | undefined> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    PKEY_CI_TOKEN: CI_TOKEN,
    ASC_KEY_ID: "ABC123DEFG",
    ASC_ISSUER_ID: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
    ASC_PRIVATE_KEY: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  };
}

async function packaged(o: Parameters<typeof published>[0] = {}) {
  const w = await published(o);
  const { c } = common(w, { report: false });
  await baPackage({
    ...c,
    from: "cache",
    platform: "darwin",
    exec: (_cmd, args) => writeFileSync(args[4]!, new Uint8Array(3000).fill(7)),
  });
  return w;
}

function uploadWith(
  w: Awaited<ReturnType<typeof published>>,
  asc: ReturnType<typeof fakeAsc>,
  over: Partial<Parameters<typeof baUpload>[0]> = {},
) {
  const env = ascEnv();
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const host = new URL(url).hostname;
    if (
      host === "api.appstoreconnect.apple.com" ||
      host === "upload.asc.example"
    )
      return asc.handle(url, init);
    return w.pk(input, init);
  }) as typeof fetch;
  const { c, io } = common(w, { env, fetchImpl });
  return {
    io,
    env,
    run: () => baUpload({ ...c, now: () => 1_759_300_000_000, ...over }),
  };
}

describe("pkey transport apple-ba upload", () => {
  it("creates the asset pack on the first upload, uploads manifest and archive in parts, records the lock and reports", async () => {
    const w = await packaged();
    const asc = fakeAsc();
    const { run, env } = uploadWith(w, asc);
    const r = await run();
    expect(r).toMatchObject({
      assetPackId: "diceroll-core3d-c4",
      resource: "ba-1",
      created: true,
      ascVersion: 3,
    });
    const seq = asc.calls.map((x) => `${x.method} ${x.path}`);
    expect(seq).toEqual([
      "GET /v1/apps/1234567890/backgroundAssets?filter[assetPackIdentifier]=diceroll-core3d-c4",
      "POST /v1/backgroundAssets",
      "POST /v1/backgroundAssetVersions",
      "POST /v1/backgroundAssetUploadFiles",
      expect.stringMatching(/^PUT \/bauf-\d+\/1$/),
      expect.stringMatching(/^PUT \/bauf-\d+\/2$/),
      expect.stringMatching(
        /^PATCH \/v1\/backgroundAssetUploadFiles\/bauf-\d+$/,
      ),
      "POST /v1/backgroundAssetUploadFiles",
      expect.stringMatching(/^PUT \/bauf-\d+\/1$/),
      expect.stringMatching(/^PUT \/bauf-\d+\/2$/),
      expect.stringMatching(
        /^PATCH \/v1\/backgroundAssetUploadFiles\/bauf-\d+$/,
      ),
    ]);
    // Request bodies (ASC OpenAPI 4.5 shapes).
    expect(asc.calls[1]!.body).toEqual({
      data: {
        type: "backgroundAssets",
        attributes: { assetPackIdentifier: "diceroll-core3d-c4" },
        relationships: { app: { data: { type: "apps", id: "1234567890" } } },
      },
    });
    expect(asc.calls[3]!.body).toMatchObject({
      data: {
        attributes: { assetType: "MANIFEST", fileName: "Manifest.json" },
      },
    });
    expect(asc.calls[7]!.body).toMatchObject({
      data: {
        attributes: {
          assetType: "ASSET",
          fileName: "diceroll-core3d-c4.aar",
          fileSize: 3000,
        },
      },
    });
    expect(asc.calls[6]!.body).toMatchObject({
      data: { attributes: { uploaded: true } },
    });
    // The ES256 token goes to App Store Connect, never to the pre-signed part URLs.
    const token = asc.calls[0]!.auth!.replace(/^Bearer /, "");
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({
      iss: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
      aud: "appstoreconnect-v1",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        {
          key: createPublicKey(env.ASC_PRIVATE_KEY!),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(s!, "base64url"),
      ),
    ).toBe(true);
    expect(
      asc.calls
        .filter((x) => x.path.startsWith("/bauf"))
        .every((x) => x.auth === null),
    ).toBe(true);
    // The lock, then the reports: processing on TestFlight, pending on the App Store.
    expect(
      JSON.parse(
        await readFile(path.join(w.cwd, ".pkey/asset-packs.json"), "utf8"),
      ),
    ).toEqual({
      format: "pkey-asset-packs/1",
      assetPacks: {
        "diceroll-core3d-c4": {
          packId: "diceroll.core3d",
          resource: "ba-1",
          app: "1234567890",
          recordedAt: "2025-10-01T06:26:40.000Z",
        },
      },
    });
    const ref = {
      assetPackIdentifier: "diceroll-core3d-c4",
      ascBackgroundAssetId: "ba-1",
      ascBackgroundAssetVersionId: r.versionId,
      ascVersion: 3,
      contentApi: 4,
    };
    expect(w.reports).toEqual([
      {
        outlet: "testflight",
        state: "processing",
        deliverable: "diceroll.core3d",
        version: "1.0.0",
        platformRef: ref,
      },
      {
        outlet: "app-store",
        state: "pending",
        deliverable: "diceroll.core3d",
        version: "1.0.0",
        platformRef: ref,
      },
    ]);

    // A second upload finds the recorded asset pack and creates none.
    const again = await uploadWith(w, asc).run();
    expect(again).toMatchObject({ resource: "ba-1", created: false });
    expect(
      asc.calls.filter(
        (x) => x.method === "POST" && x.path === "/v1/backgroundAssets",
      ),
    ).toHaveLength(1);
  });

  it("refuses an asset pack whose resource is not the recorded one, an unrecorded one, and a vanished one", async () => {
    const w = await packaged();
    await writeFile(
      path.join(w.cwd, ".pkey/asset-packs.json"),
      JSON.stringify({
        format: "pkey-asset-packs/1",
        assetPacks: {
          "diceroll-core3d-c4": {
            packId: "diceroll.core3d",
            resource: "ba-mine",
            app: "1234567890",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const other = fakeAsc({
      existing: [{ id: "ba-other", identifier: "diceroll-core3d-c4" }],
    });
    const e1 = await uploadWith(w, other)
      .run()
      .catch((e) => e);
    expect(e1).toBeInstanceOf(AscUploadError);
    expect(e1.code).toBe("asset-pack-resource-mismatch");
    expect(other.calls.map((x) => x.method)).toEqual(["GET"]);

    const gone = fakeAsc();
    const e2 = await uploadWith(w, gone)
      .run()
      .catch((e) => e);
    expect(e2.code).toBe("asset-pack-missing");
    expect(gone.calls.map((x) => x.method)).toEqual(["GET"]);

    // Nothing recorded, but one exists already: only an explicit --expect-resource adopts it.
    const fresh = await packaged();
    const existing = fakeAsc({
      existing: [{ id: "ba-7", identifier: "diceroll-core3d-c4" }],
    });
    const e3 = await uploadWith(fresh, existing)
      .run()
      .catch((e) => e);
    expect(e3.code).toBe("asset-pack-unrecorded");
    expect(e3.message).toMatch(/--expect-resource ba-7/);
    const ok = await uploadWith(fresh, existing, {
      expectResource: "ba-7",
    }).run();
    expect(ok).toMatchObject({ resource: "ba-7", created: false });
  });

  it("fails colliding, double-hyphen and overlong pack ids with a typed error before any request", async () => {
    const extra = (ids: string[]) =>
      ids
        .map((id) => `    ${id}:\n      kind: pack\n      type: files.tree\n`)
        .join("");
    const long = `x${"y".repeat(61)}`;
    expect(long).toHaveLength(62);
    for (const [ids, code] of [
      [["x.foes", "x-foes"], "asset-pack-id-collision"],
      [["x-.foes"], "asset-pack-id-invalid"],
      [[long], "asset-pack-id-too-long"],
    ] as const) {
      const w = await published({ extraPacks: extra([...ids]) });
      const asc = fakeAsc();
      const { run } = uploadWith(w, asc);
      const e = await run().catch((x) => x);
      expect(e).toBeInstanceOf(TransportIdError);
      expect((e as TransportIdError).code).toBe(code);
      expect(asc.calls).toEqual([]);
      expect(w.reports).toEqual([]);
      // The package step refuses them the same way, before writing anything.
      const { c } = common(w, { report: false });
      await expect(
        baPackage({ ...c, from: "cache", archive: false }),
      ).rejects.toBeInstanceOf(TransportIdError);
    }
  });

  it("re-hashes the packaged content against the package step and, with --from, the signed record", async () => {
    const w = await packaged();
    const content = path.join(
      w.cwd,
      "build/pkey-transport/apple-ba/diceroll-core3d-c4/pkey/diceroll-core3d-c4",
    );
    // With --from and untouched files, the upload goes ahead.
    const ok = fakeAsc();
    expect(await uploadWith(w, ok, { from: "cache" }).run()).toMatchObject({
      created: true,
    });

    // A marker edited after packaging: the payload still matches the inputs, the record does not.
    const markerFile = path.join(content, "diceroll-core3d-c4.pck.pkey.json");
    const marker = await readFile(markerFile, "utf8");
    await writeFile(
      markerFile,
      marker.replace('"version": "1.0.0"', '"version": "9.9.9"'),
    );
    const m = fakeAsc();
    const e1 = await uploadWith(w, m, { from: "cache" })
      .run()
      .catch((x) => x);
    expect(e1).toBeInstanceOf(AscUploadError);
    expect(e1.code).toBe("asset-pack-inputs-mismatch");
    expect(m.calls).toEqual([]);
    await writeFile(markerFile, marker);

    // A payload edited after packaging is refused with or without --from, before any request.
    const pck = path.join(content, "diceroll-core3d-c4.pck");
    const bytes = new Uint8Array(await readFile(pck));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(pck, bytes);
    for (const over of [{}, { from: "cache" }]) {
      const asc = fakeAsc();
      const e = await uploadWith(w, asc, over)
        .run()
        .catch((x) => x);
      expect(e.code).toBe("asset-pack-inputs-mismatch");
      expect(e.message).toMatch(/the packaged content/);
      expect(asc.calls).toEqual([]);
    }
  });

  it("refuses without credentials, and when the package step's inputs do not match", async () => {
    const w = await packaged();
    const asc = fakeAsc();
    const { c } = common(w, {
      fetchImpl: ((u: string, i?: RequestInit) =>
        asc.handle(String(u), i)) as typeof fetch,
    });
    const e1 = await baUpload({ ...c }).catch((x) => x);
    expect(e1.code).toBe("asc-credentials-missing");
    const e2 = await baUpload({ ...c, version: "1.0.1" }).catch((x) => x);
    expect(e2.code).toBe("asset-pack-inputs-mismatch");
    expect(asc.calls).toEqual([]);
  });
});

// ── play-pad modules ─────────────────────────────────────────────────────────────────────────

async function godotProject(cwd: string): Promise<string> {
  const dir = path.join(cwd, "android/build");
  await mkdir(dir, { recursive: true });
  for (const f of ["settings.gradle", "build.gradle"])
    await writeFile(
      path.join(dir, f),
      await readFile(path.join(GODOT_ANDROID, f)),
    );
  return dir;
}

describe("pkey transport play-pad modules", () => {
  it("writes a fast-follow module with a #tcf directory per texture variant and patches Godot's Gradle build", async () => {
    const w = await published({ variants: true });
    const project = await godotProject(w.cwd);
    const { c, io } = common(w);
    const r = await padModules({
      ...c,
      from: "cache",
      project: "android/build",
    });
    expect(io.err()).toBe("");
    expect(r).toEqual({
      name: "diceroll_core3d",
      delivery: "fast-follow",
      directories: ["pkey", "pkey#tcf_astc"],
      patched: ["settings.gradle", "build.gradle"],
    });
    const mod = path.join(project, "diceroll_core3d");
    await golden(
      "play-pad/module.build.gradle",
      await readFile(path.join(mod, "build.gradle"), "utf8"),
    );
    await golden(
      "play-pad/settings.gradle",
      await readFile(path.join(project, "settings.gradle"), "utf8"),
    );
    await golden(
      "play-pad/build.gradle",
      await readFile(path.join(project, "build.gradle"), "utf8"),
    );
    const assets = path.join(mod, "src/main/assets");
    for (const d of ["pkey", "pkey#tcf_astc"]) {
      expect((await readdir(path.join(assets, d))).sort()).toEqual([
        "diceroll_core3d.pck",
        "diceroll_core3d.pck.pkey.json",
      ]);
      expect(
        await readFile(
          path.join(assets, d, "diceroll_core3d.pck.pkey.json"),
          "utf8",
        ),
      ).toBe(markerOf(w.jws));
    }
    // etc2 is the default (unsuffixed) directory; astc is targeted.
    const record = JSON.parse(
      Buffer.from(w.jws.split(".")[1]!, "base64url").toString(),
    );
    const shaOf = async (d: string) =>
      sha(await readFile(path.join(assets, d, "diceroll_core3d.pck")));
    const byTexture = Object.fromEntries(
      record.variants.map(
        (v: { variant: { texture: string }; payload: { sha256: string } }) => [
          v.variant.texture,
          v.payload.sha256,
        ],
      ),
    );
    expect(await shaOf("pkey")).toBe(byTexture.etc2);
    expect(await shaOf("pkey#tcf_astc")).toBe(byTexture.astc);
    expect(w.reports).toEqual([
      {
        outlet: "play",
        state: "pending",
        deliverable: "diceroll.core3d",
        version: "1.0.0",
        platformRef: {
          padPack: "diceroll_core3d",
          deliveryType: "fast-follow",
        },
      },
    ]);

    // Idempotent: a second run patches nothing more.
    const again = await padModules({
      ...c,
      from: "cache",
      project: "android/build",
      report: false,
    });
    expect(again.patched).toEqual([]);
    await golden(
      "play-pad/build.gradle",
      await readFile(path.join(project, "build.gradle"), "utf8"),
    );
  });

  it("patches settings and app builds idempotently, and refuses a build without assetPacks", () => {
    const s = "include ':app'\n";
    expect(patchSettingsGradle(s, "foes")).toBe(
      "include ':app'\ninclude ':foes'\n",
    );
    expect(patchSettingsGradle(patchSettingsGradle(s, "foes"), "foes")).toBe(
      "include ':app'\ninclude ':foes'\n",
    );
    const b = 'android {\n    assetPacks = [":assetPackInstallTime"]\n}\n';
    const once = patchAppGradle(b, "foes", false);
    expect(once).toBe(
      'android {\n    assetPacks = [":assetPackInstallTime", ":foes"]\n}\n',
    );
    expect(patchAppGradle(once, "foes", false)).toBe(once);
    expect(() => patchAppGradle("android {}\n", "foes", false)).toThrow(
      /assetPacks/,
    );
  });

  it("maps on-demand delivery, an explicit default texture, and refuses an unknown format", async () => {
    const w = await published({ variants: true });
    await godotProject(w.cwd);
    const { c } = common(w, { report: false });
    const r = await padModules({
      ...c,
      from: "cache",
      project: "android/build",
      delivery: "on-demand",
      defaultTexture: "astc",
    });
    expect(r.directories).toEqual(["pkey", "pkey#tcf_etc2"]);
    await expect(
      padModules({
        ...c,
        from: "cache",
        project: "android/build",
        defaultTexture: "bptc",
      }),
    ).rejects.toThrow(/not a published texture variant/);
  });

  it("fails colliding Play asset-pack names before writing a module", async () => {
    const w = await published({
      extraPacks:
        "    x.foes:\n      kind: pack\n      type: files.tree\n    x-foes:\n      kind: pack\n      type: files.tree\n",
    });
    const project = await godotProject(w.cwd);
    const { c } = common(w, { report: false });
    const e = await padModules({
      ...c,
      from: "cache",
      project: "android/build",
    }).catch((x) => x);
    expect(e).toBeInstanceOf(TransportIdError);
    expect(e.code).toBe("pad-pack-name-collision");
    expect(await readFile(path.join(project, "settings.gradle"), "utf8")).toBe(
      await readFile(path.join(GODOT_ANDROID, "settings.gradle"), "utf8"),
    );
  });
});

// ── steam-depot vdf ──────────────────────────────────────────────────────────────────────────

describe("pkey transport steam-depot vdf", () => {
  it("writes a content-only build with SetLive on a named branch and the depot's content root", async () => {
    const w = await published();
    const { c } = common(w);
    const r = await steamVdf({
      ...c,
      from: "cache",
      depot: "481",
      channel: "beta",
      setlive: true,
    });
    expect(r).toMatchObject({
      app: "480",
      depot: "481",
      branch: "beta",
      setlive: true,
    });
    const out = path.join(w.cwd, "build/pkey-transport/steam");
    await golden(
      "steam/app_build_480.vdf",
      (await readFile(path.join(out, "app_build_480.vdf"), "utf8")).replace(
        /\([0-9a-f]{12}\)/,
        "(<record>)",
      ),
    );
    await golden(
      "steam/depot_build_481.vdf",
      await readFile(path.join(out, "depot_build_481.vdf"), "utf8"),
    );
    const root = path.join(out, "content/481/pkey_packs/diceroll.core3d");
    expect((await readdir(root)).sort()).toEqual([
      "diceroll.core3d.pck",
      "diceroll.core3d.pck.pkey.json",
    ]);
    expect(w.reports).toEqual([
      {
        outlet: "steam",
        state: "pending",
        deliverable: "diceroll.core3d",
        version: "1.0.0",
        platformRef: {
          steamAppId: "480",
          steamDepotId: "481",
          steamBranch: "beta",
        },
      },
    ]);
  });

  it("never sets the default branch live, and needs a branch", async () => {
    const w = await published();
    const { c } = common(w, { report: false });
    await expect(
      steamVdf({
        ...c,
        from: "cache",
        depot: "481",
        branch: "default",
        setlive: true,
      }),
    ).rejects.toThrow(/default branch is set live in Steamworks by a person/);
    await expect(
      steamVdf({ ...c, from: "cache", depot: "481" }),
    ).rejects.toThrow(/--branch is required/);
    const r = await steamVdf({
      ...c,
      from: "cache",
      depot: "481",
      branch: "default",
    });
    expect(r.setlive).toBe(false);
    expect(await readFile(r.appBuild, "utf8")).not.toMatch(/SetLive/);
  });
});

// ── The command line ─────────────────────────────────────────────────────────────────────────

describe("pkey transport (command line)", () => {
  it("runs a step from argv and prints usage for an unknown one", async () => {
    const w = await published();
    const io = capture();
    const code = await runPkey(
      [
        "transport",
        "steam-depot",
        "vdf",
        "--deliverable",
        "diceroll.core3d",
        "--release",
        "1.0.0",
        "--from",
        "cache",
        "--depot",
        "481",
        "--branch",
        "beta",
        "--no-report",
      ],
      { cwd: w.cwd, stdout: io.stdout, stderr: io.stderr, env: {} },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(io.out()).toMatch(/content-only SteamPipe build of depot 481/);
    const bad = capture();
    expect(
      await runPkey(
        [
          "transport",
          "apple-ba",
          "nope",
          "--deliverable",
          "x",
          "--release",
          "1",
        ],
        {
          cwd: w.cwd,
          stdout: bad.stdout,
          stderr: bad.stderr,
          env: {},
        },
      ),
    ).toBe(2);
    expect(bad.err()).toMatch(/pkey transport apple-ba package/);
  });
});

// ── The Action ───────────────────────────────────────────────────────────────────────────────

describe("the Action's transport input (P5-08)", () => {
  const input = (o: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
    );

  it("runs a transport step for a published pack and refuses publish-only inputs", async () => {
    const w = await published();
    const base = {
      product: SLUG,
      deliverable: "diceroll.core3d",
      version: "1.0.0",
      dir: "cache",
      "dry-run": "false",
      "transport-report": "true",
      "base-url": BASE,
    };
    const io = capture();
    const code = await runAction({
      cwd: w.cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      env: {
        ...actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }),
        ...input({
          ...base,
          transport: "steam-depot-vdf",
          "steam-depot": "481",
          channel: "beta",
          "steam-setlive": "true",
        }),
      },
      fetchImpl: w.pk,
      sleep: instant,
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(w.reports.map((r) => [r.outlet, r.state])).toEqual([
      ["steam", "pending"],
    ]);
    expect(
      await readFile(
        path.join(w.cwd, "build/pkey-transport/steam/app_build_480.vdf"),
        "utf8",
      ),
    ).toMatch(/"SetLive" "beta"/);

    for (const [over, msg] of [
      [
        { transport: "steam-depot-vdf", "steam-depot": "481", out: "cache" },
        "out does not apply to a transport step",
      ],
      [{ transport: "nope" }, "transport must be one of apple-ba-package"],
      [
        { "steam-depot": "481" },
        "steam-depot applies only with the transport input",
      ],
      [
        { transport: "play-pad-modules" },
        "play-pad-modules needs gradle-project",
      ],
    ] as const) {
      const e = capture();
      const c = await runAction({
        cwd: w.cwd,
        stdout: e.stdout,
        stderr: e.stderr,
        env: { ...actionsEnv(), ...input({ ...base, ...over }) },
        fetchImpl: w.pk,
        sleep: instant,
      });
      expect(c).toBe(1);
      expect(e.err()).toContain(msg);
    }
  });
});
