/**
 * License machines (`/api/products/<slug>/licenses/<id>/machines`): list, and deauthorize
 * (DELETE or POST). Deauthorizing also evicts the machine's session token from KV.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { deleteTokenRecord } from "../../kv.js";
import { listMachinesByLicense, setMachineStatus, getMachine } from "../../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound } from "../lib/respond.js";

export async function handleMachines(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  machineId: string | undefined,
  now: number,
): Promise<Response> {
  if (!machineId) {
    if (req.method === "GET") {
      const machines = await listMachinesByLicense(db, slug, licenseId);
      return adminJson({
        machines: machines.map((m) => ({ machineId: m.machine_id, status: m.status, firstSeen: m.first_seen, lastSeen: m.last_seen, ua: m.ua ?? undefined, label: m.label ?? undefined })),
      });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const machine = await getMachine(db, slug, machineId);
  if (!machine || machine.license_id !== licenseId) return notFound();
  if (req.method === "DELETE" || req.method === "POST") {
    await setMachineStatus(db, slug, machineId, "deauthorized");
    if (machine.token_hash) await deleteTokenRecord(env, slug, machine.token_hash);
    await audit(db, slug, session, now, "machine.deauthorize", { kind: "machine", id: machineId }, `Deauthorized ${machineId}`);
    return adminJson({ ok: true, machineId });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
