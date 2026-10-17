/**
 * Alert destinations (ST-27): where this scope's alerts go. Platform → Settings → Email and
 * alerts holds the platform's; a product's Settings holds its override, which replaces the
 * platform's for the alert kinds it takes.
 *
 * A destination is an email address or an https webhook. A webhook's URL and signing secret are
 * sealed on the Worker: the list shows `https://host/…`, the secret appears once, in the dialog
 * that follows an add or a new secret, and nothing here can read either again. Adding or
 * retargeting needs a sign-in from the last five minutes (the step-up); turning one off,
 * removing it and a test send do not.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import {
  ApiError,
  api,
  type AlertDestination,
  type AlertKindId,
  type AlertScope,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useWriteGate } from "../../access/useCan.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { StepUpCallout, useStepUp } from "../core/pages/UserRelink.js";

const LABEL_MAX = 64;

/** What a refusal's `reason` says, in the operator's terms. */
const REASON_COPY: Record<string, string> = {
  url_refused: "That URL cannot be used. It must be a public https address.",
  target_invalid: "Enter a valid email address.",
  alerts_required: "Pick at least one alert.",
  too_many: "That is the most destinations. Remove one first.",
  too_soon: "Wait a few seconds before sending another test.",
  stale: "Changed elsewhere. Reload and try again.",
};

function failureText(err: unknown): string {
  const reason = err instanceof ApiError ? err.reason : undefined;
  if (reason && REASON_COPY[reason]) return REASON_COPY[reason]!;
  return errorCopy(err).title;
}

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
  const [adding, setAdding] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);

  if (query.isPending)
    return <PageSkeleton template="form" label="alert destinations" />;
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
  const { destinations, kinds, max, emailAvailable, inherited } = query.data;
  const kindLabel = (id: AlertKindId): string =>
    kinds.find((k) => k.id === id)?.label ?? id;

  return (
    <div className="space-y-3 px-5 py-4" data-testid="alert-destinations">
      {scope.kind === "product" ? (
        <p className="text-sm text-fg-muted">
          {destinations.length === 0
            ? inherited
              ? `None set: the platform's ${inherited === 1 ? "destination applies" : `${inherited} destinations apply`}.`
              : "None set, and the platform has none: alerts reach the audit trail only."
            : "These replace the platform's for the alerts they take."}
        </p>
      ) : destinations.length === 0 ? (
        <p className="text-sm text-fg-muted">
          None set: alerts reach the audit trail only.
        </p>
      ) : null}
      {!emailAvailable ? (
        <Callout tone="warning" title="Email is not set up on this deployment">
          Email destinations will not send. Webhooks still do.
        </Callout>
      ) : null}
      {destinations.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {destinations.map((d) => (
            <li key={d.id}>
              <Row
                d={d}
                scope={scope}
                canEdit={write.allowed}
                kindLabel={kindLabel}
                returnHash={returnHash}
                onSecret={setSecret}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {write.allowed ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={destinations.length >= max}
          onClick={() => setAdding(true)}
        >
          Add destination
        </Button>
      ) : (
        <p className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <Lock aria-hidden className="size-3.5" />
          {write.disabledReason ?? "You can't edit this."}
        </p>
      )}
      {adding ? (
        <AddDialog
          scope={scope}
          kinds={kinds}
          returnHash={returnHash}
          onClose={() => setAdding(false)}
          onSecret={setSecret}
        />
      ) : null}
      {secret !== null ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(o) => {
            if (!o) setSecret(null);
          }}
          title="Signing secret"
          description="Your receiver verifies each alert with it."
          label="Signing secret"
          value={secret}
          hint="Shown once. Polaris Key keeps it sealed and cannot show it again. Issue a new one to replace it."
          onDone={() => setSecret(null)}
        />
      ) : null}
    </div>
  );
}

function statusPill(d: AlertDestination): React.ReactElement {
  if (!d.enabled) return <StatusPill tone="neutral">Off</StatusPill>;
  if (d.lastStatus === null)
    return <StatusPill tone="neutral">Not used yet</StatusPill>;
  if (d.lastStatus === "ok")
    return <StatusPill tone="success">Delivered</StatusPill>;
  return (
    <StatusPill tone="danger">
      {d.lastStatus === "refused" ? "Refused" : "Failing"}
      {d.failures > 1 ? ` · ${d.failures} in a row` : ""}
    </StatusPill>
  );
}

function Row({
  d,
  scope,
  canEdit,
  kindLabel,
  returnHash,
  onSecret,
}: {
  d: AlertDestination;
  scope: AlertScope;
  canEdit: boolean;
  kindLabel: (id: AlertKindId) => string;
  returnHash: string;
  onSecret: (secret: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const { fresh, markStale } = useStepUp(true);

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") markStale();
      else setError(failureText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg-strong">
            {d.label ?? d.target}
          </p>
          <p className="truncate text-xs text-fg-muted">
            {d.kind === "email" ? "Email" : "Webhook"}
            {d.label ? ` · ${d.target}` : ""} ·{" "}
            {d.alerts.map(kindLabel).join(", ")}
          </p>
        </div>
        {statusPill(d)}
        {d.lastAt ? (
          <span className="text-xs text-fg-muted">
            <Timestamp at={fromSeconds(d.lastAt)} format="relative" />
          </span>
        ) : null}
        {canEdit ? (
          <Switch
            aria-label={`${d.label ?? d.target} on`}
            checked={d.enabled}
            readOnly={busy !== null}
            onCheckedChange={(next) =>
              void run("toggle", async () => {
                await mutate("updateAlertDestination", scope, d.id, {
                  enabled: next,
                  expectedVersion: d.version,
                });
              })
            }
          />
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "test"}
            disabled={busy !== null}
            onClick={() =>
              void run("test", async () => {
                const r = await mutate("testAlertDestination", scope, d.id);
                if (r.outcome === "ok") toast.success("Test alert delivered");
                else
                  setError(
                    r.outcome === "refused"
                      ? "The endpoint was refused: it redirected, or its address is not allowed."
                      : "The test did not get through.",
                  );
              })
            }
          >
            Send test
          </Button>
          {d.kind === "webhook" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null || !fresh}
              onClick={() => setRotating(true)}
            >
              New secret
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setRemoving(true)}
          >
            Remove
          </Button>
        </div>
      ) : null}
      {canEdit && !fresh && d.kind === "webhook" ? (
        <StepUpCallout hash={returnHash}>
          A new secret needs a sign-in from the last five minutes. You come back
          to this page afterwards.
        </StepUpCallout>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        intent="caution"
        title="Remove this destination?"
        description={`${d.target} stops getting alerts. Its signing secret is deleted.`}
        confirmLabel="Remove"
        describeError={(e) => ({ title: failureText(e) })}
        onConfirm={async () => {
          await mutate("deleteAlertDestination", scope, d.id);
          toast.success("Destination removed");
        }}
      />
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        intent="caution"
        title="Issue a new signing secret?"
        description="The old secret stops verifying at once. Update your receiver with the new one."
        confirmLabel="Issue new secret"
        describeError={(e) => ({ title: failureText(e) })}
        onConfirm={async () => {
          try {
            const r = await mutate("updateAlertDestination", scope, d.id, {
              rotateSecret: true,
              expectedVersion: d.version,
            });
            if (r.secret) onSecret(r.secret);
          } catch (e) {
            if (e instanceof ApiError && e.code === "step_up_required")
              markStale();
            throw e;
          }
        }}
      />
    </div>
  );
}

function AddDialog({
  scope,
  kinds,
  returnHash,
  onClose,
  onSecret,
}: {
  scope: AlertScope;
  kinds: Array<{ id: AlertKindId; label: string }>;
  returnHash: string;
  onClose: () => void;
  onSecret: (secret: string) => void;
}): React.ReactElement {
  const { fresh, markStale } = useStepUp(true);
  const [kind, setKind] = React.useState<"email" | "webhook">("email");
  const [target, setTarget] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [alerts, setAlerts] = React.useState<AlertKindId[]>(
    kinds.filter((k) => k.id !== "notifications_failing").map((k) => k.id),
  );
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const invalid = target.trim() === "" || alerts.length === 0;
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || invalid || !fresh) return;
    setSaving(true);
    setFailure(null);
    try {
      const r = await mutate("createAlertDestination", scope, {
        kind,
        target: target.trim(),
        alerts,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      toast.success("Destination added");
      if (r.secret) onSecret(r.secret);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "step_up_required")
        markStale();
      else setFailure(failureText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!saving && !o) onClose();
      }}
      dismissible={!saving}
      title="Add alert destination"
      description="Where these alerts go. A webhook gets a signed JSON body."
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          {fresh ? null : (
            <StepUpCallout hash={returnHash}>
              Adding a destination needs a sign-in from the last five minutes.
              You come back to this page afterwards.
            </StepUpCallout>
          )}
          <FormField
            name="kind"
            label="Type"
            value={kind}
            onChange={(v: string) => {
              setKind(v === "webhook" ? "webhook" : "email");
              setTarget("");
              setFailure(null);
            }}
          >
            {(f) => (
              <Select
                {...f}
                options={[
                  { value: "email", label: "Email" },
                  { value: "webhook", label: "Webhook" },
                ]}
              />
            )}
          </FormField>
          <FormField
            name="target"
            label={kind === "email" ? "Email address" : "Webhook URL"}
            required
            help={
              kind === "webhook"
                ? "A public https address. It is sealed once saved and never shown again."
                : undefined
            }
            value={target}
            onChange={(v: string) => {
              setTarget(v);
              setFailure(null);
            }}
          >
            {(f) => (
              <Input
                {...f}
                type={kind === "email" ? "email" : "url"}
                autoComplete="off"
                placeholder={
                  kind === "email"
                    ? "ops@example.com"
                    : "https://hooks.example.com/…"
                }
              />
            )}
          </FormField>
          <FormField
            name="label"
            label="Label"
            value={label}
            onChange={(v: string) => setLabel(v)}
          >
            {(f) => <Input {...f} maxLength={LABEL_MAX} autoComplete="off" />}
          </FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-fg-strong">
              Alerts
            </legend>
            {kinds.map((k) => (
              <Checkbox
                key={k.id}
                label={k.label}
                checked={alerts.includes(k.id)}
                onCheckedChange={(on) =>
                  setAlerts(
                    on ? [...alerts, k.id] : alerts.filter((x) => x !== k.id),
                  )
                }
              />
            ))}
          </fieldset>
          {failure ? <Callout tone="danger" title={failure} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={invalid || !fresh}>
            Add destination
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
