/**
 * PX-W3 — licensed R2 downloads from the portal through a download ticket (plans/PX-W3.md §9,
 * portal gap G3).
 *
 *   1. The ticket itself (`core/downloadTicket.ts`): its lifetime bound, its binding to one
 *      file of one release of one product on one host, tampering, key ids and rotation.
 *   2. End to end on the Diceroll world (`downloadWorld.ts`, every file held only on R2): the
 *      listing offers licensed files, the mint answers them, redemption 302s to the bytes host
 *      with `?ticket=`, and the bytes host serves GET, Range and HEAD with the ticket alone.
 *   3. What does not get through: an expired or over-long ticket, a ticket for another file,
 *      the console host, a licence revoked, suspended or detached before redemption, an
 *      `entitled` release outside the window, an unset key or bytes host, a `gated/` location.
 *   4. Identity off and an attested-enforced trust policy (Q4 (a): the portal's licence-only
 *      rule) download normally.
 *
 * These answers are also LX-09's `legacy` regression for the portal download caller (§6.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobKey } from "../src/core/blobs.js";
import {
  DOWNLOAD_TICKET_LABEL,
  DOWNLOAD_TICKET_TTL_SECONDS,
  downloadTicketsEnabled,
  mintDownloadTicket,
  verifyDownloadTicket,
  type DownloadTicketFile,
} from "../src/core/downloadTicket.js";
import { parseServices } from "../src/core/services.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import type { PortalDownloads } from "../src/services/identity/portal/downloads.js";
import type { Env } from "../src/env.js";
import { dispatch } from "../src/dispatch.js";
import {
  handlePortalApi,
  handlePortalDownload,
  seedRepositoryVisibility,
} from "./portalHarness.js";
import { NOW, makeEnv, seedLicenseWithKey } from "./seed.js";
import { KvMock } from "./kvMock.js";
import {
  BYTES,
  CONSOLE,
  SLUG,
  UA,
  bytesFor,
  sha,
  setup,
  type World,
} from "./downloadWorld.js";

const KEY = "dGlja2V0LWtleS1jdXJyZW50LTMyLWJ5dGVzLWxvbmch"; // a base64 string, as provisioned
const OLD_KEY = "dGlja2V0LWtleS1wcmV2aW91cy0zMi1ieXRlcy1sb25n";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── 1. The ticket ────────────────────────────────────────────────────────────────────────────

function ticketEnv(over: Partial<Env> = {}): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.BLOB_ORIGIN = BYTES;
  env.DOWNLOAD_TICKET_KEY = KEY;
  return Object.assign(env, over);
}

const FILE: DownloadTicketFile = {
  product: SLUG,
  releaseId: "app@1.2.0",
  name: "Diceroll-1.2.0-windows-x86_64.zip",
  sha256: "a".repeat(64),
};
const AT = { ...FILE, host: "dl.example.test" };

describe("download tickets (core/downloadTicket.ts)", () => {
  it("has the S-19 shape and label, and lives 120 s", async () => {
    expect(DOWNLOAD_TICKET_LABEL).toBe("pkey-download-ticket/1");
    expect(DOWNLOAD_TICKET_TTL_SECONDS).toBe(120);
    const t = await mintDownloadTicket(ticketEnv(), FILE, NOW);
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]{8}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(t!.split(".")[2]).toBe(String(NOW + 120));
    expect(await verifyDownloadTicket(ticketEnv(), t!, AT, NOW)).toBe(true);
    // Reusable inside the window (Range, resume, HEAD), refused at and after `exp`.
    expect(await verifyDownloadTicket(ticketEnv(), t!, AT, NOW + 119)).toBe(
      true,
    );
    expect(await verifyDownloadTicket(ticketEnv(), t!, AT, NOW + 120)).toBe(
      false,
    );
    expect(await verifyDownloadTicket(ticketEnv(), t!, AT, NOW + 600)).toBe(
      false,
    );
  });

  it("refuses an exp more than 120 s ahead (a ticket minted 121 s into the future)", async () => {
    const future = await mintDownloadTicket(ticketEnv(), FILE, NOW + 1);
    // exp = NOW + 121: validly signed, but beyond the verifier's bound.
    expect(await verifyDownloadTicket(ticketEnv(), future!, AT, NOW)).toBe(
      false,
    );
    expect(await verifyDownloadTicket(ticketEnv(), future!, AT, NOW + 1)).toBe(
      true,
    );
  });

  it("is bound to the host, product, release, name and SHA-256", async () => {
    const env = ticketEnv();
    const t = (await mintDownloadTicket(env, FILE, NOW))!;
    for (const other of [
      { ...AT, host: "key.example.test" },
      { ...AT, product: "other" },
      { ...AT, releaseId: "app@1.1.0" },
      { ...AT, name: "Diceroll-1.2.0-windows-arm64.zip" },
      { ...AT, sha256: "b".repeat(64) },
    ])
      expect(await verifyDownloadTicket(env, t, other, NOW)).toBe(false);
    // The host compares as hosts do: case and a trailing dot are the same name.
    expect(
      await verifyDownloadTicket(
        env,
        t,
        { ...AT, host: "DL.example.test." },
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses a tampered ticket, an unknown kid and junk", async () => {
    const env = ticketEnv();
    const t = (await mintDownloadTicket(env, FILE, NOW))!;
    const [v, kid, exp, mac] = t.split(".") as [string, string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${v}.${kid}.${exp}.${flip(mac)}`,
      `${v}.${kid}.${Number(exp) - 1}.${mac}`,
      `${v}.${flip(kid)}.${exp}.${mac}`,
      `v2.${kid}.${exp}.${mac}`,
      `${t}.x`,
      "",
      "v1...",
      "x".repeat(4096),
    ])
      expect(await verifyDownloadTicket(env, bad, AT, NOW), bad).toBe(false);
  });

  it("rotation: the previous key's ticket verifies by its own kid; a removed key's does not", async () => {
    const old = (await mintDownloadTicket(
      ticketEnv({ DOWNLOAD_TICKET_KEY: OLD_KEY }),
      FILE,
      NOW,
    ))!;
    const rotated = ticketEnv({ DOWNLOAD_TICKET_KEY_PREVIOUS: OLD_KEY });
    expect(await verifyDownloadTicket(rotated, old, AT, NOW)).toBe(true);
    expect(old.split(".")[1]).not.toBe(
      (await mintDownloadTicket(rotated, FILE, NOW))!.split(".")[1],
    );
    expect(await verifyDownloadTicket(ticketEnv(), old, AT, NOW)).toBe(false);
  });

  it("fails closed: nothing is minted or verified without the key or the bytes host", async () => {
    const t = (await mintDownloadTicket(ticketEnv(), FILE, NOW))!;
    const noKey = ticketEnv({ DOWNLOAD_TICKET_KEY: undefined });
    expect(downloadTicketsEnabled(noKey)).toBe(false);
    expect(await mintDownloadTicket(noKey, FILE, NOW)).toBeNull();
    expect(await verifyDownloadTicket(noKey, t, AT, NOW)).toBe(false);
    const noHost = ticketEnv({ BLOB_ORIGIN: undefined });
    expect(downloadTicketsEnabled(noHost)).toBe(false);
    expect(await mintDownloadTicket(noHost, FILE, NOW)).toBeNull();
    expect(downloadTicketsEnabled(ticketEnv())).toBe(true);
  });

  it("refuses a field that would make the signed message ambiguous", async () => {
    const env = ticketEnv();
    expect(
      await mintDownloadTicket(env, { ...FILE, name: "a\nb" }, NOW),
    ).toBeNull();
    expect(
      await mintDownloadTicket(env, { ...FILE, name: "" }, NOW),
    ).toBeNull();
  });
});

// ── 2–4. End to end ──────────────────────────────────────────────────────────────────────────

interface Portal {
  cookie: string;
  csrf: string;
  licenseId: string;
  accountId: string;
}

async function world(
  access: string,
  opts: { key?: boolean; blobs?: boolean } = {},
): Promise<World> {
  const w = await setup({ access });
  if (opts.key !== false) w.env.DOWNLOAD_TICKET_KEY = KEY;
  // The world records every file's R2 object; put the bytes there so the bytes host has them.
  if (opts.blobs !== false) {
    const files = await w.db.all<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM release_artifacts WHERE product = ?",
      SLUG,
    );
    for (const f of files) {
      const bytes = bytesFor(f.name);
      expect(sha(bytes)).toBe(f.sha256);
      await w.env.BLOBS!.put(blobKey(f.sha256), bytes, { sha256: f.sha256 });
    }
  }
  return w;
}

async function account(
  w: World,
  license: Parameters<typeof seedLicenseWithKey>[2] = {},
): Promise<Portal> {
  w.env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const { licenseId } = await seedLicenseWithKey(w.db, SLUG, license);
  const acct = await getOrCreateAccountByEmail(w.db, "ada@example.com", NOW);
  await linkLicense(w.db, acct.id, SLUG, licenseId, "license-key", NOW);
  const { token } = await issuePortalSession(
    w.env,
    { accountId: acct.id, email: acct.primary_email, name: acct.display_name },
    NOW,
  );
  const cookie = `${PORTAL_COOKIE}=${token}`;
  const me = await handlePortalApi(
    new Request(`${CONSOLE}/api/me`, { headers: { cookie } }),
    w.env,
    w.db,
    "/api/me",
    NOW,
  );
  const { csrf } = (await me.json()) as { csrf: string };
  return { cookie, csrf, licenseId, accountId: acct.id };
}

async function listing(w: World, p: Portal): Promise<PortalDownloads> {
  const path = `/api/products/${SLUG}/downloads`;
  const res = await handlePortalApi(
    new Request(`${CONSOLE}${path}`, {
      headers: { cookie: p.cookie, "user-agent": UA.windows },
    }),
    w.env,
    w.db,
    path,
    NOW,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as PortalDownloads;
}

async function artifactOf(w: World, releaseId: string, name: string) {
  const row = await w.db.first<{ artifact_id: string; sha256: string }>(
    `SELECT artifact_id, sha256 FROM release_artifacts
      WHERE product = ? AND release_id = ? AND name = ?`,
    SLUG,
    releaseId,
    name,
  );
  expect(row, name).not.toBeNull();
  return row!;
}

async function mint(
  w: World,
  p: Portal,
  releaseId: string,
  artifactId: string,
): Promise<Response> {
  const path = `/api/releases/${SLUG}/${releaseId}/artifacts/${artifactId}/token`;
  return handlePortalApi(
    new Request(`${CONSOLE}${path}`, {
      method: "POST",
      headers: { cookie: p.cookie, "x-pkey-portal-csrf": p.csrf },
    }),
    w.env,
    w.db,
    path,
    NOW,
  );
}

async function token(
  w: World,
  p: Portal,
  releaseId = "app@1.2.0",
  name = "Diceroll-1.2.0-windows-x86_64.zip",
): Promise<string> {
  const { artifact_id } = await artifactOf(w, releaseId, name);
  const res = await mint(w, p, releaseId, artifact_id);
  expect(res.status, await res.clone().text()).toBe(201);
  const { url } = (await res.json()) as { url: string };
  return decodeURIComponent(url.replace(/^\/download\//, ""));
}

function redeem(w: World, t: string): Promise<Response> {
  return handlePortalDownload(
    new Request(`${CONSOLE}/download/${encodeURIComponent(t)}`),
    w.env,
    w.db,
    t,
    NOW,
  );
}

/** Mint, redeem, and return the 302's Location. */
async function ticketedUrl(
  w: World,
  p: Portal,
  releaseId = "app@1.2.0",
  name = "Diceroll-1.2.0-windows-x86_64.zip",
): Promise<URL> {
  const res = await redeem(w, await token(w, p, releaseId, name));
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  return new URL(res.headers.get("location")!);
}

function fetchUrl(w: World, url: URL | string, init: RequestInit = {}) {
  return dispatch(new Request(url.toString(), init), w.env, w.db);
}

const WIN = "Diceroll-1.2.0-windows-x86_64.zip";

describe("licensed R2 downloads from the portal", () => {
  it("listing: a licensed R2 file is downloadable, and so is an authenticated one", async () => {
    for (const access of ["licensed", "authenticated"]) {
      const w = await world(access);
      const p = await account(w);
      const body = await listing(w, p);
      const files = body.platforms.flatMap((x) => x.files);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.canDownload && f.reason === null)).toBe(true);
      expect(body.recommended).toMatchObject({
        platform: "windows",
        version: "1.2.0",
      });
    }
  });

  it("mint and redeem: a 302 to the file's canonical bytes-host URL with ?ticket=", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    expect(url.origin).toBe(BYTES);
    expect(url.pathname).toBe(
      `/${SLUG}/distribution/files/${encodeURIComponent("app@1.2.0")}/${WIN}`,
    );
    expect([...url.searchParams.keys()]).toEqual(["ticket"]);
    expect(url.searchParams.get("ticket")).toMatch(/^v1\./);
  });

  it("private GitHub repository (Q7): a licensed file goes through the ticket, a public repo's to GitHub", async () => {
    const w = await world("licensed");
    await w.db.run(
      `UPDATE release_artifacts
          SET source_url = 'https://objects.githubusercontent.com/diceroll/' || artifact_id
        WHERE product = ?`,
      SLUG,
    );
    await seedRepositoryVisibility(w.env, w.db, SLUG, "private");
    const p = await account(w);
    const files = (await listing(w, p)).platforms.flatMap((x) => x.files);
    expect(files.every((f) => f.canDownload && f.reason === null)).toBe(true);
    // A private repository's URL would answer a browser with GitHub's 404, so the redirect is
    // the bytes host (which streams the asset with Release's installation token) plus a ticket.
    const url = await ticketedUrl(w, p);
    expect(url.origin).toBe(BYTES);
    expect(url.searchParams.get("ticket")).toMatch(/^v1\./);
    expect((await fetchUrl(w, url)).status).toBe(200);

    // The same repository made public: GitHub's own URL, no ticket.
    await seedRepositoryVisibility(w.env, w.db, SLUG, "public");
    const res = await redeem(w, await token(w, p));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hostname).toBe(
      "objects.githubusercontent.com",
    );
  });

  it("bytes host: GET 200, Range 206 and HEAD, all private and forced to download", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    const want = new TextDecoder().decode(bytesFor(WIN));

    const get = await fetchUrl(w, url);
    expect(get.status, await get.clone().text()).toBe(200);
    expect(await get.text()).toBe(want);
    expect(get.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
    expect(get.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("set-cookie")).toBeNull();

    const range = await fetchUrl(w, url, { headers: { range: "bytes=0-4" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe(want.slice(0, 5));

    const head = await fetchUrl(w, url, { method: "HEAD" });
    expect(head.status).toBe(200);

    // The same URL without the ticket is today's no-credential answer.
    const bare = new URL(url);
    bare.search = "";
    expect((await fetchUrl(w, bare)).status).toBe(401);
  });

  it("expiry: an expired ticket is refused like a missing one", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    vi.setSystemTime((NOW + 119) * 1000);
    expect((await fetchUrl(w, url)).status).toBe(200);
    vi.setSystemTime((NOW + 120) * 1000);
    const res = await fetchUrl(w, url);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "download_auth_required",
    );
  });

  it("binding: a ticket presented for another file, release or product is refused", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    const ticket = url.searchParams.get("ticket")!;
    for (const path of [
      `/${SLUG}/distribution/files/${encodeURIComponent("app@1.2.0")}/Diceroll-1.2.0-windows-arm64.zip`,
      `/${SLUG}/distribution/files/${encodeURIComponent("app@1.1.0")}/Diceroll-1.1.0-windows-x86_64.zip`,
    ]) {
      const res = await fetchUrl(
        w,
        `${BYTES}${path}?ticket=${encodeURIComponent(ticket)}`,
      );
      expect(res.status, path).toBe(401);
    }
    // A tampered ticket on the right file.
    const tampered = new URL(url);
    tampered.searchParams.set("ticket", `${ticket.slice(0, -1)}A`);
    if (tampered.searchParams.get("ticket") === ticket)
      tampered.searchParams.set("ticket", `${ticket.slice(0, -1)}B`);
    expect((await fetchUrl(w, tampered)).status).toBe(401);
    // The file's bytes replaced under the same name: the ticket bound the old SHA-256.
    await w.db.run(
      `UPDATE release_artifacts SET sha256 = ? WHERE product = ? AND release_id = ? AND name = ?`,
      "c".repeat(64),
      SLUG,
      "app@1.2.0",
      WIN,
    );
    expect((await fetchUrl(w, url)).status).toBe(401);
  });

  it("two artifacts sharing a name in one release: the shadowed one's ticket fails closed", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const original = await artifactOf(w, "app@1.2.0", WIN);
    // A second row with the same name and other bytes. The `files` route serves the first
    // artifact (by id) with that name, so a ticket minted for this one binds a SHA-256 the bytes
    // host never sees for that URL.
    const dupId = `${original.artifact_id}~dup`;
    await w.db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       SELECT product, release_id, ?, name, kind, platform, arch, content_type,
              size_bytes, ?, source_url, storage_key, sparkle_signature, access,
              metadata_json, created_at
         FROM release_artifacts
        WHERE product = ? AND release_id = ? AND artifact_id = ?`,
      dupId,
      "f".repeat(64),
      SLUG,
      "app@1.2.0",
      original.artifact_id,
    );
    const minted = await mint(w, p, "app@1.2.0", dupId);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { url: path } = (await minted.json()) as { url: string };
    const res = await redeem(
      w,
      decodeURIComponent(path.replace(/^\/download\//, "")),
    );
    expect(res.status).toBe(302);
    expect((await fetchUrl(w, res.headers.get("location")!)).status).toBe(401);
    // The served artifact's own ticket still works.
    expect((await fetchUrl(w, await ticketedUrl(w, p))).status).toBe(200);
  });

  it("entitled: the ticket answers where the wire answer would be 401 unauthorized", async () => {
    const w = await world("entitled");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    expect((await fetchUrl(w, url)).status).toBe(200);
    const bad = new URL(url);
    bad.searchParams.set("ticket", "v1.AAAAAAAA.1.x");
    const res = await fetchUrl(w, bad);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("console host: a ticket there is ignored", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    const onConsole = new URL(`${CONSOLE}${url.pathname}${url.search}`);
    expect((await fetchUrl(w, onConsole)).status).toBe(401);
  });

  it("revocation: a licence revoked or suspended, expired, or detached before redemption gets 404", async () => {
    const cases: Array<[string, (w: World, p: Portal) => Promise<unknown>]> = [
      [
        // Revoked or suspended: the licence vocabulary's `disabled` (licenses.status).
        "revoked (disabled)",
        (w, p) =>
          w.db.run(
            "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
            SLUG,
            p.licenseId,
          ),
      ],
      [
        "expired",
        (w, p) =>
          w.db.run(
            "UPDATE licenses SET expires_at = ? WHERE product = ? AND id = ?",
            NOW - 1,
            SLUG,
            p.licenseId,
          ),
      ],
      [
        "detached",
        (w, p) =>
          w.db.run(
            "UPDATE licenses SET account_id = NULL WHERE product = ? AND id = ?",
            SLUG,
            p.licenseId,
          ),
      ],
    ];
    for (const [label, revoke] of cases) {
      const w = await world("licensed");
      const p = await account(w);
      const t = await token(w, p);
      await revoke(w, p);
      const res = await redeem(w, t);
      expect(res.status, label).toBe(404);
      expect(res.headers.get("location"), label).toBeNull();
    }
  });

  it("single use: the portal token redeems once; the ticket it gave stays reusable for 120 s", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const t = await token(w, p);
    const first = await redeem(w, t);
    expect(first.status).toBe(302);
    expect((await redeem(w, t)).status).toBe(404);
    const url = new URL(first.headers.get("location")!);
    expect((await fetchUrl(w, url)).status).toBe(200);
    expect((await fetchUrl(w, url)).status).toBe(200);
  });

  it("entitled: a release outside the licence's window is refused at mint", async () => {
    const w = await world("entitled");
    const p = await account(w, { maxVersion: "1.1.0" });
    const { artifact_id } = await artifactOf(w, "app@1.2.0", WIN);
    expect((await mint(w, p, "app@1.2.0", artifact_id)).status).toBe(403);
    // Inside the window it is served.
    const url = await ticketedUrl(
      w,
      p,
      "app@1.1.0",
      "Diceroll-1.1.0-windows-x86_64.zip",
    );
    expect((await fetchUrl(w, url)).status).toBe(200);
  });

  it("fails closed: with the key or the bytes host unset, files are not_hosted and nothing mints", async () => {
    for (const env of [
      { DOWNLOAD_TICKET_KEY: undefined },
      { BLOB_ORIGIN: undefined },
    ]) {
      const w = await world("licensed");
      Object.assign(w.env, env);
      const p = await account(w);
      const body = await listing(w, p);
      const reasons = new Set(
        body.platforms.flatMap((x) => x.files.map((f) => f.reason)),
      );
      expect([...reasons]).toEqual(["not_hosted"]);
      const { artifact_id } = await artifactOf(w, "app@1.2.0", WIN);
      // An owner is told why (the listing's reason code), and nothing is minted.
      const refused = await mint(w, p, "app@1.2.0", artifact_id);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: "not_hosted" });
    }
  });

  it("the key deleted after the mint: redemption refuses and leaves the token unspent", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const t = await token(w, p);
    w.env.DOWNLOAD_TICKET_KEY = undefined;
    expect((await redeem(w, t)).status).toBe(404);
    w.env.DOWNLOAD_TICKET_KEY = KEY;
    expect((await redeem(w, t)).status).toBe(302);
  });

  it("gated/: a gated location is never served, even with a valid ticket", async () => {
    const w = await world("licensed");
    const p = await account(w);
    const url = await ticketedUrl(w, p);
    const { sha256 } = await artifactOf(w, "app@1.2.0", WIN);
    // Point the file's only location at the gated key of the same content.
    const gated = blobKey(sha256, { gated: true });
    await w.env.BLOBS!.put(gated, bytesFor(WIN), { sha256 });
    await w.db.run(
      `UPDATE release_artifacts SET locations_json = ? WHERE product = ? AND release_id = ? AND name = ?`,
      JSON.stringify([{ provider: "r2", key: gated }]),
      SLUG,
      "app@1.2.0",
      WIN,
    );
    expect((await fetchUrl(w, url)).status).toBe(404);
  });

  it("Identity off: the product downloads normally", async () => {
    const w = await world("licensed");
    const row = await w.db.first<{ services_json: string | null }>(
      "SELECT services_json FROM products WHERE slug = ?",
      SLUG,
    );
    expect(
      parseServices(row?.services_json ?? null).services.identity.enabled,
    ).toBe(false);
    const p = await account(w);
    expect((await fetchUrl(w, await ticketedUrl(w, p))).status).toBe(200);
  });

  it("trust: an attested-enforced gatedDelivery policy follows the portal's licence-only rule (Q4 (a))", async () => {
    const w = await world("licensed");
    await w.db.run(
      "UPDATE products SET trust_policy_json = ?, trust_policy_source = 'admin' WHERE slug = ?",
      JSON.stringify({
        mint: "basic",
        gatedDelivery: "attested",
        commerceClaim: "basic",
        enforce: true,
        appAttest: null,
        playIntegrity: null,
      }),
      SLUG,
    );
    const p = await account(w);
    expect((await listing(w, p)).recommended).not.toBeNull();
    expect((await fetchUrl(w, await ticketedUrl(w, p))).status).toBe(200);
  });
});
