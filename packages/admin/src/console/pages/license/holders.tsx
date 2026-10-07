/**
 * Licence holders in the console (LX-30; notes/S-24 §5, §8.8; ADMIN.md §6.5.1–§6.5.2).
 *
 * A licence is **floating** (no account and no email: anyone with the key uses it) or
 * **assigned**, either **in an account** or **waiting** for the first account that verifies its
 * email. The Worker derives it (`holder`, S-24 D1); an older Worker without the member is read
 * from the licence's own email, which says assigned or floating but not whether it joined an
 * account. The words are S-24 §8.6's: "Floating · anyone with the key", "In an account",
 * "Waiting for ada@example.com". The console never says whether a waiting email has an account
 * (D4), and never "holder", "claim", "redeem" or "seat" in what an operator reads.
 *
 * Also here: the batch reads (LX-28) the Licenses list, the record and the batch pages share,
 * and the licence's holder moves (I-12's relink history for one licence, with the 72-hour undo).
 * Each query has one fetcher per key (`queryKeyShapes`).
 */

import * as React from "react";
import { KeyRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type LicenseBatch,
  type LicenseHolder,
  type LicenseHolderMove,
  type LicenseSummary,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { r } from "../../routes.js";
import { Link } from "../../router.js";

// ── The holder ───────────────────────────────────────────────────────────────────────────────

/** The three things the console shows: "In an account", "Waiting", "Floating". */
export type HolderState = "inAccount" | "waiting" | "floating";

export const HOLDER_STATES: HolderState[] = [
  "inAccount",
  "waiting",
  "floating",
];

export const HOLDER_STATE_LABELS: Record<HolderState, string> = {
  inAccount: "In an account",
  waiting: "Waiting",
  floating: "Floating",
};

/** The licence's holder: the Worker's, else read from its own email (an older Worker). */
export function holderOf(
  l: Pick<LicenseSummary, "holder" | "email" | "ownerSubject">,
): LicenseHolder {
  if (l.holder) return l.holder;
  const email = l.email?.trim();
  if (!email && !l.ownerSubject) return { kind: "floating" };
  return {
    kind: "assigned",
    inAccount: Boolean(l.ownerSubject),
    ...(email ? { email } : {}),
  };
}

export function holderState(
  l: Pick<LicenseSummary, "holder" | "email" | "ownerSubject">,
): HolderState {
  const h = holderOf(l);
  if (h.kind === "floating") return "floating";
  return h.inAccount ? "inAccount" : "waiting";
}

/** True while the licence has no holder: Assign… is its action, not Reassign or Make floating. */
export function isFloating(
  l: Pick<LicenseSummary, "holder" | "email" | "ownerSubject">,
): boolean {
  return holderOf(l).kind === "floating";
}

/** The record's title: the name, else what the licence is. */
export function licenseTitle(
  l: Pick<LicenseSummary, "name" | "holder" | "email" | "ownerSubject">,
): string {
  if (l.name) return l.name;
  return isFloating(l) ? "Floating license" : "Unnamed license";
}

/**
 * What an operator types to confirm Reassign or Make floating (S-24 D20): the licence's name, or
 * its id when it has none. The Worker compares the same value.
 */
export function holderConfirmValue(l: Pick<LicenseSummary, "name" | "id">): {
  value: string;
  what: "name" | "id";
} {
  const name = l.name?.trim();
  return name ? { value: name, what: "name" } : { value: l.id, what: "id" };
}

/** The Licenses list's Holder cell (S-24 §8.8): name and email, waiting, or Floating, muted. */
export function HolderCell({
  license: l,
}: {
  license: LicenseSummary;
}): React.ReactElement {
  const h = holderOf(l);
  const floating = h.kind === "floating";
  const email = h.kind === "assigned" ? (h.email ?? l.email) : "";
  const primary =
    l.name || (floating ? "Floating" : email || "Unnamed license");
  let secondary: string;
  if (floating)
    secondary = l.name
      ? "Floating · anyone with the key"
      : "anyone with the key";
  else if (h.kind === "assigned" && h.inAccount)
    secondary = l.name && email ? email : "In an account";
  else secondary = l.name && email ? `Waiting for ${email}` : "Waiting";
  return (
    <span className="flex min-w-0 max-w-[22rem] flex-col">
      {/* The name flies into the record's title on a drill-down (S-23 §6.1 shared-element): the
          router names it for the old page only. Both ends are fit-content, so the snapshot never
          stretches. */}
      <span
        className={
          floating && !l.name
            ? "flex w-fit max-w-full items-center gap-1.5 truncate text-fg-muted"
            : "w-fit max-w-full truncate"
        }
        title={l.name || undefined}
        data-vt-shared="pk-key"
      >
        {floating && !l.name ? (
          <KeyRound aria-hidden className="size-3.5 shrink-0" />
        ) : null}
        {primary}
      </span>
      <span
        className="truncate text-xs font-normal text-fg-muted"
        title={secondary}
      >
        {secondary}
      </span>
    </span>
  );
}

/**
 * The record header's holder line (ADMIN.md §6.5.2): "Ada Lovelace · ada@example.com · In an
 * account", "Waiting for ada@example.com", or "Floating · anyone with the key", with the batch
 * the licence came from.
 */
export function HolderLine({
  slug,
  license: l,
  batch,
}: {
  slug: string;
  license: LicenseSummary;
  batch: LicenseBatch | null;
}): React.ReactElement {
  const h = holderOf(l);
  const parts: React.ReactNode[] = [];
  if (h.kind === "floating") {
    parts.push(
      <span key="f" className="inline-flex items-center gap-1">
        <KeyRound aria-hidden className="size-3.5 shrink-0" />
        <strong className="font-bold text-fg">Floating</strong>
      </span>,
      "anyone with the key",
    );
  } else {
    if (l.name) parts.push(l.name);
    const email = h.email ?? l.email;
    if (h.inAccount) {
      if (email) parts.push(email);
      parts.push("In an account");
    } else {
      parts.push(`Waiting for ${email}`);
    }
  }
  if (l.batchId) {
    parts.push(
      <span key="b">
        batch{" "}
        <Link
          to={r.licenseBatch(slug, l.batchId)}
          className="font-bold text-accent-fg underline-offset-2 hover:underline"
        >
          {batch?.label ?? "Open batch"}
        </Link>
      </span>,
    );
  }
  return (
    <span
      data-testid="record-holder"
      className="inline-flex flex-wrap items-center gap-x-1"
    >
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span aria-hidden>·</span> : null}
          {typeof p === "string" ? <span>{p}</span> : p}
        </React.Fragment>
      ))}
    </span>
  );
}

// ── Batches (LX-28) ──────────────────────────────────────────────────────────────────────────

/** The page size the batch list is read in, and the most pages read (10,000 batches). */
const BATCH_PAGE = 500;
const MAX_BATCH_PAGES = 20;

/** Every batch of the product, newest first, all pages read: one key, one shape. */
export async function fetchLicenseBatches(
  slug: string,
): Promise<{ batches: LicenseBatch[] }> {
  const batches: LicenseBatch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BATCH_PAGES; page++) {
    const res = await api.licenseBatches(slug, { limit: BATCH_PAGE, cursor });
    batches.push(...(res.batches ?? []));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return { batches };
}

export function useLicenseBatches(slug: string) {
  return useQuery(
    {
      queryKey: qk.licenseBatches(slug),
      queryFn: () => fetchLicenseBatches(slug),
    },
    queryClient,
  );
}

/** One batch; `null` reads nothing (a licence created on its own). */
export function useLicenseBatch(slug: string, id: string | null) {
  return useQuery(
    {
      queryKey: qk.licenseBatch(slug, id ?? ""),
      queryFn: () => api.licenseBatch(slug, id ?? ""),
      enabled: id !== null,
    },
    queryClient,
  );
}

// ── Holder moves (I-12's relink tool, keyed by the licence) ─────────────────────────────────

export function useLicenseHolderMoves(slug: string, id: string) {
  return useQuery(
    {
      queryKey: qk.licenseHolderMoves(slug, id),
      queryFn: () => api.licenseHolderMoves(slug, id),
      // An older Worker has no such route: no moves to undo, nothing to retry.
      retry: false,
    },
    queryClient,
  );
}

/** The move an operator can still undo: the newest, while its window is open. */
export function undoableMove(
  moves: LicenseHolderMove[] | undefined,
): LicenseHolderMove | null {
  return moves?.find((m) => m.undoable) ?? null;
}

/** "Made floating", "Reassigned", "Relinked": a move in words. */
export function moveVerb(kind: LicenseHolderMove["kind"]): string {
  switch (kind) {
    case "floating":
      return "Made floating";
    case "reassign":
      return "Reassigned";
    default:
      return "Moved to another user";
  }
}
