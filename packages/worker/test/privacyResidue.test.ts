import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import {
  TOMBSTONE_RETENTION_SECONDS,
  purgePrivacyResidue,
} from "../src/privacyResidue.js";

describe("privacy residue sweep", () => {
  it("scrubs relink name/email after the undo window and purges old merge tombstones", async () => {
    const db = await makeTestDb();
    await seedProduct(db, "p1");
    const holder = JSON.stringify({
      kind: "reassign",
      from: { name: "A", email: "a@example.com" },
      to: { name: "B", email: "b@example.com" },
      devicesSignedOut: 2,
    });
    for (const [id, undo] of [
      ["old", NOW - 10],
      ["live", NOW + 1000],
    ] as const) {
      await db.run(
        `INSERT INTO license_relinks (product, id, license_id, from_subject, to_subject, reason,
           actor_sub, actor_name, notices_sent, created_at, undo_until, holder_json)
         VALUES ('p1', ?, 'l', '', '', 'r', 's', 'n', 0, ?, ?, ?)`,
        id,
        NOW - 100,
        undo,
        holder,
      );
    }
    await db.run(
      "INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at) VALUES ('m', 'h', 'x', ?), ('e', NULL, NULL, ?)",
      NOW - TOMBSTONE_RETENTION_SECONDS - 5,
      NOW - TOMBSTONE_RETENTION_SECONDS - 5,
    );
    await purgePrivacyResidue(db, NOW);
    const rows = await db.all<{ id: string; holder_json: string }>(
      "SELECT id, holder_json FROM license_relinks ORDER BY id DESC",
    );
    expect(rows[0]!.holder_json).not.toContain("example.com");
    expect(JSON.parse(rows[0]!.holder_json).devicesSignedOut).toBe(2);
    expect(rows[1]!.holder_json).toContain("a@example.com");
    const t = await db.all<{ id: string }>("SELECT id FROM account_tombstones");
    expect(t.map((r) => r.id)).toEqual(["e"]);
  });
});
