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
 * five minutes (only turning a destination ON does not). The page shows ONE callout, below the
 * list so the row that was tapped does not move, and only once an action has run into it.
 *
 * The test throttle is per scope, so its countdown lives here and every row's Send test shares it.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { api, type AlertDestination, type AlertScope } from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { useWriteGate } from "../../access/useCan.js";
import { qk } from "../../data/queries.js";
import { useStepUp } from "../core/pages/UserRelink.js";
import { DestinationDialog } from "./DestinationDialog.js";
import { DestinationRow } from "./DestinationRow.js";
import { RoutingSummary } from "./RoutingSummary.js";
import { SignInCallout } from "./SignInCallout.js";
import { nameOf, secondsUntil } from "./alertShared.js";

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
  const [editingId, setEditingId] = React.useState<string | "new" | null>(null);
  const [secret, setSecret] = React.useState<{
    value: string;
    name: string;
    returnId: string;
  } | null>(null);
  const [retryAt, setRetryAt] = React.useState(0);
  const [, setTick] = React.useState(0);
  const addRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

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

  // One clock for every row's countdown while the throttle runs.
  React.useEffect(() => {
    if (secondsUntil(retryAt) === 0) return;
    const t = window.setInterval(() => {
      setTick((n) => n + 1);
      if (secondsUntil(retryAt) === 0) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [retryAt]);

  /** Focus a row (or Add) once it is on screen; retries while the list reloads. */
  const focusRow = (id: string | null): void => {
    let tries = 0;
    const attempt = (): void => {
      const row = id
        ? listRef.current?.querySelector<HTMLElement>(`[data-dest="${id}"]`)
        : null;
      const target = row ?? (tries >= 10 ? addRef.current : null);
      if (target) {
        target.focus();
        if (document.activeElement === target) return;
      }
      if (++tries < 30) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  };

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
  const editing: AlertDestination | null =
    editingId && editingId !== "new"
      ? (list.find((d) => d.id === editingId) ?? null)
      : null;

  return (
    <div className="space-y-3 px-5 py-4" data-testid="alert-destinations">
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
              className="@container outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <DestinationRow
                d={d}
                scope={scope}
                canEdit={write.allowed}
                kinds={view.kinds}
                retryAt={retryAt}
                ensureFresh={ensureFresh}
                onStepUp={onStepUp}
                onThrottled={(s) => setRetryAt(Date.now() + s * 1000)}
                onEdit={() => setEditingId(d.id)}
                onSecret={(value) =>
                  setSecret({ value, name: nameOf(d), returnId: d.id })
                }
                onRemoved={() =>
                  focusRow(list[i + 1]?.id ?? list[i - 1]?.id ?? null)
                }
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
            onClick={() => {
              if (ensureFresh()) setEditingId("new");
            }}
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
      {needSignIn && !fresh ? (
        <SignInCallout hash={returnHash}>
          Changing where alerts go needs a sign-in from the last five minutes.
          You come back to this page afterwards.
        </SignInCallout>
      ) : null}
      {editingId && (editingId === "new" || editing) ? (
        <DestinationDialog
          scope={scope}
          kinds={view.kinds}
          existing={editingId === "new" ? null : editing}
          currentVersion={editing?.version}
          fresh={fresh}
          returnHash={returnHash}
          onStepUp={onStepUp}
          onClose={() => setEditingId(null)}
          onSecret={(value, d) =>
            setSecret({ value, name: nameOf(d), returnId: d.id })
          }
          onSaved={focusRow}
        />
      ) : null}
      {secret ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(o) => {
            if (!o) setSecret(null);
          }}
          onCloseAutoFocus={(e) => {
            // Back to the row it belongs to, not the opener (which may be gone) or <body>.
            e.preventDefault();
            focusRow(secret.returnId);
          }}
          title={`Signing secret for ${secret.name}`}
          description="Add it to your receiver."
          label="Signing secret"
          value={secret.value}
          hint="Polaris Key keeps it sealed and can't show it again. Issue a new one to replace it; the old one stops working at once."
          details={
            <p className="text-sm text-fg-muted">
              Your receiver verifies each alert&apos;s{" "}
              <code>webhook-signature</code> header with it, using any{" "}
              <a
                className="text-accent-fg underline underline-offset-2"
                href="https://www.standardwebhooks.com/"
                target="_blank"
                rel="noreferrer"
              >
                Standard Webhooks
              </a>{" "}
              library. Reject a timestamp older than five minutes.
            </p>
          }
          onDone={() => setSecret(null)}
        />
      ) : null}
    </div>
  );
}
