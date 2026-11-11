// Linking a repository applies a whole manifest (identity clients and the issuer setting
// included) from a repository the operator names, so the apply needs the same recent
// re-authentication as creating a client. The dry run writes nothing and needs none.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { consoleTestSession } from "../consoleSessionHelper.js";
import { handleAdmin } from "../../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../../src/core/console/session.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import type { Env } from "../../src/platform/env.js";

const SLUG = "acme";
const LINK = `/api/products/${SLUG}/release/link`;
const CREATE = "/api/products/link-repo";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  await seedProduct(db, SLUG);
  // No call may reach GitHub: a request that passes the gate meets a refusal here.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function link(opts: {
  stepUp: boolean;
  query?: string;
  body?: unknown;
  path?: string;
}) {
  const { token, session } = await consoleTestSession(
    env,
    db,
    {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: ["admins"],
      stepUp: opts.stepUp,
      authTime: NOW,
    },
    NOW,
  );
  return handleAdmin(
    new Request(
      `https://key.plrs.im/manage${opts.path ?? LINK}${opts.query ?? ""}`,
      {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          opts.body ?? { repoUrl: "acme-org/acme-app", manifestDigest: "d" },
        ),
      },
    ) as never,
    env,
    db,
    opts.path ?? LINK,
    { now: NOW + 60 },
  );
}

const rowCount = async () =>
  (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit"))!.n +
  (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM product_settings"))!
    .n;

describe("Link repository and the step-up", () => {
  it("without a recent step-up the apply is refused and nothing is written or fetched", async () => {
    const before = await rowCount();
    const res = await link({ stepUp: false });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "step_up_required",
    );
    expect(await rowCount()).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with a step-up the apply passes the gate", async () => {
    const res = await link({ stepUp: true });
    expect(await res.clone().text()).not.toContain("step_up");
    expect(res.status).not.toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("step_up_required");
  });

  it("the dry run needs none", async () => {
    const res = await link({ stepUp: false, query: "?dryRun=1" });
    expect(JSON.stringify(await res.json())).not.toContain("step_up_required");
  });

  it("creating a product from a repository needs it too, and the dry run does not", async () => {
    const products = () =>
      db.first<{ n: number }>("SELECT COUNT(*) AS n FROM products");
    const before = await products();
    const res = await link({ stepUp: false, path: CREATE });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "step_up_required",
    );
    expect(await products()).toEqual(before);
    const dry = await link({ stepUp: false, path: CREATE, query: "?dryRun=1" });
    expect(JSON.stringify(await dry.json())).not.toContain("step_up_required");
    const ok = await link({ stepUp: true, path: CREATE });
    expect(JSON.stringify(await ok.json())).not.toContain("step_up_required");
  });
});
