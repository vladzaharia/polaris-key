/** LK-FU-2: an operator's console preferences are stored per operator and follow them. */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { handleMyPrefs } from "../../src/console/handlers/me.js";
import {
  readOperatorPrefs,
  setSetupGuideHidden,
} from "../../src/core/accounts/operatorPrefs.js";
import type { AdminSession } from "../../src/core/console/session.js";

const session = (sub: string) => ({ sub }) as AdminSession;
const put = (body: unknown) =>
  new Request("https://x.test/manage/api/me/prefs", {
    method: "PUT",
    body: JSON.stringify(body),
  });

describe("operator prefs", () => {
  it("defaults to shown, then stores per operator", async () => {
    const db = makeTestDb();
    expect(await readOperatorPrefs(db, "a")).toEqual({
      setupGuideHidden: false,
    });
    await setSetupGuideHidden(db, "a", true, 10);
    expect((await readOperatorPrefs(db, "a")).setupGuideHidden).toBe(true);
    expect((await readOperatorPrefs(db, "b")).setupGuideHidden).toBe(false);
    await setSetupGuideHidden(db, "a", false, 11);
    expect((await readOperatorPrefs(db, "a")).setupGuideHidden).toBe(false);
  });

  it("PUT answers the stored prefs and refuses a non-boolean", async () => {
    const db = makeTestDb();
    const ok = await handleMyPrefs(
      db,
      session("a"),
      put({ setupGuideHidden: true }),
      5,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ prefs: { setupGuideHidden: true } });
    const bad = await handleMyPrefs(
      db,
      session("a"),
      put({ setupGuideHidden: "yes" }),
      6,
    );
    expect(bad.status).toBe(422);
    expect((await readOperatorPrefs(db, "a")).setupGuideHidden).toBe(true);
  });
});
