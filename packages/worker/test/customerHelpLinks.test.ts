// LK-09 (plans/LK-00.md D7): the Help links on Locker pages resolve on the customer host. The
// account menu's Help and Privacy links (PX-35 moved them out of the footer) and
// `docsLinks.downloadPage` are read from their source tables, then fetched on polaris.locker
// against the built docs site (skipped without one).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../src/dispatch.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "docs", "dist");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const menu = read("admin/src/portal/components/AccountMenu.tsx");
const links = [
  ...menu.matchAll(/href: "(\/docs\/help\/[^"]*)"/g),
  ...read("admin/src/lib/docsLinks.ts").matchAll(
    /downloadPage: "(\/docs\/help\/[^"]*)"/g,
  ),
].map((m) => m[1]!);

describe("Help links on Locker pages", () => {
  it("name the account menu's Help and Privacy and the download page", () => {
    expect(links).toEqual(
      expect.arrayContaining([
        "/docs/help/",
        "/docs/help/your-data/",
        "/docs/help/download/",
      ]),
    );
  });

  it.skipIf(!existsSync(dist))(
    "resolve on polaris.locker without a session",
    async () => {
      const env = makeEnv(new KvMock(), []);
      env.CONSOLE_ORIGIN = "https://key.plrs.im";
      env.CUSTOMER_ORIGIN = "https://polaris.locker";
      env.ASSETS = {
        fetch: async (input: RequestInfo | URL) => {
          const u = new URL(
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input.url,
          );
          const file = join(dist, u.pathname.replace(/^\/docs\//, ""));
          return existsSync(file)
            ? new Response(readFileSync(file))
            : new Response("no", { status: 404 });
        },
      } as unknown as Fetcher;
      for (const link of [...links, "/help"]) {
        const res = await dispatchWith(
          new Request(`https://polaris.locker${link}`),
          env,
          makeTestDb(),
          1_800_000_000,
        );
        // `/help` is the one redirect, and it stays on the host.
        if (link === "/help") {
          expect(res.headers.get("location"), link).toBe("/docs/help/");
        } else {
          expect(res.status, link).toBe(200);
        }
      }
    },
  );
});
