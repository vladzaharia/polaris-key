import { describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { seededWorld } from "./identityCardHarness.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
  SIGNIN_FLOW_COOKIE,
} from "../src/core/accountCookies.js";

// I-07 (S-16 §5.4 item 7): no product route receives or sets the account cookie. The browser
// sends the host-only cookie to every path on key.plrs.im; the dispatcher removes it before a
// product handler runs and drops any Set-Cookie for it on the way out. One product route stands
// in for all of them here: its handler records the request it was given and tries to plant the
// account cookie.

const seen: { cookie: string | null }[] = [];

vi.mock("../src/core/trust.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/core/trust.js")>();
  return {
    ...original,
    handleTrustManifest: vi.fn(async (req: Request) => {
      seen.push({ cookie: req.headers.get("cookie") });
      const headers = new Headers({ "content-type": "application/jose" });
      headers.append(
        "set-cookie",
        `${ACCOUNT_SESSION_COOKIE}=planted; Path=/; Secure`,
      );
      headers.append(
        "set-cookie",
        `${SIGNIN_FLOW_COOKIE}=planted; Path=/; Secure`,
      );
      headers.append("set-cookie", "product_pref=1; Path=/acme; Secure");
      return new Response("jws", { status: 200, headers });
    }),
  };
});

const { dispatchWith } = await import("../src/dispatch.js");

describe("product routes and the account realm", () => {
  it("a product route never receives the account cookies and cannot set them", async () => {
    const w = await seededWorld();
    const res = await dispatchWith(
      new Request("https://key.plrs.im/acme/.well-known/polaris-trust.jws", {
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE}=session; ${EMAIL_GATE_COOKIE}=gate; theme=dark`,
        },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ cookie: "theme=dark" }]);
    const cookies = (
      res.headers as Headers & { getSetCookie(): string[] }
    ).getSetCookie();
    expect(cookies).toEqual(["product_pref=1; Path=/acme; Secure"]);
  });

  it("a portal route still receives them", async () => {
    const w = await seededWorld();
    const res = await dispatchWith(
      new Request("https://key.plrs.im/api/me", {
        headers: { cookie: `${ACCOUNT_SESSION_COOKIE}=not-a-session` },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    // Reached the portal (which refused the bogus value), not a product.
    expect(res.status).toBe(401);
  });
});
