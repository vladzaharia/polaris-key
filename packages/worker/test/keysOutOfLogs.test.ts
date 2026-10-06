/**
 * License keys stay out of URLs and logs (fix/keys-out-of-logs, THREAT-MODEL.md "Key-bearing deep
 * links").
 *
 * The Activate license deep link carried the key as `/activate?key=<license key>`, so the key was
 * in every request log that records a URL: Workers Logs' invocation logs, edge and proxy logs. It
 * now rides in the fragment, `/activate#key=…`, which no request carries; the portal reads it and
 * drops it (packages/admin `rewriteActivatePath`). Links already sent keep working: a legacy
 * `GET /activate?key=…` is answered with the same SPA shell, and this suite pins what the Worker
 * does with it:
 *
 * - it is not a redirect (that would echo the key in a `Location` header and cannot unlog the
 *   request that brought it);
 * - the key reaches no subrequest (the shell is fetched from `ASSETS` without the query);
 * - the key is in no response byte or header, the shell is `no-store`, and the page's
 *   `Referrer-Policy` is `no-referrer`;
 * - nothing on the way writes to the console (the static guard that `src/` has no `console.*` is
 *   R12's; this proves it on the request paths that hold a key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import { secureResponse } from "../src/securityHeaders.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Env } from "../src/env.js";

const BASE = "https://key.plrs.im";
const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const SHELL = `<!doctype html><html><body><div id="root"></div></body></html>`;

/** An `ASSETS` binding that records every URL it is asked for. */
function recordingAssets(seen: string[]): Fetcher {
  return {
    async fetch(input: Request | string) {
      seen.push(typeof input === "string" ? input : input.url);
      return new Response(SHELL, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  } as unknown as Fetcher;
}

function headerValues(res: Response): string {
  const all: string[] = [];
  res.headers.forEach((value, name) => all.push(`${name}: ${value}`));
  return all.join("\n");
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = CONSOLE_METHODS.map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function expectNothingLogged(): void {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
}

async function get(env: Env, path: string): Promise<Response> {
  return secureResponse(
    await dispatchWith(
      new Request(`${BASE}${path}`) as unknown as Request,
      env,
      makeTestDb(),
      NOW,
    ),
  );
}

describe("a legacy /activate?key=… link", () => {
  for (const path of [
    `/activate?key=${KEY}`,
    `/activate/?key=${KEY}&product=mossgarden`,
  ]) {
    it(`serves the portal shell for ${path.split("?")[0]} without passing the key on`, async () => {
      const env = makeEnv(new KvMock(), []);
      const seen: string[] = [];
      env.ASSETS = recordingAssets(seen);
      const res = await get(env, path);

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(headerValues(res)).not.toContain("pkey_");
      const body = await res.text();
      expect(body).toBe(SHELL);
      expect(body).not.toContain(KEY);

      // The shell is fetched without the query: the key reaches no subrequest.
      expect(seen).toEqual([`${BASE}/index.html`]);
      expectNothingLogged();
    });
  }

  it("is answered the same way by the built-in shell when there is no ASSETS binding", async () => {
    const env = makeEnv(new KvMock(), []);
    const res = await get(env, `/activate?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(headerValues(res)).not.toContain("pkey_");
    expect(await res.text()).not.toContain("pkey_");
    expectNothingLogged();
  });

  it("keeps the query on a real asset (the shell is the only answer that drops it)", async () => {
    const env = makeEnv(new KvMock(), []);
    const seen: string[] = [];
    env.ASSETS = recordingAssets(seen);
    await get(env, "/assets/portal.js?v=3");
    expect(seen).toEqual([`${BASE}/assets/portal.js?v=3`]);
  });
});

describe("a license key presented to the Worker", () => {
  it("is never written to the console, accepted or refused", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: false },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const { key } = await seedLicenseWithKey(db, "djdl");
    const unknown = "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA";
    for (const k of [key, unknown]) {
      const res = await dispatchWith(
        new Request(`${BASE}/djdl/license/activate`, {
          method: "POST",
          headers: { authorization: `Bearer ${k}`, "x-pkey-device": "dev-1" },
        }) as unknown as Request,
        env,
        db,
        NOW,
      );
      expect([200, 401]).toContain(res.status);
      expect(headerValues(res)).not.toContain(k);
    }
    expectNothingLogged();
  });
});
