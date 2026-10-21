/**
 * One alert destination as a row (ST-27): a grid of glyph, content and controls. The switch and
 * the ⋯ menu sit in a fixed right column that never wraps. The content column is the name (one
 * truncated line from `sm` up, with its full text as the title; on a phone it breaks at a word
 * boundary), then a wrapping line of kinds and status, then the last delivery error.
 */

import * as React from "react";
import { Mail, Webhook } from "lucide-react";
import {
  ApiError,
  type AlertDestination,
  type AlertScope,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { fromSeconds } from "../../../lib/format.js";
import { ActionMenu, type ActionMenuEntry } from "../../../ui/ActionMenu.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import {
  breakPoints,
  failureText,
  formatWait,
  isStepUp,
  nameOf,
  secondsUntil,
  type KindInfo,
} from "./alertShared.js";

function KindChips({
  d,
  kinds,
}: {
  d: AlertDestination;
  kinds: readonly KindInfo[];
}): React.ReactElement {
  if (d.alerts.length >= kinds.length)
    return <span className="text-xs text-fg-muted">All alerts</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {d.alerts.map((id) => (
        <span
          key={id}
          className="rounded border border-border px-1.5 py-px text-xs text-fg-muted"
        >
          {kinds.find((k) => k.id === id)?.label ?? id}
        </span>
      ))}
    </span>
  );
}

/** A time as a phrase: "just now" inside a minute, else relative. */
function When({ at }: { at: number }): React.ReactElement {
  return Date.now() / 1000 - at < 60 ? (
    <>just now</>
  ) : (
    <Timestamp at={fromSeconds(at)} format="relative" />
  );
}

function Status({
  d,
  canEdit,
}: {
  d: AlertDestination;
  canEdit: boolean;
}): React.ReactElement | null {
  // One indicator for off: the switch. A view-only member has no switch to read, so the pill.
  if (!d.enabled)
    return canEdit ? null : <StatusPill tone="neutral">Off</StatusPill>;
  if (d.lastStatus === null)
    return <span className="text-xs text-fg-muted">Not used yet</span>;
  const when = d.lastAt ? <When at={d.lastAt} /> : null;
  if (d.lastStatus === "ok")
    return <span className="text-xs text-fg-muted">Delivered {when}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusPill tone="danger">
        {d.lastStatus === "refused" ? "Refused" : "Failing"}
        {d.failures > 1 ? ` · ${d.failures} in a row` : ""}
      </StatusPill>
      <span className="text-xs text-fg-muted">last try {when}</span>
    </span>
  );
}

/** What to check after a failed delivery, in the reader's terms. */
function checkHint(d: AlertDestination, canEdit: boolean): string {
  if (d.lastError?.startsWith("Redirect"))
    return "Redirects aren't followed. Use the final URL.";
  const check =
    d.kind === "webhook"
      ? "Check the URL and that your receiver is up"
      : "Check the address";
  return `${check}${canEdit ? ", then send a test" : ""}.`;
}

export function DestinationRow({
  d,
  scope,
  canEdit,
  kinds,
  retryAt,
  ensureFresh,
  onStepUp,
  onThrottled,
  onEdit,
  onSecret,
  onRemoved,
}: {
  d: AlertDestination;
  scope: AlertScope;
  canEdit: boolean;
  kinds: readonly KindInfo[];
  /** When the scope's test throttle clears (ms since the epoch); 0 when it is clear. */
  retryAt: number;
  ensureFresh: () => boolean;
  onStepUp: () => void;
  onThrottled: (seconds: number) => void;
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onRemoved: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [testFail, setTestFail] = React.useState<{
    detail: string | null;
  } | null>(null);
  const [throttledHere, setThrottledHere] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const name = nameOf(d);
  const left = secondsUntil(retryAt);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (isStepUp(e)) onStepUp();
      else setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = (): Promise<void> =>
    run(async () => {
      setTestFail(null);
      setThrottledHere(false);
      try {
        const res = await mutate("testAlertDestination", scope, d.id);
        if (res.outcome === "ok") toast.success("Test alert delivered");
        else setTestFail({ detail: res.detail });
      } catch (e) {
        if (e instanceof ApiError && e.status === 429 && e.retryAfter) {
          setThrottledHere(true);
          onThrottled(e.retryAfter);
          return;
        }
        throw e;
      }
    });

  const items: ActionMenuEntry[] = [
    {
      label: "Send test",
      onSelect: () => void sendTest(),
      ...(left > 0
        ? { disabledReason: `Try again in ${formatWait(left)}` }
        : {}),
      ...(d.kind === "email" && scope.kind === "product"
        ? { disabledReason: "Product email addresses can't be tested yet." }
        : {}),
    },
    ...(d.kind === "webhook"
      ? [
          {
            label: "New secret",
            onSelect: () => {
              if (ensureFresh()) setRotating(true);
            },
          },
        ]
      : []),
    {
      label: "Edit…",
      onSelect: () => {
        if (ensureFresh()) onEdit();
      },
    },
    { type: "separator" },
    {
      label: "Remove…",
      tone: "danger",
      onSelect: () => {
        if (ensureFresh()) setRemoving(true);
      },
    },
  ];

  const Glyph = d.kind === "email" ? Mail : Webhook;
  const note =
    throttledHere && left > 0
      ? `Test not sent. Try again in ${formatWait(left)}.`
      : testFail
        ? `Test failed.${testFail.detail ? ` ${testFail.detail}.` : ""}`
        : null;
  const showError = d.enabled && d.lastError && d.lastStatus !== "ok";
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-2.5 @[16rem]:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Glyph
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-fg-muted",
          !d.enabled && canEdit && "opacity-50",
        )}
      />
      <div className="min-w-0 space-y-1">
        <p
          dir="auto"
          title={name}
          className="text-sm font-medium text-fg-strong [overflow-wrap:break-word] sm:truncate"
        >
          <span className="sr-only">
            {d.kind === "email" ? "Email " : "Webhook "}
          </span>
          {breakPoints(name).map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <wbr /> : null}
              {part}
            </React.Fragment>
          ))}
          {d.label ? (
            <span className="hidden font-normal text-fg-muted lg:inline">
              {" · "}
              {d.target}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <KindChips d={d} kinds={kinds} />
          <Status d={d} canEdit={canEdit} />
        </div>
        <div role="status">
          {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
        </div>
        {showError && d.lastError !== testFail?.detail ? (
          <p className="text-xs text-fg-muted" dir="auto">
            {d.lastError}. {checkHint(d, canEdit)}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {/* The switch ends the row: the menu sits before it. Under the text when the row is too narrow for three columns (a phone at 200 % text). */}
      {canEdit ? (
        <div className="col-start-2 flex shrink-0 items-center gap-2 justify-self-end @[16rem]:col-start-auto">
          <ActionMenu label={`Actions for ${name}`} items={items} />
          <Switch
            aria-label={`Send alerts to ${name}`}
            checked={d.enabled}
            readOnly={busy}
            onCheckedChange={(next) => {
              if (!next && !ensureFresh()) return;
              void run(async () => {
                await mutate("updateAlertDestination", scope, d.id, {
                  enabled: next,
                  expectedVersion: d.version,
                });
              });
            }}
          />
        </div>
      ) : (
        <span className="hidden @[16rem]:block" />
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        intent="caution"
        title={`Remove ${name}?`}
        description={
          d.kind === "webhook"
            ? "It stops getting alerts and its signing secret is deleted."
            : "It stops getting alerts."
        }
        confirmLabel="Remove"
        describeError={(e) => ({ title: failureText(e) })}
        onConfirm={async () => {
          try {
            await mutate("deleteAlertDestination", scope, d.id);
          } catch (e) {
            // The page's sign-in callout takes over: close this dialog rather than refuse here.
            if (isStepUp(e)) return onStepUp();
            throw e;
          }
          onRemoved();
          toast.success("Destination removed");
        }}
      />
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        intent="caution"
        title={`Issue a new signing secret for ${name}?`}
        description="The old secret stops verifying at once. Update your receiver with the new one."
        confirmLabel="Issue new secret"
        describeError={(e) => ({ title: failureText(e) })}
        onConfirm={async () => {
          try {
            const res = await mutate("updateAlertDestination", scope, d.id, {
              rotateSecret: true,
              expectedVersion: d.version,
            });
            if (res.secret) onSecret(res.secret);
          } catch (e) {
            if (isStepUp(e)) return onStepUp();
            throw e;
          }
        }}
      />
    </div>
  );
}
