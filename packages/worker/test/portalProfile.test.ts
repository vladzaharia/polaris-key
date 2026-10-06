import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  PNG,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { fakeImages, fakeRendition } from "./imagesFake.js";
import {
  beginProviderSignIn,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import {
  AVATAR_GC_GRACE_SECONDS,
  AVATAR_PENDING_UPLOADS,
  renditionKey,
  sweepAvatars,
} from "../src/services/identity/card/avatars.js";
import type { ProfileView } from "../src/services/identity/card/profile.js";
import { AVATAR_UPLOADS_PER_HOUR } from "../src/services/identity/portal/profile.js";
import { insertLink } from "../src/services/identity/accounts/repo.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import { portalHooksFor } from "./portalHarness.js";

// PX-W16 (PORTAL.md §4.30, G32, G33): Account → Profile. `GET/PATCH /api/me/profile` and
// `POST /api/me/profile/picture`. Every choice made here is explicit and survives later sign-ins;
// imported values the person never chose follow their provider.

afterEach(() => {
  vi.unstubAllGlobals();
});

const GATE = "/api/signin/confirm-email";
const GOOGLE_PIC = "https://lh3.googleusercontent.com/a/ada";
const STEAM_PIC = "https://avatars.steamstatic.com/marafox_full.jpg";

type World = CardWorld & { images: ReturnType<typeof fakeImages> };

/** Provider pictures: a PNG whose trailing bytes name the URL, so each URL is its own picture. */
function stubPictures(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return new Response(
        new Uint8Array([...PNG, ...new TextEncoder().encode(url)]),
        { status: 200 },
      );
    }),
  );
  return { calls };
}

function google(name: string, pictureUrl: string | null): ProviderSignIn {
  return {
    identity: {
      issuerKey: "https://accounts.google.com",
      subject: "g-ada",
      kind: "google",
      email: "ada@gmail.com",
      emailVerified: true,
      displayName: name,
    },
    profile: { name, pictureUrl },
  };
}

function steam(name: string, pictureUrl: string | null): ProviderSignIn {
  return {
    identity: {
      issuerKey: "steam",
      subject: "76561190000000001",
      kind: "steam",
      email: null,
      emailVerified: false,
      displayName: name,
    },
    profile: { name, pictureUrl },
  };
}

let ip = 10;
/** A sign-in through a provider front door, in a fresh browser (a later sign-in). */
async function signInWith(w: World, input: ProviderSignIn): Promise<Device> {
  const d = new Device(w, `198.51.100.${ip++}`);
  d.absorb(
    await beginProviderSignIn(
      d.request("GET", "/login/x/callback"),
      w.env,
      w.db,
      input,
      NOW,
    ),
  );
  return d;
}

/**
 * Ada: a Google account (name and picture from Google), with Steam linked and signed in with once
 * (so Steam's persona and avatar are on file). Answers the signed-in browser and the link ids.
 */
async function ada(): Promise<{
  w: World;
  d: Device;
  accountId: string;
  googleLink: string;
  steamLink: string;
}> {
  const base = await seededWorld();
  const images = fakeImages();
  base.env.IMAGES = images.binding;
  const w: World = { ...base, images };
  stubPictures();
  const d = await signInWith(w, google("Ada Lovelace", GOOGLE_PIC));
  expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(200);
  await d.me();
  const accountId = (await w.db.first<{ id: string }>(
    "SELECT id FROM accounts",
  ))!.id;
  await insertLink(
    w.db,
    accountId,
    {
      issuerKey: "steam",
      tenantScope: "",
      subject: "76561190000000001",
      kind: "steam",
      email: null,
      emailVerified: false,
      displayName: "marafox",
      amr: ["steam"],
    },
    NOW,
  );
  await signInWith(w, steam("marafox", STEAM_PIC));
  const links = await w.db.all<{ id: string; kind: string }>(
    "SELECT id, kind FROM account_links WHERE account_id = ?",
    accountId,
  );
  return {
    w,
    d,
    accountId,
    googleLink: links.find((l) => l.kind === "google")!.id,
    steamLink: links.find((l) => l.kind === "steam")!.id,
  };
}

/** The source a method supplied (links made in the same second have no fixed order). */
function from(p: ProfileView, provider: string) {
  return p.sources.find((s) => s.provider === provider)!;
}

async function profile(d: Device): Promise<ProfileView> {
  const res = await d.send("GET", "/api/me/profile");
  expect(res.status).toBe(200);
  return ((await res.json()) as { profile: ProfileView }).profile;
}

async function patch(d: Device, body: unknown): Promise<Response> {
  return d.send("PATCH", "/api/me/profile", body);
}

async function upload(
  w: World,
  d: Device,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  const base = d.request("POST", "/api/me/profile/picture", undefined, {
    headers: { "content-type": "image/png", ...headers },
  });
  const req = new Request(base.url, {
    method: "POST",
    headers: base.headers,
    body: bytes,
  });
  return d.absorb(
    await handlePortal(req, w.env, w.db, "/api/me/profile/picture", {
      now: NOW,
      hooksFor: portalHooksFor(w.env, w.db),
    }),
  );
}

describe("GET /api/me/profile", () => {
  it("shows each value with its source and explicit flag, and what every method supplied", async () => {
    const { d, googleLink, steamLink } = await ada();
    const p = await profile(d);
    expect(p.displayName).toBe("Ada Lovelace");
    expect(p.displayNameSource).toEqual({
      kind: "provider",
      linkId: googleLink,
      provider: "google",
    });
    expect(p.explicitName).toBe(false);
    expect(p.pictureSource).toEqual({
      kind: "provider",
      linkId: googleLink,
      provider: "google",
    });
    expect(p.explicitPicture).toBe(false);
    expect(p.picture?.url).toBe(`/media/avatar/${p.picture!.asset}`);
    expect(p.picture?.url96).toBe(`/media/avatar/${p.picture!.asset}-96`);
    // The email method the gate added supplied nothing, so it is not a source.
    expect(p.sources.map((s) => [s.provider, s.name, s.label]).sort()).toEqual([
      ["google", "Ada Lovelace", "ada@gmail.com"],
      ["steam", "marafox", "marafox"],
    ]);
    const g = from(p, "google");
    const s = from(p, "steam");
    expect(g!.linkId).toBe(googleLink);
    expect(g!.picture?.asset).toBe(p.picture!.asset);
    expect(s!.linkId).toBe(steamLink);
    expect(s!.picture?.asset).toMatch(/^[0-9a-f]{64}$/);
    expect(s!.picture?.asset).not.toBe(p.picture!.asset);
  });

  it("needs a session", async () => {
    const w = await seededWorld();
    expect((await new Device(w).send("GET", "/api/me/profile")).status).toBe(
      401,
    );
  });
});

describe("explicit choices survive re-sign-in (PORTAL.md §4.30 rule 2)", () => {
  it("a typed name and a picked provider picture stick when both providers send new values", async () => {
    const { w, d, steamLink } = await ada();
    const before = await profile(d);
    const steamAsset = from(before, "steam").picture!.asset;
    const googleAsset = before.picture!.asset;
    const res = await patch(d, {
      name: "Countess Ada",
      picture: { from: steamLink },
    });
    expect(res.status).toBe(200);
    const chosen = ((await res.json()) as { profile: ProfileView }).profile;
    expect(chosen.displayName).toBe("Countess Ada");
    expect(chosen.displayNameSource).toEqual({ kind: "typed" });
    expect(chosen.explicitName).toBe(true);
    expect(chosen.picture?.asset).toBe(steamAsset);
    expect(chosen.explicitPicture).toBe(true);

    // Google comes back with a new name and a new picture; Steam with a new persona and avatar.
    await signInWith(w, google("A. King", `${GOOGLE_PIC}-new`));
    await signInWith(w, steam("marafox2", `${STEAM_PIC}?v=2`));
    const after = await profile(d);
    expect(after.displayName).toBe("Countess Ada");
    expect(after.explicitName).toBe(true);
    expect(after.picture?.asset).toBe(steamAsset);
    expect(after.explicitPicture).toBe(true);
    // The methods' own copies did follow their providers.
    expect(from(after, "google").name).toBe("A. King");
    expect(from(after, "steam").name).toBe("marafox2");
    expect(from(after, "google").picture!.asset).not.toBe(googleAsset);
    expect(from(after, "steam").picture!.asset).not.toBe(steamAsset);
    // Google's old copy is used by nothing and went at once; Steam's old one is still in use.
    const keys = w.r2.keys();
    expect(keys).not.toContain(renditionKey(googleAsset, 256, "png"));
    expect(keys).toContain(renditionKey(steamAsset, 256, "png"));
  });

  it("a name picked from a method sticks when that method's name changes", async () => {
    const { w, d, steamLink } = await ada();
    const res = await patch(d, { nameFrom: steamLink });
    expect(res.status).toBe(200);
    const p = ((await res.json()) as { profile: ProfileView }).profile;
    expect(p.displayName).toBe("marafox");
    expect(p.displayNameSource).toEqual({
      kind: "provider",
      linkId: steamLink,
      provider: "steam",
    });
    expect(p.explicitName).toBe(true);
    await signInWith(w, steam("marafox2", STEAM_PIC));
    expect((await profile(d)).displayName).toBe("marafox");
  });

  it("Initials stick when the provider sends a new picture", async () => {
    const { w, d } = await ada();
    const googleAsset = (await profile(d)).picture!.asset;
    const res = await patch(d, { picture: "initials" });
    expect(res.status).toBe(200);
    const p = ((await res.json()) as { profile: ProfileView }).profile;
    expect(p.picture).toBeNull();
    expect(p.pictureSource).toEqual({ kind: "initials" });
    expect(p.explicitPicture).toBe(true);
    // The Google copy is still Google's tile, so it stays stored.
    expect(w.r2.keys()).toContain(renditionKey(googleAsset, 96, "webp"));
    await signInWith(w, google("Ada Lovelace", `${GOOGLE_PIC}-new`));
    const after = await profile(d);
    expect(after.picture).toBeNull();
    expect(after.pictureSource).toEqual({ kind: "initials" });
  });

  it("an upload sticks; untouched values keep following until then", async () => {
    const { w, d } = await ada();
    // Untouched: the name follows Google.
    await signInWith(w, google("Ada King", GOOGLE_PIC));
    expect((await profile(d)).displayName).toBe("Ada King");

    const up = await upload(w, d, PNG);
    expect(up.status).toBe(201);
    const { upload: view } = (await up.json()) as {
      upload: { asset: string; url: string; url96: string };
    };
    expect(view.url).toBe(`/media/avatar/${view.asset}`);
    // Uploading does not change the profile; Save (PATCH) does.
    expect((await profile(d)).picture?.asset).not.toBe(view.asset);
    const served = await d.send("GET", `${view.url}.webp`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      fakeRendition("image/webp", 256),
    );
    const res = await patch(d, { picture: { upload: view.asset } });
    expect(res.status).toBe(200);
    const p = ((await res.json()) as { profile: ProfileView }).profile;
    expect(p.picture?.asset).toBe(view.asset);
    expect(p.pictureSource).toEqual({ kind: "upload" });
    await signInWith(w, google("Ada King", `${GOOGLE_PIC}-new`));
    expect((await profile(d)).picture?.asset).toBe(view.asset);
  });
});

describe("PATCH /api/me/profile refusals", () => {
  it("names the reason, and changes nothing", async () => {
    const { w, d } = await ada();
    const emailLink = (await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE kind = 'email'",
    ))!.id;
    const cases: Array<[unknown, number, string]> = [
      [{}, 400, "bad_request"],
      [{ nickname: "x" }, 400, "bad_request"],
      [{ name: "A", nameFrom: emailLink }, 400, "bad_request"],
      [{ picture: "rainbow" }, 400, "bad_request"],
      [
        { picture: { from: emailLink, upload: "a".repeat(64) } },
        400,
        "bad_request",
      ],
      [{ name: "\u202e\u0000  " }, 400, "invalid_name"],
      [{ nameFrom: "lnk_notmine000" }, 404, "unknown_source"],
      [{ picture: { from: emailLink } }, 409, "no_picture"],
      [{ nameFrom: emailLink }, 409, "no_name"],
      [{ picture: { upload: "a".repeat(64) } }, 404, "unknown_upload"],
    ];
    const before = await profile(d);
    for (const [body, status, error] of cases) {
      const res = await patch(d, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(await profile(d)).toEqual(before);
  });

  it("needs the CSRF header", async () => {
    const { w, d } = await ada();
    d.csrf = null;
    expect((await patch(d, { name: "X" })).status).toBe(403);
    expect((await upload(w, d, PNG)).status).toBe(403);
  });

  it("another account's upload or method is not this account's", async () => {
    const { w, d } = await ada();
    const up = await upload(w, d, PNG);
    const { upload: view } = (await up.json()) as { upload: { asset: string } };
    const steamLink = (await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE kind = 'steam'",
    ))!.id;
    // A second person, by email code.
    const other = new Device(w, "203.0.113.99");
    expect((await other.signInWithCode("sam@example.com")).status).toBe(200);
    await other.me();
    expect(
      (await patch(other, { picture: { upload: view.asset } })).status,
    ).toBe(404);
    expect((await patch(other, { picture: { from: steamLink } })).status).toBe(
      404,
    );
  });
});

describe("POST /api/me/profile/picture", () => {
  it("takes PNG or JPEG only, by the bytes, at most 5 MB", async () => {
    const { w, d } = await ada();
    const gif = new TextEncoder().encode("GIF89a........");
    const svg = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    const html = new TextEncoder().encode("<!doctype html><script>1</script>");
    for (const bytes of [gif, svg, html]) {
      const res = await upload(w, d, bytes, { "content-type": "image/png" });
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: string }).error).toBe(
        "unsupported_type",
      );
    }
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await upload(w, d, jpeg)).status).toBe(201);
    expect((await upload(w, d, new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG, 0);
    const tooBig = await upload(w, d, big);
    expect(tooBig.status).toBe(413);
  });

  it("refuses what the encoder cannot turn into the asked image", async () => {
    const { w, d } = await ada();
    w.env.IMAGES = fakeImages({
      output: () => new TextEncoder().encode("<html>"),
    }).binding;
    const res = await upload(w, d, PNG);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unreadable_image",
    );
  });

  it("is unavailable without the Images binding", async () => {
    const { w, d } = await ada();
    delete w.env.IMAGES;
    expect((await upload(w, d, PNG)).status).toBe(503);
  });

  it("is rate-limited per account", async () => {
    const { w, d } = await ada();
    for (let i = 0; i < AVATAR_UPLOADS_PER_HOUR; i++) {
      const res = await upload(w, d, new Uint8Array([...PNG, i]));
      expect(res.status, `upload ${i}`).toBe(201);
    }
    expect((await upload(w, d, new Uint8Array([...PNG, 99]))).status).toBe(429);
  });

  it("keeps at most a few uploads not yet in use", async () => {
    const { w, d } = await ada();
    for (let i = 0; i < AVATAR_PENDING_UPLOADS + 2; i++)
      expect((await upload(w, d, new Uint8Array([...PNG, i]))).status).toBe(
        201,
      );
    const uploads = await w.db.all(
      "SELECT asset FROM account_avatars WHERE origin = 'upload'",
    );
    expect(uploads).toHaveLength(AVATAR_PENDING_UPLOADS);
  });
});

describe("garbage collection and deletion", () => {
  it("the nightly sweep deletes only what nothing uses, after the grace period", async () => {
    const { w, d, steamLink, accountId } = await ada();
    const steamAsset = from(await profile(d), "steam").picture!.asset;
    const up = await upload(w, d, PNG);
    const { upload: pending } = (await up.json()) as {
      upload: { asset: string };
    };
    // Within the grace period nothing goes.
    expect(await sweepAvatars(w.env, w.db, NOW + 60)).toBe(0);
    // Steam is disconnected (I-11's unlink drops the row); its copy is now used by nothing.
    await w.db.run("DELETE FROM account_links WHERE id = ?", steamLink);
    const later = NOW + AVATAR_GC_GRACE_SECONDS + 1;
    expect(await sweepAvatars(w.env, w.db, later)).toBe(2);
    const keys = w.r2.keys();
    expect(keys).not.toContain(renditionKey(steamAsset, 256, "png"));
    expect(keys).not.toContain(renditionKey(pending.asset, 256, "png"));
    // The picture in use (Google's) stays, and a second run deletes nothing.
    expect(keys).toHaveLength(4);
    expect(await sweepAvatars(w.env, w.db, later)).toBe(0);
    expect(
      await w.db.all(
        "SELECT asset FROM account_avatars WHERE account_id = ?",
        accountId,
      ),
    ).toHaveLength(1);
  });

  it("a disconnected method's picture the account still uses is kept (SIGN-IN.md §3.16)", async () => {
    const { w, d, steamLink } = await ada();
    await patch(d, { picture: { from: steamLink } });
    const steamAsset = (await profile(d)).picture!.asset;
    await w.db.run("DELETE FROM account_links WHERE id = ?", steamLink);
    await sweepAvatars(w.env, w.db, NOW + AVATAR_GC_GRACE_SECONDS + 1);
    expect(w.r2.keys()).toContain(renditionKey(steamAsset, 256, "png"));
    const p = await profile(d);
    expect(p.picture?.asset).toBe(steamAsset);
    expect(p.pictureSource).toEqual({
      kind: "provider",
      linkId: steamLink,
      provider: null,
    });
  });

  it("account deletion removes every picture, pending uploads included", async () => {
    const { w, d, accountId } = await ada();
    await upload(w, d, PNG);
    expect(w.r2.keys().length).toBe(12);
    await deleteAccount(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      accountId,
    );
    expect(w.r2.keys()).toEqual([]);
    expect(await w.db.all("SELECT asset FROM account_avatars")).toEqual([]);
  });

  it("a merge moves the absorbed account's pictures, so the survivor's deletion finds them", async () => {
    const { w, d, accountId } = await ada();
    await upload(w, d, PNG);
    const other = new Device(w, "203.0.113.77");
    expect((await other.signInWithCode("sam@example.com")).status).toBe(200);
    await other.me();
    await upload(w, other, new Uint8Array([...PNG, 7]));
    const samId = (await w.db.first<{ id: string }>(
      "SELECT id FROM accounts WHERE id <> ?",
      accountId,
    ))!.id;
    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      {
        survivor: { accountId, authenticatedAt: NOW },
        absorbed: { accountId: samId, authenticatedAt: NOW },
      },
    );
    expect(merged.ok).toBe(true);
    expect(
      await w.db.all(
        "SELECT asset FROM account_avatars WHERE account_id = ?",
        samId,
      ),
    ).toEqual([]);
    await deleteAccount(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      accountId,
    );
    expect(w.r2.keys()).toEqual([]);
  });
});
