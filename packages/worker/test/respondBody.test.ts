import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { AdminBodyError, readBody } from "../src/core/http/body.js";
import { readBody as consoleReadBody } from "../src/core/console/respond.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi } from "./portalHarness.js";

const post = (body: BodyInit | null, type?: string): Request =>
  new Request("https://key.plrs.im/x", {
    method: "POST",
    body,
    headers: type ? { "content-type": type } : {},
  });

async function refusal(p: Promise<unknown>): Promise<AdminBodyError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AdminBodyError) return e;
    throw e;
  }
  throw new Error("expected an AdminBodyError");
}

describe("the one JSON body reader", () => {
  it("is the same function for the console and the portal", () => {
    expect(consoleReadBody).toBe(readBody);
  });

  it("reads an object and treats an empty body as {}", async () => {
    expect(await readBody(post('{"a":1}', "application/json"))).toEqual({
      a: 1,
    });
    expect(await readBody(post(""))).toEqual({});
  });

  it("answers 413 for an oversize body, declared or streamed", async () => {
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    const e = await refusal(readBody(post(big, "application/json")));
    expect([e.status, e.code]).toEqual([413, "body_too_large"]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = new Request("https://key.plrs.im/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await refusal(readBody(chunked))).status).toBe(413);
  });

  it("answers 400 for malformed JSON and for a non-object", async () => {
    for (const raw of ["{not json", "[1]", "null", "7"]) {
      const e = await refusal(readBody(post(raw, "application/json")));
      expect([e.status, e.code]).toEqual([400, "invalid_json"]);
    }
  });

  it("does not trust the content type: a wrong type is parsed by its bytes", async () => {
    expect(await readBody(post('{"a":2}', "text/plain"))).toEqual({ a: 2 });
    expect((await refusal(readBody(post("a=1", "text/plain")))).status).toBe(
      400,
    );
  });
});

describe("portal bodies", () => {
  async function session() {
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    const db = await makeTestDb();
    await seedProduct(db, "djdl");
    const account = await getOrCreateAccountByEmail(db, "a@example.com", NOW);
    const { token, session: row } = await issuePortalSessionRow(
      env,
      db,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    const send = (body: string): Promise<Response> => {
      const path = "/api/device-login/lookup";
      const req = new Request(`https://key.plrs.im${path}`, {
        method: "POST",
        body,
        headers: {
          cookie: `${PORTAL_COOKIE}=${token}`,
          [PORTAL_CSRF_HEADER]: row.csrf,
          "content-type": "application/json",
        },
      });
      return handlePortalApi(req, env, db, path, NOW);
    };
    return { send };
  }

  it("answers 413 and 400, never {}", async () => {
    const { send } = await session();
    const big = await send(JSON.stringify({ code: "x".repeat(70 * 1024) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "body_too_large" });
    for (const raw of ["{nope", "[]"]) {
      const res = await send(raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_json" });
    }
  });

  it("keeps an empty body a normal request", async () => {
    const { send } = await session();
    const res = await send("");
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(500);
  });
});

describe("no local respond or body helpers", () => {
  const src = join(__dirname, "..", "src");
  const roots = ["console", "services/identity/portal"].map((d) =>
    join(src, d),
  );
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  roots.forEach(walk);

  it("defines readBody nowhere but core/http/body.ts, and never parses a bare req.json()", () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const name = relative(src, f);
      if (
        /\bfunction\s+(readBody|readJson|readJsonBody|parseBody)\b/.test(text)
      )
        bad.push(`${name}: local body helper`);
      if (/\b(req|request)\.json\(\)/.test(text))
        bad.push(`${name}: bare json()`);
    }
    expect(bad).toEqual([]);
  });
});
