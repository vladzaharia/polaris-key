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
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
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
          <p className="font-medium text-fg-strong">{ring.name}</p>
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
            </span>
            <span className="text-xs text-fg-muted">
              {k.state === "active" && k.dueAt !== null ? (
                <>
                  Replaced <Timestamp at={fromSeconds(k.dueAt)} format="date" />
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
                  setTarget(ring);
                }}
              />
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        intent="danger"
        title={`Rotate ${target?.name ?? ""} issuer key now?`}
        consequences={[
          "A new key signs from now on. Every earlier key is dropped at once.",
          "Every token those keys signed stops verifying: people signed in to clients sign in again.",
          "Do this only for a leaked key. The 90-day rotation is automatic and has no gap.",
        ]}
        typedConfirmation={{
          value: target?.slug ?? "",
          label: "Type the product slug",
        }}
        focusTyped
        confirmLabel="Rotate now"
        stepUpKey="issuer-key-rotate"
        stepUpState={{ why }}
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
      </ConfirmDialog>
    </Section>
  );
}
