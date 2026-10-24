/**
 * Reading an `ExportDocument` back into the engine's rows (U-05.8). The document came from another
 * of our own objects, but an absorb writes it into a person's store, so its shape is checked as an
 * input is: a malformed one is refused whole, before any write.
 */

import { SYNC_KEY_PATTERN, type SyncJson } from "@polaris-key/protocol/sync";
import { isClientId, isHlc } from "../engine/hlc.js";
import type {
  ClientRecord,
  MemberCell,
  SettingPolicy,
  Stamp,
  StoredSetting,
} from "../engine/types.js";
import type { ExportDocument } from "./protocol.js";

const KEY_RE = new RegExp(SYNC_KEY_PATTERN);
const POLICIES: ReadonlySet<string> = new Set<SettingPolicy>([
  "lastWrite",
  "max",
  "min",
  "merge",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stampOf(v: unknown): Stamp | null {
  return isObject(v) && isHlc(v.hlc) && isClientId(v.clientId)
    ? { hlc: v.hlc, clientId: v.clientId }
    : null;
}

function rowOf(v: unknown): StoredSetting | null {
  if (!isObject(v)) return null;
  const stamp = stampOf(v.stamp);
  if (
    !stamp ||
    typeof v.key !== "string" ||
    !KEY_RE.test(v.key) ||
    (v.scope !== "user" && v.scope !== "platform") ||
    typeof v.deleted !== "boolean" ||
    !("value" in v)
  )
    return null;
  if (v.scope === "platform" && typeof v.family !== "string") return null;
  const row: StoredSetting = {
    key: v.key,
    scope: v.scope,
    ...(v.scope === "platform" ? { family: v.family as string } : {}),
    version: 0,
    stamp,
    deleted: v.deleted,
    value: v.value as SyncJson,
  };
  if (v.floor !== undefined && v.floor !== null) {
    const floor = stampOf(v.floor);
    if (!floor) return null;
    row.floor = floor;
  }
  if (v.members !== undefined) {
    if (!Array.isArray(v.members)) return null;
    const members = new Map<string, MemberCell>();
    for (const pair of v.members) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [name, cell] = pair as [unknown, unknown];
      if (typeof name !== "string" || !isObject(cell)) return null;
      const cs = stampOf(cell.stamp);
      if (!cs || typeof cell.removed !== "boolean" || !("value" in cell))
        return null;
      members.set(name, {
        value: cell.value as SyncJson,
        removed: cell.removed,
        stamp: cs,
      });
    }
    row.members = members;
  }
  return row;
}

export interface ParsedExport {
  settings: StoredSetting[];
  clients: ClientRecord[];
}

/** The document's rows and clients, or `null` when its shape is wrong. */
export function parseExportDocument(doc: unknown): ParsedExport | null {
  if (!isObject(doc) || !Array.isArray(doc.settings)) return null;
  if (!Array.isArray(doc.clients)) return null;
  const settings: StoredSetting[] = [];
  for (const raw of doc.settings) {
    const row = rowOf(raw);
    if (!row) return null;
    settings.push(row);
  }
  const clients: ClientRecord[] = [];
  for (const c of doc.clients) {
    if (
      !isObject(c) ||
      !isClientId(c.clientId) ||
      typeof c.deviceId !== "string" ||
      c.deviceId.length === 0 ||
      !Number.isSafeInteger(c.lastMutationId) ||
      (c.lastMutationId as number) < 0
    )
      return null;
    clients.push({
      clientId: c.clientId,
      deviceId: c.deviceId,
      lastMutationId: c.lastMutationId as number,
    });
  }
  return { settings, clients };
}

/** The wire form of a policy table, or `null` when it is not one. */
export function parsePolicies(
  v: unknown,
): ReadonlyMap<string, SettingPolicy> | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out = new Map<string, SettingPolicy>();
  for (const pair of v) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !POLICIES.has(pair[1] as string)
    )
      return null;
    out.set(pair[0], pair[1] as SettingPolicy);
  }
  return out;
}

export type { ExportDocument };
