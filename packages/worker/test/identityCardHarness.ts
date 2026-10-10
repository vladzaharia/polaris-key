/**
 * I-07: a small browser for the login card's tests. It keeps a cookie jar per "device", sends
 * every request through the portal router the composition root uses (`handlePortal`), and
 * captures the sign-in mail the card sends.
 */
import { vi } from "vitest";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import { portalHooksFor } from "./portalHarness.js";
import { PORTAL_CSRF_HEADER } from "../src/services/identity/portal/session.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface CardWorld {
  db: Db;
  env: Env;
  r2: R2Mock;
  mail: Mail[];
}

export function cardWorld(): CardWorld {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["acme"]);
  env.PORTAL_SESSION_SECRET = "card-session-secret";
  env.KEY_HASH_PEPPER = "card-pepper";
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  const mail: Mail[] = [];
  env.EMAIL = {
    send: async (m: Mail) => {
      mail.push({ to: m.to, subject: m.subject, text: m.text });
    },
  } as unknown as Env["EMAIL"];
  return { db, env, r2, mail };
}

export async function seededWorld(): Promise<CardWorld> {
  const w = cardWorld();
  // The platform capabilities read the products table: one product with the defaults on.
  await seedProduct(w.db, "acme");
  return w;
}

/** The 6-digit code in the last mail to `to`. */
export function lastCode(w: CardWorld, to: string): string {
  const m = [...w.mail].reverse().find((x) => x.to === to);
  const match = m ? /(\d{3}) (\d{3})/.exec(m.text) : null;
  if (!match) throw new Error(`no code mailed to ${to}`);
  return `${match[1]}${match[2]}`;
}

/** The magic link in the last mail to `to`. */
export function lastLink(w: CardWorld, to: string): string {
  const m = [...w.mail].reverse().find((x) => x.to === to);
  const link = m ? /https:\/\/\S+/.exec(m.text)?.[0] : undefined;
  if (!link) throw new Error(`no link mailed to ${to}`);
  return link;
}

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  return typeof h.getSetCookie === "function"
    ? h.getSetCookie()
    : res.headers.get("set-cookie")
      ? [res.headers.get("set-cookie")!]
      : [];
}

/** One browser: its own cookie jar, its own client address. */
export class Device {
  readonly jar = new Map<string, string>();
  csrf: string | null = null;

  constructor(
    private readonly w: CardWorld,
    readonly ip = "203.0.113.10",
  ) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res: Response): Response {
    for (const c of setCookies(res)) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1);
      const maxAge = attrs.find((a) =>
        a.trim().toLowerCase().startsWith("max-age="),
      );
      if (value === "" || maxAge?.trim().toLowerCase() === "max-age=0")
        this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    opts: { form?: boolean; headers?: Record<string, string> } = {},
  ): Request {
    const headers: Record<string, string> = {
      "cf-connecting-ip": this.ip,
      ...(opts.headers ?? {}),
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.csrf && method !== "GET") headers[PORTAL_CSRF_HEADER] = this.csrf;
    let payload: string | undefined;
    if (body !== undefined) {
      if (opts.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        payload = new URLSearchParams(
          body as Record<string, string>,
        ).toString();
      } else {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    return new Request(`https://key.plrs.im${path}`, {
      method,
      headers,
      body: payload,
    }) as unknown as Request;
  }

  async send(
    method: string,
    path: string,
    body?: unknown,
    opts: {
      form?: boolean;
      now?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const req = this.request(method, path, body, opts);
    const res = await handlePortal(
      req,
      this.w.env,
      this.w.db,
      new URL(req.url).pathname,
      {
        now: opts.now ?? NOW,
        hooksFor: portalHooksFor(this.w.env, this.w.db),
      },
    );
    return this.absorb(res);
  }

  /** Read `/api/me` and keep the CSRF token. */
  async me(now = NOW): Promise<Response> {
    const res = await this.send("GET", "/api/me", undefined, { now });
    if (res.status === 200) {
      const body = (await res.clone().json()) as { csrf: string };
      this.csrf = body.csrf;
    }
    return res;
  }

  /** The whole email-code sign-in for `email`. */
  async signInWithCode(email: string, now = NOW): Promise<Response> {
    const start = await this.send(
      "POST",
      "/api/signin/email/start",
      { email },
      { now },
    );
    if (start.status !== 200) return start;
    return this.send(
      "POST",
      "/api/signin/email/verify",
      { code: lastCode(this.w, email) },
      { now },
    );
  }
}

/** A provider picture: a tiny valid PNG. */
export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52,
]);

/** Stub `fetch` for provider pictures; answers PNG bytes for the allowlisted hosts. */
export function stubPictureFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }),
  );
  return { calls };
}
