// LK-09 (plans/LK-00.md D7): the Help links on Locker pages resolve on the customer host. The
// account menu's and sign-in card's Help and Privacy links (helpLinks.ts) and
// `docsLinks.downloadPage` are read from their source tables, then fetched on polaris.locker
// against the built docs site (skipped without one).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../../src/dispatch.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv } from "../seed.js";
import { TEST_ROOT } from "../paths.js";

const root = join(TEST_ROOT, "..", "..");
const dist = join(root, "docs", "dist");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// The account menu and the sign-in card read these from `portal/helpLinks.ts` (DOC-06a): the
// Help door, the privacy page and the code step's page, the ones a signed-out visitor can reach.
const table = read("admin/src/portal/helpLinks.ts");
const links = [
  ...table.matchAll(
    /(?:help|privacy|codeDidntArrive): "(\/docs\/help\/[^"#]*)"/g,
  ),
  ...read("admin/src/lib/docsLinks.ts").matchAll(
    /downloadPage: "(\/docs\/help\/[^"]*)"/g,
  ),
].map((m) => m[1]!);

describe("Help links on Locker pages", () => {
  it("name the account menu's Help and Privacy, the code page and the download page", () => {
    expect(links).toEqual(
      expect.arrayContaining([
        "/docs/help/",
        "/docs/help/your-data/",
        "/docs/help/code-didnt-arrive/",
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

// DOC-06b.1: the Worker's own table (`core/helpLinks.ts`) and the anchor each Locker notice
// names (`help: "<id>"` in `core/notify/templates.ts`) are real Help pages and headings.
describe("Help links in Locker mail", () => {
  const workerPaths = [
    ...read("worker/src/core/helpLinks.ts").matchAll(
      /"(\/docs\/help\/[^"]*)"/g,
    ),
  ].map((m) => m[1]!);
  const anchors = [
    ...read("worker/src/core/notify/templates.ts").matchAll(
      /\bhelp: "([a-z0-9-]+)"/g,
    ),
  ].map((m) => m[1]!);
  const emailsSource = read("docs/src/content/docs/help/emails.md");
  const slugManifest = join(dist, "docs-slugs.json");

  it("declares the table and an anchor per notice", () => {
    expect(workerPaths).toEqual(
      expect.arrayContaining([
        "/docs/help/what-is-polaris-locker/",
        "/docs/help/emails/",
        "/docs/help/secure-your-account/",
        "/docs/help/check-a-download/",
        "/docs/help/approve-a-sign-in/",
      ]),
    );
    expect(anchors.length).toBeGreaterThan(20);
  });

  it("every notice anchor is an entry on the Emails page", () => {
    const missing = anchors.filter(
      (a) => !emailsSource.includes(`<a id="${a}"></a>`),
    );
    expect(missing, `no such entry: ${missing.join(", ")}`).toEqual([]);
  });

  it.skipIf(!existsSync(slugManifest))(
    "every path and anchor exists in the built docs site",
    () => {
      const manifest = JSON.parse(readFileSync(slugManifest, "utf8")) as {
        routes: string[];
      };
      const routes = new Set(manifest.routes);
      expect(workerPaths.filter((p) => !routes.has(p))).toEqual([]);
      // The entries carry hand-set `<a id>` anchors, not heading slugs: read the built page.
      const page = readFileSync(
        join(dist, "help", "emails", "index.html"),
        "utf8",
      );
      expect(anchors.filter((a) => !page.includes(`id="${a}"`))).toEqual([]);
    },
  );
});
