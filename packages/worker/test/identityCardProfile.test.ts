import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  PNG,
  seededWorld,
  stubPictureFetch,
  type CardWorld,
} from "./identityCardHarness.js";
import {
  beginProviderSignIn,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import {
  AVATAR_PREFIX,
  deleteAccountAvatars,
  isAllowedAvatarUrl,
  sniffImageType,
} from "../src/services/identity/card/avatars.js";
import {
  sanitizeDisplayName,
  sanitizeLocale,
} from "../src/services/identity/card/profile.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";

// I-07: profile import (S-16 owner decision "import profile data"; PORTAL.md §4.30, G32/G33).
// The first provider fills the profile; untouched values follow that provider; explicit choices
// stick; pictures are copied into R2 and served from the Polaris origin.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const GATE = "/api/signin/confirm-email";
const PICTURE = "https://lh3.googleusercontent.com/a/ada-photo";

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
  it("fills a new account from the provider and copies the picture into R2, served same-origin", async () => {
    const w = await seededWorld();
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
    // The gate shows the picture through its own proxy, before anything is stored.
    const view = (await (await d.send("GET", GATE)).json()) as {
      profile: { name: string; picture: string | null; locale: string };
    };
    expect(view.profile).toEqual({
      name: "Ada Lovelace",
      nameExplicit: false,
      picture: `${GATE}/picture`,
      locale: "en-GB",
    });
    const proxied = await d.send("GET", `${GATE}/picture`);
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("content-type")).toBe("image/png");
    expect(w.r2.keys()).toEqual([]);

    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      200,
    );
    const row = (await account(w))!;
    expect(row.display_name).toBe("Ada Lovelace");
    expect(row.locale).toBe("en-GB");
    expect(row.avatar_key).toMatch(/^[0-9a-f]{32}$/);
    expect(w.r2.keys()).toEqual([`${AVATAR_PREFIX}${row.avatar_key}`]);
    expect(fetched.calls.every((u) => u === PICTURE)).toBe(true);

    // `/api/me` hands out the same-origin URL, and the route serves the bytes safely.
    const me = (await (await d.me()).json()) as {
      account: { avatarUrl: string };
    };
    expect(me.account.avatarUrl).toBe(`/media/avatar/${row.avatar_key}`);
    const served = await d.send("GET", me.account.avatarUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("an explicit name typed in the gate sticks; untouched values follow the provider on sign-in", async () => {
    const w = await seededWorld();
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
    const w = await seededWorld();
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

  it("a new picture URL replaces the copy and removes the old object", async () => {
    const w = await seededWorld();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const first = (await account(w))!.avatar_key!;
    // Same URL: not fetched again, same key.
    await arrive(
      w,
      new Device(w, "198.51.100.7"),
      googleWith({ pictureUrl: PICTURE }),
    );
    expect((await account(w))!.avatar_key).toBe(first);
    await arrive(
      w,
      new Device(w, "198.51.100.8"),
      googleWith({ pictureUrl: `${PICTURE}-2` }),
    );
    const second = (await account(w))!.avatar_key!;
    expect(second).not.toBe(first);
    expect(w.r2.keys()).toEqual([`${AVATAR_PREFIX}${second}`]);
  });

  it("never fetches a picture from a host off the allowlist", async () => {
    const w = await seededWorld();
    const fetched = stubPictureFetch();
    const d = new Device(w);
    await arrive(
      w,
      d,
      googleWith({ pictureUrl: "https://169.254.169.254/latest/meta-data" }),
    );
    await d.send("GET", `${GATE}/picture`);
    await d.send("POST", GATE, { choice: "provider" });
    expect(fetched.calls).toEqual([]);
    expect((await account(w))!.avatar_key).toBeNull();
    expect(w.r2.keys()).toEqual([]);
  });

  it("account deletion finds and removes every copied picture (the hook I-11 calls)", async () => {
    const w = await seededWorld();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const row = (await account(w))!;
    expect(w.r2.keys()).toHaveLength(1);
    expect(await deleteAccountAvatars(w.env, w.db, row.id)).toBe(1);
    expect(w.r2.keys()).toEqual([]);
  });

  it("deleteAccount removes the pictures with the account", async () => {
    const w = await seededWorld();
    stubPictureFetch();
    const d = new Device(w);
    await arrive(w, d, googleWith({ pictureUrl: PICTURE }));
    await d.send("POST", GATE, { choice: "provider" });
    const row = (await account(w))!;
    await deleteAccount(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      row.id,
    );
    expect(w.r2.keys()).toEqual([]);
    expect(
      (await d.send("GET", `/media/avatar/${row.avatar_key}`)).status,
    ).toBe(404);
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

  it("the avatar fetch allows only the providers' https hosts and image bytes by magic number", () => {
    expect(isAllowedAvatarUrl(PICTURE)).toBe(true);
    expect(isAllowedAvatarUrl("https://avatars.steamstatic.com/a.jpg")).toBe(
      true,
    );
    expect(isAllowedAvatarUrl("http://lh3.googleusercontent.com/a")).toBe(
      false,
    );
    expect(isAllowedAvatarUrl("https://lh3.googleusercontent.com:8443/a")).toBe(
      false,
    );
    expect(
      isAllowedAvatarUrl("https://evil.example/lh3.googleusercontent.com"),
    ).toBe(false);
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("an avatar key that is not 32 hex characters is the one 404", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    expect(
      (await d.send("GET", "/media/avatar/..%2f..%2fsecrets")).status,
    ).toBe(404);
    expect((await d.send("GET", "/media/avatar/abc")).status).toBe(404);
  });
});
