/**
 * Which app each store's purchases belong to (A-28.5, CM-20 D12/D14/D15). The identity is read
 * from the assignment unless a value was typed; the page shows the value and where it comes from,
 * says so when no app is assigned, and offers "Use the assigned app" when a typed value disagrees.
 * The server decides everything; nothing here is typed.
 */

import * as React from "react";
import type { CommerceStore, CommerceStoreIdentity } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { inlineCode } from "../../../lib/inline.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { toast } from "../../../ui/toast.js";
import { confirmFor } from "../../../lib/actions.js";
import { useCan, useWriteGate } from "../../access/useCan.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";

const LINK = "py-1 text-accent-fg underline underline-offset-2";

/** The store as `setup[store].reason` and `identity[store]` describe it. */
export interface StoreIdentityRow {
  id: CommerceStore;
  label: string;
  identity: CommerceStoreIdentity | undefined;
  /** `CommerceView.setup[store].reason`. */
  reason: string | null;
}

/** Whether the store has a `commerce.stores` block at all (no block: the store is off, D13). */
const hasBlock = (reason: string | null): boolean =>
  !reason?.startsWith("no settings");

/** Move focus to a store's row header (visible one: the table or the phone list). */
export function focusStoreRow(id: CommerceStore): void {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-store-row="${id}"]`),
  );
  const el = all.find((e) => e.getClientRects().length > 0) ?? all[0];
  el?.focus();
}

/** The identity cell: the value and its source, or why there is none. */
export function StoreIdentityCell({
  slug,
  row,
}: {
  slug: string;
  row: StoreIdentityRow;
}): React.ReactElement {
  const platformAdmin = useCan("platform");
  const { identity, reason } = row;
  if (identity?.value) {
    return (
      <div className="min-w-0" data-identity={row.id}>
        <code className="break-all font-mono text-xs text-fg-strong">
          {identity.value}
        </code>
        <p className="text-xs text-fg-muted">
          {identity.source === "typed"
            ? inlineCode("Typed in `commerce.stores`")
            : "From the assignment"}
        </p>
      </div>
    );
  }
  if (!hasBlock(reason))
    return (
      <span className="text-fg-muted" data-identity={row.id}>
        –<span className="sr-only">None</span>
      </span>
    );
  if (reason === "own_credential_unpinned")
    return (
      <div className="min-w-0 text-sm" data-identity={row.id}>
        <p className="text-fg">
          Its own key names no app, so the platform's assignment is ignored.
        </p>
        <Link to={r.credentials(slug)} className={LINK}>
          Pin the key
        </Link>
      </div>
    );
  return (
    <div className="min-w-0 text-sm" data-identity={row.id}>
      <p className="text-fg">No app assigned</p>
      {platformAdmin ? (
        <Link to={r.platformStores()} className={LINK}>
          Platform → Store connections
        </Link>
      ) : (
        <p className="text-fg-muted">A platform admin assigns it.</p>
      )}
    </div>
  );
}

/**
 * The lines that need an operator: a typed app that differs from the assigned one (fixable here)
 * and keys that name different apps (fixed by retiring one on Keys).
 */
export function IdentityAttention({
  slug,
  rows,
}: {
  slug: string;
  rows: readonly StoreIdentityRow[];
}): React.ReactElement | null {
  const gate = useWriteGate("commerce", slug);
  const [fixing, setFixing] = React.useState<StoreIdentityRow | null>(null);
  const mismatched = rows.filter((s) => s.identity?.mismatch);
  // Keys only decide an assigned identity; a typed value in force is not theirs to settle.
  const ambiguous = rows.filter(
    (s) =>
      s.identity?.ambiguous &&
      s.identity.value &&
      s.identity.source === "assigned",
  );
  // After a fix the callout is gone: focus the store's row, not <body>.
  const refocus = React.useRef<CommerceStore | null>(null);
  const stillMismatched = mismatched.some((s) => s.id === refocus.current);
  React.useEffect(() => {
    const id = refocus.current;
    if (id === null || stillMismatched) return;
    refocus.current = null;
    focusStoreRow(id);
  }, [stillMismatched, rows]);
  if (mismatched.length === 0 && ambiguous.length === 0) return null;
  const policy = confirmFor("commerce.useAssigned");
  const fix = async (): Promise<void> => {
    if (!fixing) return;
    const done = fixing;
    await mutate("commerceUseAssigned", slug, done.id);
    refocus.current = done.id;
    toast.success(`${done.label} now uses the assigned app`);
  };
  return (
    <div className="space-y-3" data-identity-attention>
      {mismatched.map((s) => (
        <Callout
          key={`mismatch:${s.id}`}
          tone="warning"
          title={`${s.label} app mismatch`}
          action={
            <Button
              size="sm"
              variant="outline"
              disabledReason={gate.disabledReason}
              onClick={() => setFixing(s)}
            >
              Use the assigned app
            </Button>
          }
        >
          <p>
            {inlineCode(
              `Purchases are checked against \`${s.identity!.value}\`, not the assigned app \`${s.identity!.assigned}\`.`,
            )}
          </p>
        </Callout>
      ))}
      {ambiguous.map((s) => (
        <Callout
          key={`ambiguous:${s.id}`}
          tone="warning"
          title={`${s.label} keys name different apps`}
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to={r.credentials(slug)}>Open channel credentials</Link>
            </Button>
          }
        >
          <p>
            {inlineCode(
              `Purchases are checked against \`${s.identity!.value}\`.`,
            )}
          </p>
        </Callout>
      ))}
      <ConfirmDialog
        open={fixing !== null}
        onOpenChange={(open) => {
          if (!open) setFixing(null);
        }}
        intent={policy.intent === "none" ? "caution" : policy.intent}
        title="Use the assigned app?"
        lead={
          fixing ? (
            <p>
              {inlineCode(
                `${fixing.label} purchases are checked against \`${fixing.identity!.assigned}\` instead of \`${fixing.identity!.value}\`.`,
              )}
            </p>
          ) : null
        }
        consequences={
          fixing
            ? [
                inlineCode(
                  `Purchases of \`${fixing.identity!.value}\` are refused.`,
                ),
                ...(fixing.id === "app-store"
                  ? ["The typed Apple ID is cleared too."]
                  : []),
                inlineCode(
                  "To undo, set `commerce.stores` again through the API.",
                ),
              ]
            : []
        }
        confirmLabel="Use the assigned app"
        describeError={(e) => errorCopy(e, { area: "commerce" })}
        onConfirm={fix}
      />
    </div>
  );
}
