/**
 * A-16 — the platform's team-level Google Play connection: the developer account's service
 * account (`google-play.service-account`, Worker secret `PLATFORM_GOOGLE_SERVICE_ACCOUNT`), the
 * RTDN push identity and the Play Integrity cloud project number.
 *
 * The same matrix as the App Store: platform admins only, metadata only (never the RSA key),
 * console over secret, the listing (Reporting `apps:search` plus each app's tracks through a
 * short, deleted edit) against the fake Google, assignment conflicts, the connector fallback with
 * the pin as the boundary at setup, token and open, own credentials first — and the commerce
 * bridge's Play side, including P6-01's RTDN settings falling back to the platform's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  platformPin,
  setPlatformPin,
} from "../src/core/platformCredentials.js";
import { platformGoogleAccessToken } from "../src/core/outletTokens.js";
import { platformPlayIntegrityProjectNumber } from "../src/core/platformStoreSettings.js";
import { resolvePlaySetup } from "../src/services/distribution/connectors/play/setup.js";
import {
  effectivePlaySettings,
  playCredential,
} from "../src/services/distribution/commerce/play.js";
import { validateCommerceSettings } from "../src/services/distribution/commerce/settings.js";
import { seedProduct } from "./seed.js";
import {
  CLIENT_EMAIL,
  playWorld,
  poll,
  NOW,
  SLUG,
  PLAY_PACKAGE,
  type PlayWorld,
} from "./playWorld.js";
import { bodyOf, platformApi, productAudits } from "./platformApi.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER = "other";
const OTHER_PACKAGE = "gg.acme.other";

function keyFile(w: PlayWorld) {
  return {
    type: "service_account",
    project_id: "acme-platform",
    private_key_id: "fedcba9876543210",
    client_email: CLIENT_EMAIL,
    private_key: w.keys.privatePem,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

/** djdl has NO credential of its own; the platform service account is the Worker secret. */
async function teamWorld(
  opts: { secret?: boolean; credential?: boolean } = {},
): Promise<PlayWorld> {
  const w = await playWorld({ credential: opts.credential ?? false });
  if (opts.secret !== false)
    (w.env as Record<string, unknown>).PLATFORM_GOOGLE_SERVICE_ACCOUNT =
      JSON.stringify(keyFile(w));
  w.fake.searchApps.push({
    name: `apps/${OTHER_PACKAGE}`,
    packageName: OTHER_PACKAGE,
    displayName: "Other",
  });
  await seedProduct(w.db, OTHER);
  return w;
}

const api = (w: PlayWorld, method: string, path: string, body?: unknown) =>
  platformApi(w, method, path, body);

describe("platform Google Play: auth, sources, secrets", () => {
  it("is platform-admin only", async () => {
    const w = await teamWorld();
    for (const [m, p] of [
      ["GET", "/google-play/apps"],
      ["PUT", "/google-play"],
      ["PUT", `/google-play/apps/${PLAY_PACKAGE}/product`],
      ["PUT", "/google-play/settings/pushAudience"],
    ] as const)
      expect(
        (
          await platformApi(
            w,
            m,
            p,
            m === "GET" ? undefined : { value: "x", product: SLUG },
            ["nope"],
          )
        ).status,
        `${m} ${p}`,
      ).toBe(403);
    expect(w.fake.requests).toEqual([]);
  });

  it("the secret configures it, the console key (pasted as the JSON file) wins, never a key out", async () => {
    const w = await teamWorld();
    let store = (
      (await bodyOf(await api(w, "GET", ""))).stores as Array<{
        store: string;
        credentials: Array<{ source: string; meta: Record<string, string> }>;
      }>
    ).find((s) => s.store === "google-play")!;
    expect(store.credentials[0]).toMatchObject({
      source: "secret",
      meta: { clientEmail: CLIENT_EMAIL },
    });
    const put = await api(w, "PUT", "/google-play", {
      value: JSON.stringify(keyFile(w)),
    });
    expect(put.status).toBe(200);
    const text = JSON.stringify(await bodyOf(put));
    expect(text).not.toContain("PRIVATE KEY");
    store = (
      (await bodyOf(await api(w, "GET", ""))).stores as (typeof store)[]
    ).find((s) => s.store === "google-play")!;
    expect(store.credentials[0]!.source).toBe("console");
    expect(JSON.stringify(store)).not.toContain("PRIVATE KEY");
    const bad = await api(w, "PUT", "/google-play", {
      value: { ...keyFile(w), token_uri: "https://evil.example/token" },
    });
    expect(bad.status).toBe(422);
  });
});

describe("platform Google Play: the apps listing", () => {
  it("searches the account's apps and reads each one's tracks through a deleted edit", async () => {
    const w = await teamWorld();
    // Without the opt-in, no edit is opened at all.
    const plain = (await bodyOf(await api(w, "GET", "/google-play/apps"))) as {
      apps: Array<{ appId: string; status: { tracks: unknown } }>;
    };
    expect(plain.apps.map((a) => a.appId).sort()).toEqual(
      [OTHER_PACKAGE, PLAY_PACKAGE].sort(),
    );
    expect(plain.apps.every((a) => a.status.tracks === null)).toBe(true);
    expect(w.fake.calls().some((c) => c.startsWith("POST edits"))).toBe(false);

    const res = await api(w, "GET", "/google-play/apps?tracks=1");
    expect(res.status).toBe(200);
    const body = (await bodyOf(res)) as {
      apps: Array<{
        appId: string;
        name: string;
        assignedProduct: string | null;
        status: {
          tracks: Array<{ track: string; releases: unknown[] }> | null;
          tracksError: string | null;
        };
      }>;
    };
    const djdl = body.apps.find((a) => a.appId === PLAY_PACKAGE)!;
    expect(djdl.name).toBe("djdl");
    expect(djdl.status.tracks!.map((t) => t.track)).toContain("production");
    // The account cannot edit the other app: listed, with a status line instead of tracks.
    const other = body.apps.find((a) => a.appId === OTHER_PACKAGE)!;
    expect(other.status.tracks).toBeNull();
    expect(other.status.tracksError).toMatch(/HTTP 403/);
    // Nothing held open, nothing committed, only Google's hosts, tokens from the platform key.
    expect(w.fake.openEdits()).toEqual([]);
    expect(w.fake.calls().some((c) => c.includes(":commit"))).toBe(false);
    expect(w.fake.foreignHost).toEqual([]);
    expect(new Set(w.fake.tokenRequests.map((t) => t.iss))).toEqual(
      new Set([CLIENT_EMAIL]),
    );
  });

  it("refuses without a usable key (409)", async () => {
    const w = await teamWorld({ secret: false });
    expect((await api(w, "GET", "/google-play/apps")).status).toBe(409);
  });
});

describe("platform Google Play: assignment and the fallback", () => {
  it("assigns a package; the connector then polls on the team key, audited in the product's trail", async () => {
    const w = await teamWorld();
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_missing",
      credentialSource: "platform",
    });
    await poll(w);
    expect(w.fake.requests).toEqual([]);

    const res = await api(
      w,
      "PUT",
      `/google-play/apps/${PLAY_PACKAGE}/product`,
      {
        product: SLUG,
      },
    );
    expect(res.status).toBe(200);
    // The assignment needed app ids only: no edit was opened for it.
    expect(w.fake.calls().some((c) => c.startsWith("POST edits"))).toBe(false);
    expect(await platformPin(w.db, "google-play.service-account", SLUG)).toBe(
      PLAY_PACKAGE,
    );
    const { setup } = await resolvePlaySetup(w.env, w.db, SLUG);
    expect(setup?.credentialId).toBe("platform:google-play.service-account");
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.calls()[0]).toMatch(/^POST edits$/);
    expect(
      (await productAudits(w.db, SLUG)).some(
        (a) =>
          a.action === "outlet_credential.pin" &&
          a.target_id === "google-play.service-account",
      ),
    ).toBe(true);
  });

  it("never lets a product use the team key for another product's package", async () => {
    const w = await teamWorld();
    await api(w, "PUT", `/google-play/apps/${PLAY_PACKAGE}/product`, {
      product: OTHER,
    });
    const taken = await api(
      w,
      "PUT",
      `/google-play/apps/${PLAY_PACKAGE}/product`,
      {
        product: SLUG,
      },
    );
    expect(taken.status).toBe(409);
    expect(await bodyOf(taken)).toMatchObject({ product: OTHER });
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).inert?.reason).toBe(
      "pin_missing",
    );
    expect(
      await platformGoogleAccessToken(
        w.env,
        w.db,
        { product: SLUG, pin: PLAY_PACKAGE },
        ["https://www.googleapis.com/auth/androidpublisher"],
        "play:poll",
        NOW,
        w.fake.fetchImpl,
      ),
    ).toBeNull();
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests).toEqual([]);
  });

  it("a manifest naming another package than the one assigned is inert (pin_mismatch)", async () => {
    const w = await teamWorld();
    await setPlatformPin(w.db, {
      id: "google-play.service-account",
      product: SLUG,
      pin: OTHER_PACKAGE,
      actor: "x",
      now: NOW,
    });
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_mismatch",
      pinnedPackageName: OTHER_PACKAGE,
    });
  });

  it("a product's own credential wins over the team key", async () => {
    const w = await teamWorld({ credential: true });
    await setPlatformPin(w.db, {
      id: "google-play.service-account",
      product: SLUG,
      pin: PLAY_PACKAGE,
      actor: "x",
      now: NOW,
    });
    expect(
      (await resolvePlaySetup(w.env, w.db, SLUG)).setup?.credentialId,
    ).toBe("play");
  });
});

describe("platform Google Play: commerce and the shared settings", () => {
  it("the commerce Play side falls back to the team key only for the pinned package", async () => {
    const w = await teamWorld();
    expect(await playCredential(w.env, w.db, SLUG, PLAY_PACKAGE)).toBeNull();
    await setPlatformPin(w.db, {
      id: "google-play.service-account",
      product: SLUG,
      pin: PLAY_PACKAGE,
      actor: "x",
      now: NOW,
    });
    expect(await playCredential(w.env, w.db, SLUG, PLAY_PACKAGE)).toBe(
      "platform:google-play.service-account",
    );
    expect(await playCredential(w.env, w.db, SLUG, OTHER_PACKAGE)).toBeNull();
  });

  it("RTDN's push identity and Play Integrity's project number come from the platform where a product leaves them unset", async () => {
    const w = await teamWorld();
    // P6-01's settings now accept a Play block without the push fields…
    const v = validateCommerceSettings({ play: { packageName: PLAY_PACKAGE } });
    expect(v).toMatchObject({
      ok: true,
      value: { play: { pushAudience: null, pushServiceAccount: null } },
    });
    const play = (
      v as { value: { play: Parameters<typeof effectivePlaySettings>[2] } }
    ).value.play;
    // …which stay off (fail closed) until the platform sets them…
    expect(await effectivePlaySettings(w.env, w.db, play)).toMatchObject({
      pushAudience: null,
      pushServiceAccount: null,
    });
    expect(
      (
        await api(w, "PUT", "/google-play/settings/pushAudience", {
          value: "https://key.plrs.im/rtdn",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(w, "PUT", "/google-play/settings/pushServiceAccount", {
          value: "rtdn@acme.iam.gserviceaccount.com",
        })
      ).status,
    ).toBe(200);
    expect(await effectivePlaySettings(w.env, w.db, play)).toMatchObject({
      pushAudience: "https://key.plrs.im/rtdn",
      pushServiceAccount: "rtdn@acme.iam.gserviceaccount.com",
    });
    // …and a product's own value wins.
    expect(
      await effectivePlaySettings(w.env, w.db, {
        ...play,
        pushAudience: "own-audience",
      }),
    ).toMatchObject({ pushAudience: "own-audience" });

    expect(await platformPlayIntegrityProjectNumber(w.env, w.db)).toBeNull();
    expect(
      (
        await api(w, "PUT", "/google-play/settings/cloudProjectNumber", {
          value: "not digits",
        })
      ).status,
    ).toBe(422);
    await api(w, "PUT", "/google-play/settings/cloudProjectNumber", {
      value: "123456789012",
    });
    expect(await platformPlayIntegrityProjectNumber(w.env, w.db)).toBe(
      "123456789012",
    );
  });
});
