import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  PNG,
  seededWorld,
  stubPictureFetch,
  type CardWorld,
} from "./identityCardHarness.js";
import { fakeImages, fakeRendition } from "./imagesFake.js";
import {
  beginProviderSignIn,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import {
  AVATAR_PREFIX,
  deleteAccountAvatars,
  fetchProviderPicture,
  isAllowedAvatarUrl,
  negotiateFormat,
  parseAvatarSegment,
  renditionKey,
} from "../src/services/identity/card/avatars.js";
import {
  sanitizeDisplayName,
  sanitizeLocale,
} from "../src/services/identity/card/profile.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import type { FetchImpl } from "../src/core/safeFetch.js";

// I-07, PX-W16: profile import (S-16 owner decision "import profile data"; PORTAL.md §4.30,
// G32/G33). The first provider fills the profile; untouched values follow that provider;
// explicit choices stick; pictures are fetched only from the providers' hosts, re-encoded to
// WebP and PNG at 256 and 96 px, and served from the Polaris origin.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const GATE = "/api/signin/confirm-email";
const PICTURE = "https://lh3.googleusercontent.com/a/ada-photo";

type World = CardWorld & { images: ReturnType<typeof fakeImages> };

/** A card world with the Images binding. */
async function world(): Promise<World> {
  const w = await seededWorld();
  const images = fakeImages();
  w.env.IMAGES = images.binding;
  return { ...w, images };
}

/** Every rendition key of an asset, sorted like `R2Mock.keys()`. */
function renditions(asset: string): string[] {
  return [
    renditionKey(asset, 256, "webp"),
    renditionKey(asset, 256, "png"),
    renditionKey(asset, 96, "webp"),
    renditionKey(asset, 96, "png"),
  ].sort();
}

function googleWith(
  profile: ProviderSignIn["profile"],
  name = "Ada Lovelace",
): ProviderSignIn {
  return {
    identity: {
      issuerKey: "https://accounts.google.com",
      subject: "g-1",
      kind: "google",
      email: "ada@gmail.com",
      emailVerified: true,
      displayName: name,
    },
    profile,
  };
}

async function arrive(
  w: CardWorld,
  d: Device,
  input: ProviderSignIn,
): Promise<Response> {
  return d.absorb(
    await beginProviderSignIn(
      d.request("GET", "/signin/google/callback"),
      w.env,
      w.db,
      input,
      NOW,
    ),
  );
}

async function account(w: CardWorld) {
  return w.db.first<{
    id: string;
    display_name: string | null;
    avatar_key: string | null;
    locale: string | null;
    details_source_json: string | null;
  }>(
    "SELECT id, display_name, avatar_key, locale, details_source_json FROM accounts",
  );
}

describe("profile import", () => {
  it("fills a new account from the provider; the picture is re-encoded to four renditions and served same-origin", async () => {
    const w = await world();
    const fetched = stubPictureFetch();
    const d = new Device(w);
    await arrive(
      w,
      d,
      googleWith({
        name: "Ada Lovelace",
        pictureUrl: PICTURE,
        locale: "en_GB",
      }),
    );
    // The gate shows the picture through its own proxy, re-encoded, before anything is stored.
    const view = (await (await d.send("GET", GATE)).json()) as {
      profile: { name: string; picture: string | null; locale: string };
    };
    expect(view.profile).toEqual({
      name: "Ada Lovelace",
      nameExplicit: false,
      picture: `${GATE}/picture`,
      locale: "en-GB",
    });
    const proxied = await d.send("GET", `${GATE}/picture`, undefined, {
      headers: { accept: "image/avif,image/webp,*/*" },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("content-type")).toBe("image/webp");
    expect(proxied.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await proxied.arrayBuffer())).toEqual(
      fakeRendition("image/webp", 256),
    );
    expect(w.r2.keys()).toEqual([]);

    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      200,
    );
    const row = (await account(w))!;
    expect(row.display_name).toBe("Ada Lovelace");
    expect(row.locale).toBe("en-GB");
    expect(row.avatar_key).toMatch(/^[0-9a-f]{64}$/);
    expect(w.r2.keys()).toEqual(renditions(row.avatar_key!));
    expect(fetched.calls.every((u) => u === PICTURE)).toBe(true);
    // Square, one frame, both formats at both sizes.
    expect(
      w.images.calls.slice(-4).map((c) => [c.width, c.height, c.fit, c.format]),
    ).toEqual([
      [256, 256, "cover", "image/webp"],
      [256, 256, "cover", "image/png"],
      [96, 96, "cover", "image/webp"],
      [96, 96, "cover", "image/png"],
    ]);
    expect(w.images.calls.every((c) => c.anim === false)).toBe(true);
    const stored = await w.db.first<{ account_id: string; origin: string }>(
      "SELECT account_id, origin FROM account_avatars WHERE asset = ?",
      row.avatar_key,
    );
    expect(stored).toEqual({ account_id: row.id, origin: "provider" });

    // `/api/me` hands out the same-origin URL, and the route serves the encoder's output safely.
    const me = (await (await d.me()).json()) as {
      account: { avatarUrl: string };
    };
    expect(me.account.avatarUrl).toBe(`/media/avatar/${row.avatar_key}`);
    const served = await d.send("GET", me.account.avatarUrl);
    expect(served.status).toBe(200);
    // No `Accept: image/webp` from this client: PNG.
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("vary")).toBe("Accept");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(served.headers.get("content-disposition")).toBe(
      'inline; filename="avatar.png"',
    );
    expect(served.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      fakeRendition("image/png", 256),
    );
    const small = await d.send("GET", `${me.account.avatarUrl}-96.webp`);
    expect(small.headers.get("content-type")).toBe("image/webp");
    expect(small.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await small.arrayBuffer())).toEqual(
      fakeRendition("image/webp", 96),
    );
    // Revalidation, and HEAD.
    const etag = served.headers.get("etag")!;
    const again = await d.send("GET", me.account.avatarUrl, undefined, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    const head = await d.send("HEAD", me.account.avatarUrl);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("an explicit name typed in the gate sticks; untouched values follow the provider on sign-in", async () => {
    const w = await world();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ name: "Ada Lovelace", locale: "en" }));
    await d.send("POST", GATE, { choice: "provider", name: "Countess Ada" });
    expect((await account(w))!.display_name).toBe("Countess Ada");

    // The provider later reports a new name and locale: the name stays chosen, the locale follows.
    await arrive(
      w,
      new Device(w, "198.51.100.5"),
      googleWith({ name: "A. King", locale: "fr" }, "A. King"),
    );
    const row = (await account(w))!;
    expect(row.display_name).toBe("Countess Ada");
    expect(row.locale).toBe("fr");
  });

  it("an untouched name follows the provider", async () => {
    const w = await world();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ name: "Ada Lovelace" }));
    await d.send("POST", GATE, { choice: "provider" });
    await arrive(
      w,
      new Device(w, "198.51.100.6"),
      googleWith({ name: "Ada King" }, "Ada King"),
    );
    expect((await account(w))!.display_name).toBe("Ada King");
  });

  it("a new picture replaces the copy and deletes the old renditions; an unchanged URL is not fetched again", async () => {
    const w = await world();
    const fetched = stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const first = (await account(w))!.avatar_key!;
    const calls = fetched.calls.length;
    // Same URL: not fetched again, same asset.
    await arrive(
      w,
      new Device(w, "198.51.100.7"),
      googleWith({ pictureUrl: PICTURE }),
    );
    expect((await account(w))!.avatar_key).toBe(first);
    expect(fetched.calls.length).toBe(calls);
    // A new URL whose bytes differ: a new asset, and the old one is gone with its row.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([...PNG, 1, 2, 3]), { status: 200 }),
      ),
    );
    await arrive(
      w,
      new Device(w, "198.51.100.8"),
      googleWith({ pictureUrl: `${PICTURE}-2` }),
    );
    const second = (await account(w))!.avatar_key!;
    expect(second).not.toBe(first);
    expect(w.r2.keys()).toEqual(renditions(second));
    expect(
      await w.db.first("SELECT 1 FROM account_avatars WHERE asset = ?", first),
    ).toBeNull();
  });

  it("never fetches a picture from a host off the allowlist", async () => {
    const w = await world();
    const fetched = stubPictureFetch();
    const d = new Device(w);
    await arrive(
      w,
      d,
      googleWith({ pictureUrl: "https://169.254.169.254/latest/meta-data" }),
    );
    expect((await d.send("GET", `${GATE}/picture`)).status).toBe(404);
    await d.send("POST", GATE, { choice: "provider" });
    expect(fetched.calls).toEqual([]);
    expect((await account(w))!.avatar_key).toBeNull();
    expect(w.r2.keys()).toEqual([]);
  });

  it("without the Images binding nothing is copied: a picture is never stored as fetched", async () => {
    const w = await seededWorld();
    const fetched = stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    expect((await d.send("GET", `${GATE}/picture`)).status).toBe(404);
    await d.send("POST", GATE, { choice: "provider" });
    expect(fetched.calls).toEqual([]);
    expect((await account(w))!.avatar_key).toBeNull();
    expect(w.r2.keys()).toEqual([]);
  });

  it("account deletion finds and removes every rendition and row (the hook I-11 calls)", async () => {
    const w = await world();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const row = (await account(w))!;
    expect(w.r2.keys()).toHaveLength(4);
    expect(await deleteAccountAvatars(w.env, w.db, row.id)).toBe(1);
    expect(w.r2.keys()).toEqual([]);
    expect(
      await w.db.first(
        "SELECT 1 FROM account_avatars WHERE account_id = ?",
        row.id,
      ),
    ).toBeNull();
  });

  it("deleteAccount removes the pictures with the account; the URL then 404s", async () => {
    const w = await world();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const row = (await account(w))!;
    const before = await d.send("GET", `/media/avatar/${row.avatar_key}`);
    const etag = before.headers.get("etag")!;
    await deleteAccount(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      row.id,
    );
    expect(w.r2.keys()).toEqual([]);
    expect(
      (await d.send("GET", `/media/avatar/${row.avatar_key}`)).status,
    ).toBe(404);
    // A browser's cached copy is not revalidated either.
    expect(
      (
        await d.send("GET", `/media/avatar/${row.avatar_key}`, undefined, {
          headers: { "if-none-match": etag },
        })
      ).status,
    ).toBe(404);
  });

  it("a stored object whose bytes are not the rendition's type is never served", async () => {
    const w = await world();
    const d = new Device(w);
    const asset = "a".repeat(64);
    await w.env.BLOBS!.put(
      renditionKey(asset, 256, "png"),
      new TextEncoder().encode(
        "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>",
      ),
    );
    expect((await d.send("GET", `/media/avatar/${asset}.png`)).status).toBe(
      404,
    );
  });
});

describe("the provider fetch goes through the guarded fetcher with this route's allowlist", () => {
  const png = () => new Response(PNG, { status: 200 });

  it("allows only the providers' hosts, over https on 443, with no credentials", () => {
    expect(isAllowedAvatarUrl(PICTURE)).toBe(true);
    expect(isAllowedAvatarUrl("https://avatars.steamstatic.com/a.jpg")).toBe(
      true,
    );
    for (const refused of [
      "http://lh3.googleusercontent.com/a",
      "https://lh3.googleusercontent.com:8443/a",
      "https://user:pw@lh3.googleusercontent.com/a",
      "https://evil.example/lh3.googleusercontent.com",
      "https://lh3.googleusercontent.com.evil.example/a",
      "https://googleusercontent.com/a",
      "https://169.254.169.254/latest/meta-data",
      "https://key.plrs.im/media/avatar/x",
      "not a url",
    ]) {
      expect(isAllowedAvatarUrl(refused), refused).toBe(false);
    }
  });

  it("refuses a host off the allowlist without dialling it", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string | Request) => {
      calls.push(String(u));
      return png();
    }) as FetchImpl;
    const res = await fetchProviderPicture("https://evil.example/a.png", {
      fetchImpl,
    });
    expect(res).toEqual({ ok: false, reason: "guard:not-allowed" });
    expect(calls).toEqual([]);
  });

  it("re-checks every redirect hop: an allowlisted host cannot bounce the fetch elsewhere", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string | Request) => {
      calls.push(String(u));
      return new Response(null, {
        status: 302,
        headers: { location: "https://metadata.example/secret" },
      });
    }) as FetchImpl;
    const res = await fetchProviderPicture(PICTURE, { fetchImpl });
    expect(res).toEqual({ ok: false, reason: "guard:not-allowed" });
    expect(calls).toEqual([PICTURE]);
  });

  it("follows a redirect between the provider's own hosts", async () => {
    const fetchImpl = (async (u: string | Request) =>
      String(u) === PICTURE
        ? new Response(null, {
            status: 302,
            headers: { location: "https://lh5.googleusercontent.com/a/x" },
          })
        : png()) as FetchImpl;
    const res = await fetchProviderPicture(PICTURE, { fetchImpl });
    expect(res.ok).toBe(true);
  });

  it("takes only PNG, JPEG, WebP or GIF bytes, whatever the upstream type says", async () => {
    const fetchImpl = (async () =>
      new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as FetchImpl;
    expect(await fetchProviderPicture(PICTURE, { fetchImpl })).toEqual({
      ok: false,
      reason: "not-an-image",
    });
  });

  it("refuses a body over the cap", async () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(PNG, 0);
    const fetchImpl = (async () =>
      new Response(big, { status: 200 })) as FetchImpl;
    expect(await fetchProviderPicture(PICTURE, { fetchImpl })).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("imported values are untrusted display data", () => {
  it("names lose control and bidirectional characters and are cut to 64", () => {
    expect(sanitizeDisplayName("Ada\u202e\u0000 Lovelace")).toBe(
      "Ada Lovelace",
    );
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect([...sanitizeDisplayName("x".repeat(100))!]).toHaveLength(64);
  });

  it("locales must look like BCP 47", () => {
    expect(sanitizeLocale("pt_BR")).toBe("pt-BR");
    expect(sanitizeLocale("<script>")).toBeNull();
  });

  it("the media route names an asset, a size and a format, and nothing else", () => {
    const a = "0123456789abcdef".repeat(4);
    expect(parseAvatarSegment(a)).toEqual({
      asset: a,
      size: 256,
      format: null,
    });
    expect(parseAvatarSegment(`${a}-96.webp`)).toEqual({
      asset: a,
      size: 96,
      format: "webp",
    });
    expect(parseAvatarSegment(`${a}.png`)).toEqual({
      asset: a,
      size: 256,
      format: "png",
    });
    for (const bad of [`${a}.svg`, `${a}-128`, a.slice(1), "abc", `${a}/x`])
      expect(parseAvatarSegment(bad), bad).toBeNull();
    expect(negotiateFormat("image/avif,image/webp,*/*;q=0.8")).toBe("webp");
    expect(negotiateFormat("image/webp")).toBe("webp");
    expect(negotiateFormat("*/*")).toBe("png");
    expect(negotiateFormat(null)).toBe("png");
  });

  it("anything that is not an asset is the one 404", async () => {
    const w = await world();
    const d = new Device(w);
    expect(
      (await d.send("GET", "/media/avatar/..%2f..%2fsecrets")).status,
    ).toBe(404);
    expect((await d.send("GET", "/media/avatar/abc")).status).toBe(404);
    // I-07's random 32-hex keys are not served (nothing re-encoded them).
    await w.env.BLOBS!.put(`${AVATAR_PREFIX}${"b".repeat(32)}`, PNG);
    expect(
      (await d.send("GET", `/media/avatar/${"b".repeat(32)}`)).status,
    ).toBe(404);
  });
});
