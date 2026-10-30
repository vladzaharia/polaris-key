/**
 * DISPLAY-NAME-INVISIBLE D-10: a console rename (`PATCH /api/products/<slug>`) runs the display-name
 * rule the manifest and the listing claims run. Text with a control, invisible or bidi code point
 * is refused in every mode; a reserved name only when `identity.reservedDisplayNames` is `error`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { getProduct } from "../../../src/core/products/store.js";
import { productNameRefusal } from "../../../src/core/accounts/reservedDisplayNames.js";
import { handleAdmin } from "../../../src/console/index.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { KvMock } from "../../kvMock.js";
import { NOW, seedProduct } from "../../seed.js";
import { makeTestDb } from "../../helpers.js";
import { CONSOLE, envFor } from "../../releaseRoutesFixture.js";

let db: Db;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  await seedProduct(db, "acme");
  await db.run("UPDATE products SET name = ? WHERE slug = ?", "Acme", "acme");
});

async function rename(body: Record<string, unknown>): Promise<Response> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: ["platform-admins"],
    },
    NOW,
  );
  const full = "/api/products/acme";
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method: "PATCH",
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

const nameOf = async (): Promise<string | undefined> =>
  (await getProduct(db, "acme"))?.name;

describe("PATCH /api/products/<slug> name", () => {
  it.each(["warn", "error"])(
    "refuses an invisible or bidi character with a 422 in %s mode",
    async (mode) => {
      env.IDENTITY_RESERVED_DISPLAY_NAMES = mode;
      for (const name of [
        "Acme\u202E",
        "Acme\u3164",
        "\u2800",
        "Ac\u00ADme",
        "\uFE0FAcme",
        "\u{1F469}\u200D\u{1F4BB} Dev",
      ]) {
        const res = await rename({ name });
        expect(res.status, name).toBe(422);
        expect(await res.json(), name).toMatchObject({
          reason: "invalid_display_text",
          fields: ["name"],
        });
      }
      expect(await nameOf()).toBe("Acme");
    },
  );

  it("refuses a reserved name only when the platform enforces it", async () => {
    env.IDENTITY_RESERVED_DISPLAY_NAMES = "error";
    const refused = await rename({ name: "Steam" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      reason: "reserved_display_name",
      fields: ["name"],
    });
    const tagged = await rename({ name: "Ste\u{E0061}am" });
    expect(tagged.status).toBe(422);
    expect(await nameOf()).toBe("Acme");

    // The screens show the slug for such a name in both modes, so `warn` accepts it.
    env.IDENTITY_RESERVED_DISPLAY_NAMES = "warn";
    expect((await rename({ name: "Steam" })).status).toBe(200);
    expect(await nameOf()).toBe("Steam");
  });

  it("accepts an ordinary name and an emoji sequence", async () => {
    env.IDENTITY_RESERVED_DISPLAY_NAMES = "error";
    expect((await rename({ name: "Acme Arcade" })).status).toBe(200);
    expect(await nameOf()).toBe("Acme Arcade");
    expect((await rename({ name: "\u{1F3AE}\uFE0F Arcade" })).status).toBe(200);
    expect(await nameOf()).toBe("\u{1F3AE}\uFE0F Arcade");
  });

  it("does not judge an unchanged name, so other fields still save", async () => {
    await db.run(
      "UPDATE products SET name = ? WHERE slug = ?",
      "Acme\u3164",
      "acme",
    );
    const res = await rename({ name: "Acme\u3164", defaultDeviceLimit: 4 });
    expect(res.status).toBe(200);
    expect(await nameOf()).toBe("Acme\u3164");
  });
});

describe("productNameRefusal", () => {
  it("exempts the system product from the reserved check, never from the text check", async () => {
    env.IDENTITY_RESERVED_DISPLAY_NAMES = "error";
    expect(
      await productNameRefusal(env, db, "polaris-key", "Polaris Key"),
    ).toBeNull();
    expect(
      await productNameRefusal(env, db, "polaris-key", "Polaris Key\u3164"),
    ).toMatchObject({ reason: "invalid_display_text" });
    expect(
      await productNameRefusal(env, db, "acme", "Polaris Key"),
    ).toMatchObject({ reason: "reserved_display_name" });
  });
});
