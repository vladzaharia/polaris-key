/**
 * Shared by the end-session suites (I-21.12): the portal API reads the wall clock, so a suite holds
 * `Date` at the injected time; and a response's `Set-Cookie` fields, one per entry.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { signIssuerJwt } from "../../../../src/services/identity/issuer/keys.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";

/** Hold `Date` at `NOW` for each test of the calling suite (timers stay real). */
export function holdWallClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export const setCookies = (res: Response): string[] =>
  (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

/**
 * An `id_token_hint` for `aud`, signed by the product's key an hour or so ago (so already expired,
 * which `end-session` accepts): `over` replaces any claim, `typ` the token type.
 */
export function idHint(
  w: World,
  aud: string,
  over: Record<string, unknown> = {},
  typ: "JWT" | "at+jwt" = "JWT",
): Promise<string> {
  const claims = {
    iat: NOW - 700,
    exp: NOW - 100,
    aud,
    sub: w.subject,
    iss: `${BASE}/${SLUG}/identity`,
    ...over,
  };
  return signIssuerJwt(w.env, w.db, SLUG, typ, claims, NOW);
}
