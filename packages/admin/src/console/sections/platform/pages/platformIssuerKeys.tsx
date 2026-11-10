/**
 * Platform → Settings → Issuer keys (I-21.14): the signing key ring of each product that signs
 * people in for clients (Sign in with <Product>). Each product has its own RS256 key, replaced every
 * 90 days: a next key is published 7 days before it signs, and a retired one stays 30 days. "Rotate
 * now" is the emergency step for a leaked key: it makes a new key active and drops every other at
 * once, so every token they signed stops verifying. Superadmin only, a fresh sign-in, the product
 * slug typed, and a reason for the audit trail.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { IssuerKeyRing } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { cn } from "../../../../lib/cn.js";
import { CONTROL_INPUT } from "../../../../ui/inputBase.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { blocker, NEEDS_REASON } from "../../../../ui/confirmReasons.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { isSuperadmin } from "../../../access/membersModel.js";
import { useMe } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { issuerKeysQuery } from "../../identity/data.js";

const REASON_MAX = 500;
/** The saved dialog a step-up sign-in leaves behind; Advanced opens for it. */
export const ROTATE_STEP_UP_KEY = "issuer-key-rotate";
const STATE_TONE = {
  active: "success",
  next: "info",
  retired: "neutral",
} as const;
const STATE_LABEL = {
  active: "Signing",
  next: "Next",
  retired: "Retired",
} as const;

function Ring({
  ring,
  onRotate,
  reason,
}: {
  ring: IssuerKeyRing;
  onRotate: () => void;
  reason: string | undefined;
}): React.ReactElement {
  const active = ring.keys.find((k) => k.state === "active");
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg-strong">{ring.name}</p>
          <p className="text-xs text-fg-muted">
            {ring.slug}
            {ring.issuerOn ? "" : " · Sign in with this product is off"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          iconStart={<RefreshCw aria-hidden />}
          disabledReason={reason}
          onClick={onRotate}
        >
          Rotate now
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {ring.keys.map((k) => (
          <li
            key={k.kid}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <StatusPill tone={STATE_TONE[k.state]} size="sm">
                {STATE_LABEL[k.state]}
              </StatusPill>
              <code className="truncate text-xs text-fg" title={k.kid}>
                {k.kid.slice(0, 12)}…
              </code>
              <CopyButton
                value={k.kid}
                label={`Copy key id ${k.kid.slice(0, 12)}`}
              />
            </span>
            <span className="text-xs text-fg-muted">
              {k.state === "active" && k.dueAt !== null ? (
                <>
                  Rotates <Timestamp at={fromSeconds(k.dueAt)} format="date" />
                </>
              ) : k.state === "next" && k.dueAt !== null ? (
                <>
                  Signs from{" "}
                  <Timestamp at={fromSeconds(k.dueAt)} format="date" />
                </>
              ) : k.retiredAt !== null ? (
                <>
                  Retired{" "}
                  <Timestamp at={fromSeconds(k.retiredAt)} format="date" />
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {active ? null : (
        <p className="text-xs text-fg-muted">
          No key is signing. The next token creates one.
        </p>
      )}
    </li>
  );
}

export function IssuerKeysSection(): React.ReactElement | null {
  const q = useQuery(issuerKeysQuery());
  const me = useMe().data;
  const [target, setTarget] = React.useState<IssuerKeyRing | null>(null);
  const [why, setWhy] = React.useState("");
  const [typed, setTyped] = React.useState("");
  // Open again after a step-up sign-in, before the saved state says for which product.
  const [restoring, setRestoring] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const typedRef = React.useRef<HTMLInputElement>(null);
  // The product of a saved rotate is looked up once the rings are in.
  React.useEffect(() => {
    if (saved === null || !q.data) return;
    setTarget(q.data.find((x) => x.slug === saved) ?? null);
    setSaved(null);
    setRestoring(false);
  }, [saved, q.data]);
  const superadmin = isSuperadmin(me);
  // A platform with no product that ever signed a token has nothing to show.
  if (q.data && q.data.length === 0) return null;
  return (
    <Section
      variant="settings"
      id="platform-issuer-keys"
      headingLevel={3}
      title="Issuer keys"
      description="Each product that signs people in for clients has its own signing key, replaced every 90 days. Rotate now drops every earlier key at once."
    >
      <div className="px-5">
        {q.isPending ? (
          <Skeleton className="my-4 h-20 w-full" />
        ) : q.isError ? (
          <div className="py-4">
            <ErrorState
              error={q.error}
              onRetry={() => void q.refetch()}
              context={{ thing: "Issuer keys" }}
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((ring) => (
              <Ring
                key={ring.slug}
                ring={ring}
                reason={
                  superadmin
                    ? undefined
                    : "Only a Superadmin can rotate an issuer key."
                }
                onRotate={() => {
                  setWhy("");
                  setTyped("");
                  setTarget(ring);
                }}
              />
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={target !== null || restoring}
        onOpenChange={(o) => {
          if (o) setRestoring(true);
          else {
            setTarget(null);
            setRestoring(false);
          }
        }}
        intent="danger"
        title={`Rotate ${target?.name ?? "the"} issuer key now?`}
        consequences={[
          "A new key signs from now on. Every earlier key is dropped at once.",
          "Every token those keys signed stops verifying: people signed in to clients sign in again.",
          "Do this only for a leaked key. The 90-day rotation is automatic and has no gap.",
        ]}
        initialFocusRef={typedRef}
        confirmLabel="Rotate now"
        confirmDisabled={typed !== (target?.slug ?? "")}
        confirmDisabledReason={blocker([
          typed !== (target?.slug ?? ""),
          `Type ${target?.slug ?? "the product slug"} to confirm`,
        ])}
        stepUpKey={ROTATE_STEP_UP_KEY}
        stepUpState={{ slug: target?.slug ?? "", why, typed }}
        onRestore={(saved) => {
          setWhy(saved.why ?? "");
          setTyped(saved.typed ?? "");
          setSaved(saved.slug ?? "");
        }}
        describeError={(e) => errorCopy(e, { thing: "Issuer key" })}
        onConfirm={async () => {
          if (!target) return;
          const res = await mutate("rotateIssuerKey", target.slug, {
            confirmSlug: target.slug,
            ...(why.trim() ? { reason: why.trim() } : {}),
          });
          toast.success("Issuer key rotated", {
            description: `${res.dropped} earlier ${res.dropped === 1 ? "key" : "keys"} dropped.`,
          });
        }}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="issuer-key-slug"
              className="block text-sm font-medium text-fg-strong console:font-normal console:text-fg"
            >
              Type the product slug{" "}
              <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs text-fg-strong">
                {target?.slug}
              </code>
            </label>
            <input
              ref={typedRef}
              id="issuer-key-slug"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              className={cn(CONTROL_INPUT, "font-mono console:text-sm")}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="issuer-key-reason"
              className="text-sm font-medium text-fg-strong"
            >
              Reason
            </label>
            <Textarea
              id="issuer-key-reason"
              value={why}
              maxLength={REASON_MAX}
              onChange={(e) => setWhy(e.target.value)}
            />
            <p className="text-xs text-fg-muted">
              Recorded in the audit log. Optional.
            </p>
          </div>
        </div>
      </ConfirmDialog>
    </Section>
  );
}
