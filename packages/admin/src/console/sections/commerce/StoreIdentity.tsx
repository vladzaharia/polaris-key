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

/** The identity cell: the value and its source, or why there is none. */
export function StoreIdentityCell({
  slug,
  row,
}: {
  slug: string;
  row: StoreIdentityRow;
}): React.ReactElement {
  const platformAdmin = useCan("platform");
  const { identity, reason, label } = row;
  if (identity?.value) {
    return (
      <div className="min-w-0" data-identity={row.id}>
        <code className="break-all font-mono text-xs text-fg-strong">
          {identity.value}
        </code>
        <p className="text-xs text-fg-muted">
          {identity.source === "typed"
            ? "Typed in settings"
            : `From the ${label} assignment`}
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
          Its own key names no app and hides the platform's.
        </p>
        <Link to={r.keys(slug)} className={LINK}>
          Open keys
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
      ) : null}
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
  const ambiguous = rows.filter(
    (s) => s.identity?.ambiguous && s.identity.value,
  );
  if (mismatched.length === 0 && ambiguous.length === 0) return null;
  const policy = confirmFor("commerce.useAssigned");
  const fix = async (): Promise<void> => {
    if (!fixing) return;
    const done = fixing;
    await mutate("commerceUseAssigned", slug, done.id);
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
              <Link to={r.keys(slug)}>Open keys</Link>
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
                `${fixing.label} purchases move from \`${fixing.identity!.value}\` to \`${fixing.identity!.assigned}\`.`,
              )}
            </p>
          ) : null
        }
        consequences={[
          "Purchases of the typed app stop claiming licenses.",
          "Typing the value again undoes it.",
        ]}
        confirmLabel="Use the assigned app"
        describeError={errorCopy}
        onConfirm={fix}
      />
    </div>
  );
}
