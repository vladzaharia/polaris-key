/// <reference types="@cloudflare/workers-types" />
// ── Account pictures on miniflare's R2 and D1 (PX-W16) ───────────────────────────────────────
//
// The Node lane (`test/identityCardProfile.test.ts`, `test/portalProfile.test.ts`) covers the
// rules against `test/r2Mock.ts` and better-sqlite3. This file runs the store, the media route,
// the sweep and the deletion against the real bindings, which is what proves the parts the fakes
// could get wrong: that D1 accepts the migration and the owner-scoped "still in use?" reads
// (`json_extract` over the owner's links, through `idx_account_links_account`), that R2 keeps each rendition's `httpMetadata.contentType`, that a multi-key delete removes all
// four renditions, and that the route streams the stored bytes back byte for byte. The Images
// binding is a stub here (the lane has no Images service): it answers fixed WebP and PNG bytes.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AVATAR_GC_GRACE_SECONDS,
  deleteAccountAvatars,
  renditionKey,
  serveAvatar,
  storeAvatar,
  sweepAvatars,
} from "../src/services/identity/card/avatars.js";
import { D1Db } from "../src/db/d1.js";
import type { Env as WorkerEnv } from "../src/platform/env.js";
import { NOW } from "./seed.js";

const LANE = { timeout: 60_000 };
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function rendition(format: string, size: number): Uint8Array {
  const tag = new TextEncoder().encode(`workerd-${size}`);
  return format === "image/png"
    ? new Uint8Array([...PNG_SIG, ...tag])
    : new Uint8Array([
        ...new TextEncoder().encode("RIFF"),
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode("WEBPVP8 "),
        ...tag,
      ]);
}

/** The Images binding's shape, answering fixed renditions. */
const images = {
  input(stream: ReadableStream<Uint8Array>) {
    void new Response(stream).arrayBuffer();
    let width = 0;
    const handle = {
      transform(t: { width?: number }) {
        width = t.width ?? 0;
        return handle;
      },
      async output(o: { format: string }) {
        const out = rendition(o.format, width);
        return {
          response: () => new Response(out),
          contentType: () => o.format,
          image: () => new Response(out).body!,
        };
      },
    };
    return handle;
  },
} as unknown as ImagesBinding;

function lane(): { env: WorkerEnv; db: D1Db } {
  if (!env.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  return {
    env: {
      ...(env as unknown as WorkerEnv),
      IMAGES: images,
      KEY_HASH_PEPPER: "workerd-pepper",
    },
    db: new D1Db(env.DB),
  };
}

async function seedAccount(db: D1Db, id: string): Promise<void> {
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
    id,
    NOW,
    NOW,
  );
}

describe("account pictures on R2 and D1", LANE, () => {
  it("stores four renditions with their types and serves them back byte for byte", async () => {
    const { env: e, db } = lane();
    await seedAccount(db, "acct_wd_serve");
    const stored = await storeAvatar(
      e,
      db,
      {
        accountId: "acct_wd_serve",
        bytes: new Uint8Array([...PNG_SIG, 1, 2, 3]),
        origin: "upload",
      },
      NOW,
    );
    expect(stored.ok).toBe(true);
    const asset = (stored as { asset: string }).asset;
    for (const [size, format, type] of [
      [256, "webp", "image/webp"],
      [256, "png", "image/png"],
      [96, "webp", "image/webp"],
      [96, "png", "image/png"],
    ] as const) {
      const head = await env.BLOBS!.head(renditionKey(asset, size, format));
      expect(head?.httpMetadata?.contentType, `${size}.${format}`).toBe(type);
    }
    const res = await serveAvatar(
      new Request(`https://key.plrs.im/media/avatar/${asset}`, {
        headers: { accept: "image/avif,image/webp,*/*" },
      }),
      e,
      asset,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      rendition("image/webp", 256),
    );
  });

  it("the sweep's owner-scoped reads keep what a link uses and delete what nothing uses", async () => {
    const { env: e, db } = lane();
    await seedAccount(db, "acct_wd_sweep");
    const used = await storeAvatar(
      e,
      db,
      {
        accountId: "acct_wd_sweep",
        bytes: new Uint8Array([...PNG_SIG, 4]),
        origin: "provider",
      },
      NOW,
    );
    const unused = await storeAvatar(
      e,
      db,
      {
        accountId: "acct_wd_sweep",
        bytes: new Uint8Array([...PNG_SIG, 5]),
        origin: "upload",
      },
      NOW,
    );
    const usedAsset = (used as { asset: string }).asset;
    const unusedAsset = (unused as { asset: string }).asset;
    // In use through a link's profile (the owner's links, by `idx_account_links_account`).
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, subject, kind, created_at,
         last_used_at, profile_json)
       VALUES ('lnk_wd_sweep', 'acct_wd_sweep', 'steam', '7656', 'steam', ?, ?, ?)`,
      NOW,
      NOW,
      JSON.stringify({ avatarKey: usedAsset }),
    );
    expect(
      await sweepAvatars(e, db, NOW + AVATAR_GC_GRACE_SECONDS + 1),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await env.BLOBS!.head(renditionKey(unusedAsset, 256, "png")),
    ).toBeNull();
    expect(
      await env.BLOBS!.head(renditionKey(usedAsset, 256, "png")),
    ).not.toBeNull();
    expect(
      await db.first(
        "SELECT 1 FROM account_avatars WHERE asset = ?",
        unusedAsset,
      ),
    ).toBeNull();
  });

  it("account deletion removes every rendition and row", async () => {
    const { env: e, db } = lane();
    await seedAccount(db, "acct_wd_delete");
    const stored = await storeAvatar(
      e,
      db,
      {
        accountId: "acct_wd_delete",
        bytes: new Uint8Array([...PNG_SIG, 6]),
        origin: "upload",
      },
      NOW,
    );
    const asset = (stored as { asset: string }).asset;
    await db.run(
      "UPDATE accounts SET avatar_key = ? WHERE id = 'acct_wd_delete'",
      asset,
    );
    expect(await deleteAccountAvatars(e, db, "acct_wd_delete")).toBe(1);
    const left = await env.BLOBS!.list({ prefix: `avatars/${asset}/` });
    expect(left.objects).toEqual([]);
    expect(
      await db.first(
        "SELECT 1 FROM account_avatars WHERE account_id = 'acct_wd_delete'",
      ),
    ).toBeNull();
  });
});
