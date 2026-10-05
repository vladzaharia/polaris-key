/// <reference types="@cloudflare/workers-types" />
// ── Download tickets on workerd (PX-W3, plans/PX-W3.md §9) ───────────────────────────────────
//
// The ticket is minted and verified with WebCrypto (SHA-256 for the kid, HMAC-SHA256 sign and
// `crypto.subtle.verify` for the MAC) and `btoa`/`atob` for base64url. This proves the module
// runs on the real runtime with the production compatibility flags, against the lane's own
// bytes host (`BLOB_ORIGIN` in vitest.workers.config.ts).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  mintDownloadTicket,
  verifyDownloadTicket,
} from "../src/core/downloadTicket.js";

const FILE = {
  product: "djdl",
  releaseId: "app@1.2.0",
  name: "djdl-1.2.0-macos.dmg",
  sha256: "a".repeat(64),
};

describe("download tickets on workerd", () => {
  it("mints and verifies, bound to the file and the window", async () => {
    const now = 1_800_000_000;
    const e = { ...env, DOWNLOAD_TICKET_KEY: "d29ya2VyZC10aWNrZXQta2V5" };
    const t = await mintDownloadTicket(e, FILE, now);
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]{8}\.1800000120\.[A-Za-z0-9_-]{43}$/);
    const at = { ...FILE, host: "dl.workerd.test" };
    expect(await verifyDownloadTicket(e, t!, at, now)).toBe(true);
    expect(await verifyDownloadTicket(e, t!, at, now + 120)).toBe(false);
    expect(
      await verifyDownloadTicket(e, t!, { ...at, name: "other.dmg" }, now),
    ).toBe(false);
    // Rotation: the same ticket under the previous slot still verifies by its kid.
    const rotated = {
      ...env,
      DOWNLOAD_TICKET_KEY: "bmV3LWtleQ",
      DOWNLOAD_TICKET_KEY_PREVIOUS: e.DOWNLOAD_TICKET_KEY,
    };
    expect(await verifyDownloadTicket(rotated, t!, at, now)).toBe(true);
    // No key: nothing minted.
    expect(await mintDownloadTicket({ ...env }, FILE, now)).toBeNull();
  });
});
