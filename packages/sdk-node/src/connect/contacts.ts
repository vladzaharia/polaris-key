// Inter-account links as the Node SDK holds them (CC-19.5; WIRE-CONTRACT-V5 §15.10): the contact
// rows of `pkey.connect.v1` and the pure steps that change them. The rules (the cap of 64, the
// pending contacts, the trial order, the 24 h lapse) are client-core's `peer/contact.ts`; this file
// only carries the SDK's own columns (`createdAt`, `reachable`) across those calls.
//
// Rules this module keeps:
//  - a contact secret is key material: it is decoded for a call and wiped after, it is in no
//    `ContactInfo`, no error and no print, and `ContactInfo` carries no key of any kind;
//  - an `id` is derived from the peer's agreeKey (a public key) and names a link on this device
//    only: SHA-256("pkey-contact/1" 0x00 agreeKey)[0..12] in base64url, 16 characters.

import { createHash } from "node:crypto";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  MAX_CONTACT_SECRETS,
  contactTrialOrder,
  dropStalePending,
  promoteContact,
  storeContact,
  type StoredContact,
} from "@polaris-key/client-core/peer";
import type { ContactRow } from "./state.js";

/** What the host sees of one link. */
export interface ContactInfo {
  /** Names the link on this device (16 characters). Not the peer's key and not shared. */
  id: string;
  /** The label stored when the link was made, display data the other person chose. */
  label: string | null;
  /** The data categories both people approved, in byte order. */
  categories: readonly string[];
  /** Unix seconds. */
  createdAt: number;
  /** Advertised on the LAN and kept in a relay room (at most 8 at once). */
  reachable: boolean;
  /** A newer pairing with the same peer waits for its first handshake (§15.10). */
  rePairPending: boolean;
}

/** The link a session was made over. */
export interface ContactRef {
  id: string;
  label: string | null;
  categories: readonly string[];
  /** The peer's agreeKey, 43 base64url characters (a public key). */
  agreeKey: string;
  /** The session was opened under a pending contact: it is a first handshake of a re-pair. */
  pending: boolean;
}

export const contactId = (agreeKey: string): string =>
  createHash("sha256")
    .update("pkey-contact/1")
    .update(Uint8Array.of(0))
    .update(base64UrlDecode(agreeKey))
    .digest()
    .subarray(0, 12)
    .toString("base64url");

/** A contact in use: the row with its secret decoded. `wipe()` zeroes the secret. */
export interface LiveContact {
  readonly id: string;
  readonly agreeKey: string;
  readonly agreeKeyBytes: Uint8Array;
  readonly secret: Uint8Array;
  readonly label: string | null;
  readonly cats: readonly string[];
  readonly reachable: boolean;
  readonly pending: boolean;
}

export function liveOf(row: ContactRow): LiveContact {
  return {
    id: contactId(row.agreeKey),
    agreeKey: row.agreeKey,
    agreeKeyBytes: base64UrlDecode(row.agreeKey),
    secret: base64UrlDecode(row.secret),
    label: row.label ?? null,
    cats: row.cats,
    reachable: row.reachable,
    pending: row.pendingSince !== undefined,
  };
}

export const refOf = (c: LiveContact): ContactRef => ({
  id: c.id,
  label: c.label,
  categories: c.cats,
  agreeKey: c.agreeKey,
  pending: c.pending,
});

/** The contacts in `contactTrialOrder` (held first, then pending), decoded. The caller wipes them. */
export function trialOrderOf(rows: readonly ContactRow[]): LiveContact[] {
  const ordered = contactTrialOrder(rows.map(storedOf));
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const out = ordered.flatMap((s) => {
    const r = byKey.get(rowKey(s));
    return r === undefined ? [] : [liveOf(r)];
  });
  wipeStored(ordered);
  return out.slice(0, MAX_CONTACT_SECRETS);
}

export const wipeLive = (cs: readonly LiveContact[]): void => {
  for (const c of cs) c.secret.fill(0);
};

const rowKey = (r: {
  agreeKey: string;
  pendingSince?: number | undefined;
}): string => `${r.agreeKey}|${r.pendingSince === undefined ? "h" : "p"}`;

const storedOf = (r: ContactRow): StoredContact => ({
  agreeKey: r.agreeKey,
  secret: base64UrlDecode(r.secret),
  ...(r.label !== undefined ? { label: r.label } : {}),
  cats: r.cats,
  ...(r.pendingSince !== undefined ? { pendingSince: r.pendingSince } : {}),
});

const wipeStored = (cs: readonly StoredContact[]): void => {
  for (const c of cs) c.secret.fill(0);
};

export const infoOf = (rows: readonly ContactRow[]): ContactInfo[] => {
  const pending = new Set(
    rows.filter((r) => r.pendingSince !== undefined).map((r) => r.agreeKey),
  );
  return rows
    .filter((r) => r.pendingSince === undefined)
    .map((r) => ({
      id: contactId(r.agreeKey),
      label: r.label ?? null,
      categories: [...r.cats],
      createdAt: r.createdAt,
      reachable: r.reachable,
      rePairPending: pending.has(r.agreeKey),
    }));
};

export type RowsStore =
  | { ok: true; rows: ContactRow[]; pending: boolean }
  | { ok: false; reason: "full" };

/** Store a contact the pairing produced (client-core `storeContact`); the new one is reachable. */
export function storeRow(
  rows: readonly ContactRow[],
  incoming: {
    agreeKey: string;
    secret: Uint8Array;
    label?: string;
    cats: readonly string[];
  },
  nowSeconds: number,
): RowsStore {
  const stored = rows.map(storedOf);
  const secret = new Uint8Array(incoming.secret);
  const v = storeContact(
    stored,
    {
      agreeKey: incoming.agreeKey,
      secret,
      ...(incoming.label !== undefined ? { label: incoming.label } : {}),
      cats: incoming.cats,
    },
    nowSeconds,
  );
  try {
    if (!v.ok) return v;
    const keep = new Map(rows.map((r) => [rowKey(r), r]));
    const out: ContactRow[] = v.contacts.map((c, i) => {
      const was =
        i < v.contacts.length - 1 || c.secret !== secret
          ? keep.get(rowKey(c))
          : undefined;
      if (was !== undefined) return was;
      return {
        agreeKey: c.agreeKey,
        secret: base64UrlEncodeBytes(c.secret),
        ...(c.label !== undefined ? { label: c.label } : {}),
        cats: [...c.cats],
        createdAt: nowSeconds,
        reachable: true,
        ...(c.pendingSince !== undefined
          ? { pendingSince: c.pendingSince }
          : {}),
      };
    });
    return { ok: true, rows: out, pending: v.pending };
  } finally {
    wipeStored(stored);
    secret.fill(0);
  }
}

/** A handshake under the pending contact of `agreeKey` passed the pin: it takes the held one's place. */
export function promoteRow(
  rows: readonly ContactRow[],
  agreeKey: string,
): ContactRow[] {
  const pend = rows.find(
    (r) => r.pendingSince !== undefined && r.agreeKey === agreeKey,
  );
  const held = rows.find(
    (r) => r.pendingSince === undefined && r.agreeKey === agreeKey,
  );
  if (pend === undefined) return [...rows];
  const stored = rows.map(storedOf);
  try {
    const next = promoteContact(stored, agreeKey);
    return next.map((c) => {
      if (c.pendingSince === undefined && c.agreeKey === agreeKey)
        // The new link: its secret, label and categories, made when the pairing was; the held
        // one's local choice of reachability stays.
        return {
          agreeKey,
          secret: pend.secret,
          ...(pend.label !== undefined ? { label: pend.label } : {}),
          cats: [...pend.cats],
          createdAt: pend.createdAt,
          reachable: held?.reachable ?? pend.reachable,
        };
      return rows.find((r) => rowKey(r) === rowKey(c))!;
    });
  } finally {
    wipeStored(stored);
  }
}

/** Drop the pending contacts that lapsed. */
export function dropStaleRows(
  rows: readonly ContactRow[],
  nowSeconds: number,
): ContactRow[] {
  const stored = rows.map(storedOf);
  try {
    const keep = new Set(dropStalePending(stored, nowSeconds).map(rowKey));
    return rows.filter((r) => keep.has(rowKey(r)));
  } finally {
    wipeStored(stored);
  }
}
