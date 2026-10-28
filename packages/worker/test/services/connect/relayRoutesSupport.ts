import type { World } from "./connectFixture.js";
import { SLUG } from "./connectFixture.js";

/** Take a device out of its person's roster, as a released seat does. */
export async function releaseSeat(w: Pick<World, "db">, deviceId: string) {
  await w.db.run(
    "UPDATE devices SET seat_no = NULL, token_hash = NULL WHERE product = ? AND device_id = ?",
    SLUG,
    deviceId,
  );
}
