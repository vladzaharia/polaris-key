import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  axe,
  h1Count,
  startPortal,
  type PortalHarness,
} from "./portalHarness.js";

/**
 * Link an existing account through the Worker's real `/signin` 302 (PX-15): start, the second
 * sign-in (the login card while still signed in), back on the join screen with both accounts, Join.
 * The Worker's `/signin` is the real handler (`portalHarness.ts`); the session and the link flow
 * are fixtures that follow who is signed in.
 */

let harness: PortalHarness;
beforeAll(async () => {
  harness = await startPortal();
});
afterAll(async () => {
  await harness.stop();
});

const NOW = 1_800_000_000;
const MARA = {
  id: "acct_a",
  name: "Mara Fennick",
  email: "mara@fennick.studio",
  avatarUrl: null,
};
const OLD = {
  id: "acct_b",
  name: "Mara F.",
  email: "mara@old.example",
  avatarUrl: null,
};
const card = (role: "started" | "other", a: typeof MARA, current: boolean) => ({
  role,
  current,
  name: a.name,
  email: a.email,
  avatarUrl: null,
  methods: ["email"],
  products: role === "started" ? 1 : 2,
  proven: { by: "email", at: NOW, fresh: true },
});

describe("Link an existing account, end to end", () => {
  it("start, the real /signin 302, the second sign-in card, both accounts, Join", async () => {
    let who: "started" | "other" = "started";
    let confirmed = false;
    const o = await harness.open("three", "/#/account?link=1", {
      routes: {
        "/api/me": () => ({
          body: {
            account: who === "started" ? MARA : OLD,
            csrf: who === "started" ? "csrf-one" : "csrf-two",
          },
        }),
        "/api/me/link": () => ({
          body:
            who === "started"
              ? { flow: null, undoable: [] }
              : {
                  flow: {
                    expiresAt: NOW + 900,
                    started: card("started", MARA, false),
                    other: card("other", OLD, true),
                    canJoin: true,
                    reason: null,
                    keep: "other",
                    result: { products: 3, primaryEmail: OLD.email },
                  },
                  undoable: [],
                },
        }),
        "POST /api/me/link/start": {
          body: {
            status: "started",
            expiresAt: NOW + 900,
            next: "/signin?return_to=%2F%23%2Faccount%2Flink",
          },
        },
        "POST /api/me/link/confirm": () => {
          confirmed = true;
          return {
            body: {
              status: "joined",
              kept: "other",
              merge: { id: "m1", undoUntil: NOW + 72 * 3600 },
            },
          };
        },
      },
    });
    try {
      const { page } = o;
      await page
        .getByRole("button", { name: "Sign in to the other account" })
        .click();
      // The Worker's 302 lands back on the link route while the session is still the first one:
      // the login card shows in "other account" mode, not the dialog again.
      await page.getByText("Sign in to your other account").waitFor();
      // The browser really went to /signin and the Worker's handler sent it back.
      await expect
        .poll(() =>
          o.requests.some((r) => r.startsWith("GET /signin?return_to=")),
        )
        .toBe(true);
      await page.getByText("Sign in to your other account").waitFor();
      expect(await h1Count(page)).toBe(1);
      expect(await axe(page)).toEqual([]);
      // The sign-in happened: the session is the other account's now.
      who = "other";
      await page.reload();
      const dialog = page.getByRole("dialog", {
        name: "Link an existing account",
      });
      await dialog.getByText("Signed in now").waitFor();
      await dialog.getByText("Your other account").waitFor();
      expect(confirmed).toBe(false);
      await dialog
        .getByRole("button", { name: "Join into one account" })
        .click();
      await dialog.getByText(/Joined\. You can undo until/).waitFor();
      expect(confirmed).toBe(true);
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });
});
