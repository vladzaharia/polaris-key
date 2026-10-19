/**
 * Alert destinations (ST-27): where this scope's alerts go. Platform → Settings → Email and
 * alerts holds the platform's; a product's Settings holds its override, which replaces the
 * platform's for the alert kinds it takes (the routing summary says which go where).
 *
 * A destination is an email address or an https webhook. A webhook's URL and signing secret are
 * sealed on the Worker: the list shows `https://host/…`, the secret appears once, in the dialog
 * that follows an add or a new secret, and nothing here can read either again.
 *
 * Step-up. Adding, changing, turning off, removing and a new secret need a sign-in from the last
 * five minutes (only turning a destination ON does not). The page shows ONE callout, and only
 * once an action has run into it; a row never shows its own.
 *
 * Rows are one line from `sm` up (glyph, name, kinds, status, switch, ⋯ menu). Below it the name
 * takes the line with the switch and menu at its end, and the kinds and status wrap below.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Mail, Webhook } from "lucide-react";
import {
  ApiError,
  api,
  type AlertDestination,
  type AlertDestinationsView,
  type AlertKindId,
  type AlertScope,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { fromSeconds } from "../../../lib/format.js";
import { ActionMenu, type ActionMenuEntry } from "../../../ui/ActionMenu.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useWriteGate } from "../../access/useCan.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import { StepUpCallout, useStepUp } from "../core/pages/UserRelink.js";
import { DestinationDialog } from "./DestinationDialog.js";
import { failureText, isStepUp, nameOf, type KindInfo } from "./alertShared.js";

// ── The section ──────────────────────────────────────────────────────────────────────────────

export function AlertDestinations({
  scope,
  returnHash,
}: {
  scope: AlertScope;
  /** Where the sign-in again link returns to. */
  returnHash: string;
}): React.ReactElement {
  const slug = scope.kind === "product" ? scope.slug : null;
  const write = useWriteGate(slug ? "settings" : "platform", slug);
  const query = useQuery({
    queryKey: qk.alertDestinations(scope),
    queryFn: () => api.alertDestinations(scope),
  });
  const { fresh, markStale } = useStepUp(true);
  const [needSignIn, setNeedSignIn] = React.useState(false);
  const [editing, setEditing] = React.useState<AlertDestination | "new" | null>(
    null,
  );
  const [secret, setSecret] = React.useState<{
    value: string;
    name: string;
    returnId: string;
  } | null>(null);
  const addRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const focusNext = React.useRef<{ id: string | null } | null>(null);

  /** True when the sign-in is fresh; otherwise raises the page's one callout. */
  const ensureFresh = (): boolean => {
    if (fresh) return true;
    setNeedSignIn(true);
    return false;
  };
  const onStepUp = (): void => {
    markStale();
    setNeedSignIn(true);
  };

  const destinations = query.data?.destinations;
  React.useEffect(() => {
    const want = focusNext.current;
    if (!want || !destinations) return;
    focusNext.current = null;
    const t = window.setTimeout(() => {
      const row = want.id
        ? listRef.current?.querySelector<HTMLElement>(
            `[data-dest="${want.id}"]`,
          )
        : null;
      (row ?? addRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [destinations]);

  if (query.isPending)
    return (
      <div
        role="status"
        aria-label="Loading alert destinations"
        className="space-y-2 px-5 py-4"
      >
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  if (query.isError)
    return (
      <div className="px-5 py-3">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  const view = query.data;
  const list = view.destinations;
  const full = list.length >= view.max;

  return (
    <div className="space-y-3 px-5 py-4" data-testid="alert-destinations">
      {needSignIn && !fresh ? (
        <StepUpCallout hash={returnHash}>
          Changing where alerts go needs a sign-in from the last five minutes.
          You come back to this page afterwards.
        </StepUpCallout>
      ) : null}
      {scope.kind === "product" ? (
        <RoutingSummary view={view} />
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-muted">
          None set: alerts reach the audit trail only.
        </p>
      ) : null}
      {!view.emailAvailable ? (
        <p className="text-sm text-fg-muted">
          Email is not set up on this deployment, so email destinations will not
          send. Webhooks still do.
        </p>
      ) : null}
      {list.length > 0 ? (
        <ul
          ref={listRef}
          aria-label="Alert destinations"
          className="divide-y divide-border rounded-lg border border-border"
        >
          {list.map((d, i) => (
            <li
              key={d.id}
              data-dest={d.id}
              tabIndex={-1}
              className="outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Row
                d={d}
                scope={scope}
                canEdit={write.allowed}
                kinds={view.kinds}
                ensureFresh={ensureFresh}
                onStepUp={onStepUp}
                onEdit={() => setEditing(d)}
                onSecret={(value) =>
                  setSecret({ value, name: nameOf(d), returnId: d.id })
                }
                onRemoved={() => {
                  focusNext.current = {
                    id: list[i + 1]?.id ?? list[i - 1]?.id ?? null,
                  };
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {write.allowed ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={addRef}
            variant="secondary"
            size="sm"
            disabled={full}
            aria-describedby={full ? "alert-destinations-full" : undefined}
            onClick={() => setEditing("new")}
          >
            Add destination
          </Button>
          {full ? (
            <p id="alert-destinations-full" className="text-sm text-fg-muted">
              {view.max} of {view.max} · Remove one to add another.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <Lock aria-hidden className="size-3.5" />
          {write.disabledReason ?? "You can't edit this."}
        </p>
      )}
      {editing ? (
        <DestinationDialog
          scope={scope}
          kinds={view.kinds}
          existing={editing === "new" ? null : editing}
          fresh={fresh}
          returnHash={returnHash}
          onStepUp={onStepUp}
          onClose={() => setEditing(null)}
          onSecret={(value, d) =>
            setSecret({ value, name: nameOf(d), returnId: d.id })
          }
          onSaved={(id) => {
            focusNext.current = { id };
          }}
        />
      ) : null}
      {secret ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              focusNext.current = { id: secret.returnId };
              setSecret(null);
            }
          }}
          title={`Signing secret for ${secret.name}`}
          description="Your receiver verifies each alert with it."
          label="Signing secret"
          value={secret.value}
          hint="Shown once. Polaris Key keeps it sealed and cannot show it again. Issue a new one to replace it; the old one stops working at once."
          details={
            <p className="text-sm text-fg-muted">
              Verify the <code>webhook-signature</code> header with any{" "}
              <a
                className="text-accent-fg underline underline-offset-2"
                href="https://www.standardwebhooks.com/"
                target="_blank"
                rel="noreferrer"
              >
                Standard Webhooks
              </a>{" "}
              library, and reject a timestamp older than five minutes.
            </p>
          }
          onDone={() => {
            focusNext.current = { id: secret.returnId };
            setSecret(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Where each kind goes (product scope) ─────────────────────────────────────────────────────

function RoutingSummary({
  view,
}: {
  view: AlertDestinationsView;
}): React.ReactElement {
  const own = (k: KindInfo): boolean =>
    view.destinations.some((d) => d.enabled && d.alerts.includes(k.id));
  const viaPlatform = (k: KindInfo): number =>
    view.inheritedByKind?.[k.id] ?? 0;
  const label = (k: KindInfo): string =>
    k.sent ? k.label : `${k.label} (not sent yet)`;
  const here = view.kinds.filter(own);
  const rest = view.kinds.filter((k) => !own(k));
  const platform = rest.filter((k) => viaPlatform(k) > 0);
  const audit = rest.filter((k) => viaPlatform(k) === 0);
  const platformCount = Math.max(0, ...platform.map(viaPlatform));
  const parts: React.ReactNode[] = [];
  if (here.length > 0)
    parts.push(`${here.map(label).join(", ")} → this product`);
  if (platform.length > 0)
    parts.push(
      <span key="p">
        {platform.map(label).join(", ")} →{" "}
        <a
          className="text-accent-fg underline underline-offset-2"
          href={r.platformSettings()}
        >
          platform ({platformCount})
        </a>
      </span>,
    );
  if (audit.length > 0)
    parts.push(
      here.length === 0 && platform.length === 0
        ? "All alerts → the audit trail only"
        : `${audit.map(label).join(", ")} → the audit trail only`,
    );
  return (
    <p className="text-sm text-fg-muted" data-testid="alert-routing">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 ? " · " : null}
          {p}
        </React.Fragment>
      ))}
    </p>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────────────────────

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

function Status({
  d,
  canEdit,
}: {
  d: AlertDestination;
  canEdit: boolean;
}): React.ReactElement {
  // One indicator for off: the switch. A view-only member has no switch to read, so the pill.
  if (!d.enabled)
    return canEdit ? <></> : <StatusPill tone="neutral">Off</StatusPill>;
  if (d.lastStatus === null)
    return <span className="text-xs text-fg-muted">Not used yet</span>;
  const when = d.lastAt ? (
    <Timestamp at={fromSeconds(d.lastAt)} format="relative" />
  ) : null;
  if (d.lastStatus === "ok")
    return <span className="text-xs text-fg-muted">Delivered {when}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusPill tone="danger">
        {d.lastStatus === "refused" ? "Refused" : "Failing"}
        {d.failures > 1 ? ` · ${d.failures} in a row` : ""}
      </StatusPill>
      <span className="text-xs text-fg-muted">Failed {when}</span>
    </span>
  );
}

function Row({
  d,
  scope,
  canEdit,
  kinds,
  ensureFresh,
  onStepUp,
  onEdit,
  onSecret,
  onRemoved,
}: {
  d: AlertDestination;
  scope: AlertScope;
  canEdit: boolean;
  kinds: readonly KindInfo[];
  ensureFresh: () => boolean;
  onStepUp: () => void;
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onRemoved: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [retryAt, setRetryAt] = React.useState(0);
  const [, setTick] = React.useState(0);
  const name = nameOf(d);
  const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));

  React.useEffect(() => {
    if (retryAt <= Date.now()) return;
    const t = window.setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= retryAt) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [retryAt]);

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
      try {
        const res = await mutate("testAlertDestination", scope, d.id);
        // A failed test shows its reason on the row (the list reloads with it).
        if (res.outcome === "ok") toast.success("Test alert delivered");
      } catch (e) {
        if (e instanceof ApiError && e.status === 429 && e.retryAfter) {
          setRetryAt(Date.now() + e.retryAfter * 1000);
          return;
        }
        throw e;
      }
    });

  const unconfirmed = d.kind === "email" && scope.kind === "product";
  const items: ActionMenuEntry[] = [
    {
      label: "Send test",
      onSelect: () => void sendTest(),
      ...(left > 0 ? { disabledReason: `Try again in ${left} s` } : {}),
      ...(unconfirmed
        ? { disabledReason: "Not until the address is confirmed" }
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

  const dim = !d.enabled && canEdit ? "opacity-60" : undefined;
  const Glyph = d.kind === "email" ? Mail : Webhook;
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Glyph
          aria-hidden
          className={cn("order-1 size-4 shrink-0 text-fg-muted", dim)}
        />
        <div
          className={cn(
            "order-2 min-w-[5rem] flex-1 basis-0 sm:min-w-[9rem]",
            dim,
          )}
        >
          <p
            dir="auto"
            title={name}
            className="text-sm font-medium text-fg-strong [overflow-wrap:anywhere]"
          >
            <span className="sr-only">
              {d.kind === "email" ? "Email " : "Webhook "}
            </span>
            {name}
            {d.label ? (
              <span className="hidden font-normal text-fg-muted lg:inline">
                {" · "}
                {d.target}
              </span>
            ) : null}
          </p>
        </div>
        <div className={cn("order-5 basis-full sm:order-3 sm:basis-auto", dim)}>
          <KindChips d={d} kinds={kinds} />
        </div>
        <div className={cn("order-6 basis-full sm:order-4 sm:basis-auto", dim)}>
          <Status d={d} canEdit={canEdit} />
        </div>
        {canEdit ? (
          <>
            <div className="order-3 sm:order-5">
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
            <div className="order-4 sm:order-6">
              <ActionMenu label={`Actions for ${name}`} items={items} />
            </div>
          </>
        ) : null}
      </div>
      {d.enabled && d.lastError && d.lastStatus !== "ok" ? (
        <p className="mt-1 text-xs text-fg-muted sm:pl-7" dir="auto">
          {d.lastError}.{" "}
          {d.kind === "webhook"
            ? "Check the URL and that your receiver is up, then send a test."
            : "Check the address, then send a test."}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-1 text-sm font-medium text-danger sm:pl-7"
        >
          {error}
        </p>
      ) : null}
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
            if (isStepUp(e)) onStepUp();
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
            if (isStepUp(e)) onStepUp();
            throw e;
          }
        }}
      />
    </div>
  );
}
